import fs from "node:fs/promises"
import path from "node:path"
import type { FounderOSModeState } from "@agents-company/shared/founder-os"
import { Context, Effect, Layer } from "effect"
import { and, eq, isNotNull } from "drizzle-orm"
import z from "zod"
import * as Database from "@/storage/db"
import type { TxOrDb } from "@/storage/db"
import { Global } from "@/global"
import { Git } from "@/git"
import { Project } from "@/project"
import { ProjectID } from "@/project/schema"
import { Provider } from "@/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import {
  CompanyCommonsChunkTable,
  CompanyCommonsSourceTable,
} from "@/company-commons/company-commons.sql"
import {
  CompanyBeliefInterpretationTable,
  CompanyBeliefTable,
  CompanyExperimentOutcomeTable,
  CompanyExperimentTable,
  CompanyLearningPatchTable,
  CompanyPatchBenchmarkTable,
  CompanyPatchCanaryTable,
  CompanyPatchTargetVersionTable,
} from "@/company-learning/company-learning.sql"
import {
  CompanyInterpretationEvidenceTable,
  CompanyInterpretationTable,
  CompanyReadingAssignmentTable,
} from "@/company-reading/company-reading.sql"
import { Flag } from "@/flag/flag"
import { FounderOSMode } from "@/founder-os"
import {
  DecisionCurrentProjectionTable,
  DecisionRecordTable,
  FounderGovernanceEventTable,
} from "@/founder-os/decision-ledger.sql"
import {
  CompanyArtifactTable,
  CompanyOutcomeSignalCurrentTable,
  CompanyOutcomeSignalTable,
  CompanyProjectTable,
  CompanyWorkReceiptTable,
} from "@/company-project/company-project.sql"
import { ensureCompanyChannels } from "@/conversation/conversation.sql"
import { ApprovalPolicyTable, CompanySetupGoalTable, CompanyTable, RepositoryBindingTable } from "./company.sql"
import * as CompanySetupInstance from "./setup-instance"
import {
  ApprovalPolicyUpdateInput,
  BeliefLoopActivationInput,
  type BeliefLoopActivationInput as BeliefLoopActivationInputType,
  BootstrapInput,
  type BootstrapInput as BootstrapInputType,
  CompanyProviderBindingInput,
  type CompanyProviderBindingInput as CompanyProviderBindingInputType,
  type CompanyState,
  CompanyAlreadyInitialized,
  CompanyCorruptState,
  CompanyID,
  CompanyModelNotAvailable,
  CompanyProviderNotConnected,
  CompanyProviderUnsupported,
  CompanyReadyState,
  CompanyRepositoryNotGit,
  CompanySetupGoalInput,
  FounderOSModeUpdateInput,
  type RepositoryCandidate,
} from "./schema"

const COMPANY_ID = CompanyID.parse("cmp_local")
const REPOSITORY_BINDING_ID = "rbd_primary"
const UNCONFIGURED_PROVIDER = ProviderID.zod.parse("unconfigured")
const UNCONFIGURED_MODEL = ModelID.zod.parse("unconfigured")
const unsupportedProviders = new Set(["control-plane"])

export const BOARD = [
  { id: "board-ceo", role: "ceo", name: "CEO", reports_to: null, responsibilities: ["公司目标与最终取舍"] },
  { id: "board-cto", role: "cto", name: "CTO", reports_to: "board-ceo", responsibilities: ["技术方向与工程质量"] },
  {
    id: "board-product-lead",
    role: "product_lead",
    name: "Product Lead",
    reports_to: "board-ceo",
    responsibilities: ["用户价值与验收"],
  },
] as const

type Candidate = RepositoryCandidate & { project_id: ProjectID }
type ReadyRecord = { state: CompanyReadyState; row: typeof CompanyTable.$inferSelect }

function corrupt(): never {
  throw new CompanyCorruptState({})
}

function strings(input: unknown): input is string[] {
  return Array.isArray(input) && input.every((item) => typeof item === "string")
}

function responsibilities(input: string | null) {
  if (!input) return
  try {
    const parsed: unknown = JSON.parse(input)
    if (strings(parsed)) return parsed
  } catch {}
}

function sameValues(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

export function boardMessagesEnabled() {
  return !Flag.AGENTCOMPANY_DISABLE_BOARD_MESSAGES
}

function createDefaultCompany(tx: Database.Transaction) {
  const now = Date.now()
  tx.insert(CompanyTable)
    .values([
      {
        id: COMPANY_ID,
        name: "Agent Company",
        data_version: 1,
        default_provider_id: UNCONFIGURED_PROVIDER,
        default_model_id: UNCONFIGURED_MODEL,
        bootstrap_request_id: "default-company",
        bootstrap_input_path: Global.Path.data,
        time_created: now,
        time_updated: now,
      },
    ])
    .run()
  tx.insert(ApprovalPolicyTable)
    .values({ company_id: COMPANY_ID, preset: "balanced", time_created: now, time_updated: now })
    .run()
  ensureCompanyChannels({ companyID: COMPANY_ID, boardAgentIDs: BOARD.map((member) => member.id), now })
  tx.insert(CompanyAgentTable)
    .values(
      BOARD.map((member) => ({
        id: member.id,
        company_id: COMPANY_ID,
        role_key: member.role,
        lifecycle: "employee",
        name: member.name,
        org_layer: "board",
        reports_to: member.reports_to,
        responsibilities: JSON.stringify(member.responsibilities),
        time_created: now,
        time_updated: now,
      })),
    )
    .run()
}

function ensureDefaultCompany(tx: Database.Transaction) {
  if (tx.select().from(CompanyTable).all().length > 0) return

  // A failed or interrupted legacy bootstrap can leave orphan CompanyAgent,
  // policy, binding, or setup-goal rows behind. There is no valid Company to
  // preserve in this branch, so repair the singleton before creating the
  // default empty workspace.
  tx.delete(CompanySetupGoalTable).run()
  tx.delete(RepositoryBindingTable).run()
  tx.delete(ApprovalPolicyTable).run()
  tx.delete(CompanyAgentTable).run()
  createDefaultCompany(tx)
}

function current(db: TxOrDb): CompanyState {
  const companies = db.select().from(CompanyTable).all()
  if (companies.length === 0) return corrupt()
  if (companies.length !== 1) return corrupt()

  const company = companies[0]
  if (!company || company.id !== COMPANY_ID || company.data_version !== 1) return corrupt()

  const policies = db.select().from(ApprovalPolicyTable).where(eq(ApprovalPolicyTable.company_id, company.id)).all()
  const bindings = db
    .select()
    .from(RepositoryBindingTable)
    .where(eq(RepositoryBindingTable.company_id, company.id))
    .all()
  const members = db.select().from(CompanyAgentTable).where(eq(CompanyAgentTable.company_id, company.id)).all()
  const boardMembers = members.filter((member) => member.org_layer === "board")
  if (policies.length !== 1 || bindings.length > 1 || boardMembers.length !== BOARD.length) return corrupt()

  const policy = policies[0]
  const binding = bindings[0]
  if (!policy || (binding && binding.id !== REPOSITORY_BINDING_ID) || policy.company_id !== company.id) return corrupt()
  const setupGoal = db.select().from(CompanySetupGoalTable).where(eq(CompanySetupGoalTable.company_id, company.id)).get()

  const board = BOARD.map((member) => {
    const row = boardMembers.find((item) => item.id === member.id)
    const values = row ? responsibilities(row.responsibilities) : undefined
    if (
      !row ||
      row.company_id !== company.id ||
      row.role_key !== member.role ||
      row.lifecycle !== "employee" ||
      row.name !== member.name ||
      row.org_layer !== "board" ||
      row.reports_to !== member.reports_to ||
      !values ||
      !sameValues(values, member.responsibilities)
    )
      return corrupt()
    return {
      id: member.id,
      role: member.role,
      name: member.name,
      lifecycle: "employee" as const,
      responsibilities: values,
    }
  })
  if (boardMembers.some((row) => !BOARD.some((member) => member.id === row.id))) return corrupt()

  const parsed = CompanyReadyState.safeParse({
    state: "ready",
    data_directory: Global.Path.data,
    company: {
      id: company.id,
      name: company.name,
      data_version: company.data_version,
      provider:
        company.default_provider_id === UNCONFIGURED_PROVIDER || company.default_model_id === UNCONFIGURED_MODEL
          ? null
          : { provider_id: company.default_provider_id, model_id: company.default_model_id },
      setup_goal: setupGoal
        ? { body: setupGoal.body, created_at: setupGoal.time_created, updated_at: setupGoal.time_updated }
        : null,
      approval_policy: { preset: policy.preset },
      repository: binding
        ? {
            project_id: binding.project_id,
            root_path: binding.root_path,
            default_branch: binding.default_branch,
            bootstrap_head_commit: binding.bootstrap_head_commit,
            dirty: binding.bootstrap_dirty,
          }
        : null,
      board,
      created_at: company.time_created,
      updated_at: company.time_updated,
    },
    start_suggestion: {
      kind: "bootstrap_complete",
      action: "open_board",
    },
    capabilities: { board_messages: boardMessagesEnabled() },
  })
  if (!parsed.success) return corrupt()
  return parsed.data
}

function readyRecord(db: TxOrDb): ReadyRecord | undefined {
  if (db.select().from(CompanyTable).all().length === 0) return
  const state = current(db)
  if (state.state !== "ready") return
  const row = db.select().from(CompanyTable).where(eq(CompanyTable.id, state.company.id)).get()
  if (!row) return corrupt()
  return { state, row }
}

function founderOSModes(db: TxOrDb) {
  const company = db.select().from(CompanyTable).all()
  if (company.length !== 1 || company[0]?.id !== COMPANY_ID) return corrupt()
  return FounderOSMode.resolve({
    founderTwinMode: company[0].founder_twin_mode,
    companyCommonsMode: company[0].company_commons_mode,
  })
}

const commonsModeOrder = ["off", "ingest-only", "reading", "belief-loop"] as const

function requireReadingActivationFacts(db: TxOrDb, companyId: string) {
  const source = db
    .select({ id: CompanyCommonsSourceTable.id })
    .from(CompanyCommonsSourceTable)
    .where(
      and(
        eq(CompanyCommonsSourceTable.company_id, companyId),
        eq(CompanyCommonsSourceTable.capability_status, "supported"),
        eq(CompanyCommonsSourceTable.ingestion_status, "ready"),
        isNotNull(CompanyCommonsSourceTable.content_hash),
        isNotNull(CompanyCommonsSourceTable.adapter_id),
        isNotNull(CompanyCommonsSourceTable.adapter_version),
      ),
    )
    .get()
  if (
    !source ||
    !db
      .select({ id: CompanyCommonsChunkTable.id })
      .from(CompanyCommonsChunkTable)
      .where(eq(CompanyCommonsChunkTable.source_id, source.id))
      .get()
  )
    throw new Error("Reading mode requires a current supported Commons source with indexed source spans")
}

function requireBeliefLoopFacts(db: TxOrDb, companyId: string) {
  const interpretation = db
    .select({
      id: CompanyInterpretationTable.id,
      assignmentStatus: CompanyReadingAssignmentTable.status,
      receiptId: CompanyInterpretationTable.work_receipt_id,
    })
    .from(CompanyInterpretationTable)
    .innerJoin(
      CompanyCommonsSourceTable,
      eq(CompanyCommonsSourceTable.id, CompanyInterpretationTable.source_id),
    )
    .innerJoin(
      CompanyReadingAssignmentTable,
      and(
        eq(CompanyReadingAssignmentTable.source_id, CompanyInterpretationTable.source_id),
        eq(CompanyReadingAssignmentTable.agent_id, CompanyInterpretationTable.reader_agent_id),
      ),
    )
    .where(
      and(
        eq(CompanyCommonsSourceTable.company_id, companyId),
        eq(CompanyCommonsSourceTable.ingestion_status, "ready"),
        eq(CompanyReadingAssignmentTable.status, "completed"),
        isNotNull(CompanyInterpretationTable.work_receipt_id),
      ),
    )
    .get()
  if (
    !interpretation ||
    !interpretation.receiptId ||
    !db
      .select({ id: CompanyInterpretationEvidenceTable.interpretation_id })
      .from(CompanyInterpretationEvidenceTable)
      .where(eq(CompanyInterpretationEvidenceTable.interpretation_id, interpretation.id))
      .get() ||
    !db
      .select({ id: CompanyWorkReceiptTable.id })
      .from(CompanyWorkReceiptTable)
      .where(eq(CompanyWorkReceiptTable.id, interpretation.receiptId))
      .get()
  )
    throw new Error("Belief Loop activation requires a completed K1 reading with receipt-backed source evidence")

  if (
    !db
      .select({ id: DecisionRecordTable.id })
      .from(DecisionRecordTable)
      .innerJoin(
        DecisionCurrentProjectionTable,
        eq(DecisionCurrentProjectionTable.decision_id, DecisionRecordTable.id),
      )
      .where(
        and(
          eq(DecisionRecordTable.company_id, companyId),
          eq(DecisionCurrentProjectionTable.current_status, "executed"),
        ),
      )
      .get()
  )
    throw new Error("Belief Loop activation requires a currently executed W2 DecisionRecord")

  const patch = db
    .select({
      id: CompanyLearningPatchTable.id,
      beliefId: CompanyExperimentTable.belief_id,
      decisionId: CompanyExperimentTable.decision_id,
      experimentId: CompanyExperimentTable.id,
      outcomeId: CompanyLearningPatchTable.source_outcome_id,
    })
    .from(CompanyLearningPatchTable)
    .innerJoin(
      CompanyExperimentTable,
      eq(CompanyExperimentTable.id, CompanyLearningPatchTable.source_experiment_id),
    )
    .innerJoin(CompanyBeliefTable, eq(CompanyBeliefTable.id, CompanyExperimentTable.belief_id))
    .where(
      and(
        eq(CompanyLearningPatchTable.company_id, companyId),
        eq(CompanyLearningPatchTable.status, "active"),
        eq(CompanyExperimentTable.status, "evaluated"),
        eq(CompanyBeliefTable.status, "adopted"),
      ),
    )
    .get()
  if (!patch) throw new Error("Belief Loop activation requires a currently active K2 learning chain")

  const outcome = db
    .select({ id: CompanyOutcomeSignalTable.id })
    .from(CompanyOutcomeSignalTable)
    .innerJoin(
      CompanyOutcomeSignalCurrentTable,
      eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, CompanyOutcomeSignalTable.id),
    )
    .innerJoin(CompanyProjectTable, eq(CompanyProjectTable.id, CompanyOutcomeSignalTable.project_id))
    .where(
      and(
        eq(CompanyOutcomeSignalTable.id, patch.outcomeId),
        eq(CompanyProjectTable.company_id, companyId),
        eq(CompanyOutcomeSignalCurrentTable.current_status, "validated"),
        isNotNull(CompanyOutcomeSignalCurrentTable.validated_at),
        isNotNull(CompanyOutcomeSignalTable.work_receipt_id),
      ),
    )
    .get()
  if (!outcome) throw new Error("Belief Loop activation requires a current receipt-backed E0 Outcome Signal")

  const positions = db
    .select({ position: CompanyBeliefInterpretationTable.position })
    .from(CompanyBeliefInterpretationTable)
    .where(eq(CompanyBeliefInterpretationTable.belief_id, patch.beliefId))
    .all()
  const benchmark = db
    .select()
    .from(CompanyPatchBenchmarkTable)
    .where(
      and(
        eq(CompanyPatchBenchmarkTable.patch_id, patch.id),
        eq(CompanyPatchBenchmarkTable.result, "passed"),
      ),
    )
    .get()
  const canary = db
    .select()
    .from(CompanyPatchCanaryTable)
    .where(
      and(
        eq(CompanyPatchCanaryTable.patch_id, patch.id),
        eq(CompanyPatchCanaryTable.status, "passed"),
        isNotNull(CompanyPatchCanaryTable.finished_at),
      ),
    )
    .get()
  if (
    !positions.some((item) => item.position === "supporting") ||
    !positions.some((item) => item.position === "counter") ||
    !db
      .select()
      .from(CompanyExperimentOutcomeTable)
      .where(
        and(
          eq(CompanyExperimentOutcomeTable.experiment_id, patch.experimentId),
          eq(CompanyExperimentOutcomeTable.outcome_signal_id, patch.outcomeId),
        ),
      )
      .get() ||
    !db
      .select()
      .from(DecisionCurrentProjectionTable)
      .where(
        and(
          eq(DecisionCurrentProjectionTable.decision_id, patch.decisionId),
          eq(DecisionCurrentProjectionTable.current_status, "executed"),
        ),
      )
      .get() ||
    !benchmark ||
    benchmark.real_sample_count < 1 ||
    !canary ||
    !db
      .select()
      .from(CompanyPatchTargetVersionTable)
      .where(
        and(
          eq(CompanyPatchTargetVersionTable.patch_id, patch.id),
          eq(CompanyPatchTargetVersionTable.status, "active"),
        ),
      )
      .get()
  )
    throw new Error("Belief Loop activation requires a complete current K2 benchmark, canary, outcome, and target chain")
}

function sameBusiness(record: ReadyRecord, input: BootstrapInputType) {
  const provider = record.state.company.provider
  if (!provider) return false
  return (
    record.state.company.name === input.company_name &&
    provider.provider_id === input.provider_id &&
    provider.model_id === input.model_id &&
    record.state.company.approval_policy.preset === input.approval_preset
  )
}

function existingResult(
  record: ReadyRecord,
  input: BootstrapInputType,
  inputPath: string,
  candidate?: Pick<RepositoryCandidate, "root_path">,
) {
  if (record.row.bootstrap_request_id === input.request_id) {
    if (sameBusiness(record, input) && record.row.bootstrap_input_path === inputPath) return record.state
    throw new CompanyAlreadyInitialized({})
  }
  if (!sameBusiness(record, input)) throw new CompanyAlreadyInitialized({})
  if (record.row.bootstrap_input_path === inputPath) return record.state
  if (candidate?.root_path === record.state.company.repository?.root_path) return record.state
  throw new CompanyAlreadyInitialized({})
}

function database<A>(fn: () => A) {
  return Effect.try({
    try: fn,
    catch: (error) => error,
  })
}

export interface Interface {
  readonly current: () => Effect.Effect<CompanyState, unknown>
  readonly founderOSModes: () => Effect.Effect<FounderOSModeState, unknown>
  readonly bindProvider: (input: CompanyProviderBindingInputType) => Effect.Effect<CompanyReadyState, unknown>
  readonly updateApprovalPolicy: (input: ApprovalPolicyUpdateInput) => Effect.Effect<CompanyReadyState, unknown>
  readonly updateFounderOSModes: (input: FounderOSModeUpdateInput) => Effect.Effect<FounderOSModeState, unknown>
  readonly activateBeliefLoop: (input: BeliefLoopActivationInputType) => Effect.Effect<FounderOSModeState, unknown>
  readonly inspectRepository: (path: string) => Effect.Effect<RepositoryCandidate, unknown, Git.Service | Project.Service>
  readonly ensureManagedRepository: () => Effect.Effect<CompanyReadyState, unknown, Git.Service | Project.Service>
  readonly bootstrap: (input: BootstrapInputType) => Effect.Effect<CompanyReadyState, unknown, Git.Service | Project.Service>
  readonly deferSetupGoal: (input: CompanySetupGoalInput) => Effect.Effect<CompanyReadyState, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/Company") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const inspectRepository = Effect.fn("Company.inspectRepository")(function* (input: string) {
      const git = yield* Git.Service
      const project = yield* Project.Service
      const root = yield* Effect.tryPromise({
        try: () => fs.realpath(input),
        catch: () => new CompanyRepositoryNotGit({ path: path.resolve(input) }),
      })
      const resolved = yield* project.fromDirectory(root)
      if (resolved.project.vcs !== "git" || resolved.project.id === ProjectID.global)
        return yield* Effect.fail(new CompanyRepositoryNotGit({ path: root }))

      const branch = yield* git.defaultBranch(resolved.project.worktree)
      const currentBranch = yield* git.branch(resolved.project.worktree)
      const hasHead = yield* git.hasHead(resolved.project.worktree)
      const head = hasHead
        ? (yield* git.run(["rev-parse", "HEAD"], { cwd: resolved.project.worktree })).text().trim()
        : ""
      return {
        project_id: resolved.project.id,
        root_path: resolved.project.worktree,
        default_branch: branch?.name ?? currentBranch ?? "main",
        bootstrap_head_commit: head || null,
        dirty: (yield* git.status(resolved.project.worktree)).length > 0,
      } satisfies Candidate
    })

    const validateProvider = Effect.fn("Company.validateProvider")(function* (input: CompanyProviderBindingInputType) {
      if (unsupportedProviders.has(input.provider_id))
        return yield* Effect.fail(new CompanyProviderUnsupported({ provider_id: input.provider_id }))
      yield* CompanySetupInstance.provide(
        Effect.gen(function* () {
          const providers = yield* Provider.Service
          const provider = (yield* providers.list())[input.provider_id]
          if (!provider) return yield* Effect.fail(new CompanyProviderNotConnected({ provider_id: input.provider_id }))
          if (!provider.models[input.model_id])
            return yield* Effect.fail(new CompanyModelNotAvailable({ provider_id: input.provider_id, model_id: input.model_id }))
          yield* providers.getModel(input.provider_id, input.model_id)
        }),
      )
    })

    const getCurrent = Effect.fn("Company.current")(() =>
      database(() =>
        Database.transaction((tx) => {
          ensureDefaultCompany(tx as Database.Transaction)
          return current(tx as Database.Transaction)
        }, { behavior: "immediate" }),
      ),
    )

    const ensureManagedRepository = Effect.fn("Company.ensureManagedRepository")(function* () {
      const state = yield* getCurrent()
      if (state.state !== "ready") return corrupt()
      if (state.company.repository) return state

      const root = path.join(Global.Path.data, "projects", "company", "repository")
      yield* Effect.tryPromise({ try: () => fs.mkdir(root, { recursive: true }), catch: (error) => error })
      const git = yield* Git.Service
      yield* git.run(["init", "--initial-branch=main"], { cwd: root })
      const candidate = yield* inspectRepository(root)
      return yield* database(() =>
        Database.transaction((tx) => {
          const currentState = current(tx)
          if (currentState.state !== "ready") return corrupt()
          if (currentState.company.repository) return currentState
          const now = Date.now()
          tx.insert(RepositoryBindingTable)
            .values({
              id: REPOSITORY_BINDING_ID,
              company_id: COMPANY_ID,
              project_id: candidate.project_id,
              root_path: candidate.root_path,
              default_branch: candidate.default_branch,
              bootstrap_head_commit: candidate.bootstrap_head_commit,
              bootstrap_dirty: candidate.dirty,
              time_created: now,
              time_updated: now,
            })
            .run()
          const result = current(tx)
          if (result.state !== "ready") return corrupt()
          return result
        }, { behavior: "immediate" }),
      )
    })

    const updateApprovalPolicy = Effect.fn("Company.updateApprovalPolicy")(function* (raw: ApprovalPolicyUpdateInput) {
      const input = ApprovalPolicyUpdateInput.parse(raw)
      return yield* database(() =>
        Database.transaction((tx) => {
          ensureDefaultCompany(tx as Database.Transaction)
          const now = Date.now()
          tx.update(ApprovalPolicyTable)
            .set({ preset: input.preset, time_updated: now })
            .where(eq(ApprovalPolicyTable.company_id, COMPANY_ID))
            .run()
          tx.update(CompanyTable).set({ time_updated: now }).where(eq(CompanyTable.id, COMPANY_ID)).run()
          const state = current(tx)
          if (state.state !== "ready") return corrupt()
          return state
        }, { behavior: "immediate" }),
      )
    })

    const getFounderOSModes = Effect.fn("Company.founderOSModes")(function* () {
      return yield* database(() =>
        Database.transaction((tx) => {
          ensureDefaultCompany(tx as Database.Transaction)
          return founderOSModes(tx)
        }, { behavior: "immediate" }),
      )
    })

    const updateFounderOSModes = Effect.fn("Company.updateFounderOSModes")(function* (raw: FounderOSModeUpdateInput) {
      const input = FounderOSModeUpdateInput.parse(raw)
      return yield* database(() =>
        Database.transaction((tx) => {
          ensureDefaultCompany(tx as Database.Transaction)
          const currentMode = tx
            .select({ mode: CompanyTable.company_commons_mode })
            .from(CompanyTable)
            .where(eq(CompanyTable.id, COMPANY_ID))
            .get()!.mode
          if (input.companyCommonsMode === "belief-loop" && currentMode !== "belief-loop")
            throw new Error("Belief Loop mode requires the controlled activation endpoint")
          if (
            commonsModeOrder.indexOf(input.companyCommonsMode) >
            commonsModeOrder.indexOf(currentMode) + 1
          )
            throw new Error("Company Commons modes must advance one stage at a time")
          if (input.companyCommonsMode === "reading" && currentMode !== "reading")
            requireReadingActivationFacts(tx, COMPANY_ID)
          tx.update(CompanyTable)
            .set({
              founder_twin_mode: input.founderTwinMode,
              company_commons_mode: input.companyCommonsMode,
              time_updated: Date.now(),
            })
            .where(eq(CompanyTable.id, COMPANY_ID))
            .run()
          return founderOSModes(tx)
        }, { behavior: "immediate" }),
      )
    })

    const activateBeliefLoop = Effect.fn("Company.activateBeliefLoop")(function* (
      raw: BeliefLoopActivationInputType,
    ) {
      const input = BeliefLoopActivationInput.parse(raw)
      return yield* database(() =>
        Database.transaction((tx) => {
          ensureDefaultCompany(tx as Database.Transaction)
          if (input.company_id !== COMPANY_ID) throw new Error("Belief Loop activation company does not match")
          const company = tx.select().from(CompanyTable).where(eq(CompanyTable.id, input.company_id)).get()
          if (!company || company.company_commons_mode !== "reading")
            throw new Error("Belief Loop activation requires the current Company Commons mode to be reading")
          const artifact = (id: string, gate: "K1" | "W2" | "E0" | "K2") => {
            const row = tx.select().from(CompanyArtifactTable).where(eq(CompanyArtifactTable.id, id)).get()
            const project = row?.project_id
              ? tx.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, row.project_id)).get()
              : undefined
            if (!row || (row.company_id !== input.company_id && project?.company_id !== input.company_id))
              throw new Error(`${gate} activation evidence is not company-scoped`)
            return row
          }
          artifact(input.k1_artifact_id, "K1")
          artifact(input.w2_artifact_id, "W2")
          artifact(input.e0_artifact_id, "E0")
          artifact(input.k2_evidence_package_artifact_id, "K2")
          const authorization = tx
            .select()
            .from(FounderGovernanceEventTable)
            .where(and(
              eq(FounderGovernanceEventTable.id, input.authorization_event_id),
              eq(FounderGovernanceEventTable.company_id, input.company_id),
              eq(FounderGovernanceEventTable.actor_kind, "human"),
              eq(FounderGovernanceEventTable.actor_id, input.actor.id),
            ))
            .get()
          if (!authorization || authorization.type !== "approval_gate.resolved")
            throw new Error("Belief Loop activation requires a persisted human authorization event")
          z.object({ decision: z.literal("approve") }).catchall(z.unknown()).parse(JSON.parse(authorization.data_json))
          requireBeliefLoopFacts(tx, input.company_id)
          tx.update(CompanyTable)
            .set({ company_commons_mode: "belief-loop", time_updated: Date.now() })
            .where(eq(CompanyTable.id, input.company_id))
            .run()
          return founderOSModes(tx)
        }, { behavior: "immediate" }),
      )
    })

    const bindProvider = Effect.fn("Company.bindProvider")(function* (raw: CompanyProviderBindingInputType) {
      const input = CompanyProviderBindingInput.parse(raw)
      yield* validateProvider(input)
      return yield* database(() =>
        Database.transaction((tx) => {
          ensureDefaultCompany(tx as Database.Transaction)
          const now = Date.now()
          tx.update(CompanyTable)
            .set({
              default_provider_id: input.provider_id,
              default_model_id: input.model_id,
              time_updated: now,
            })
            .where(eq(CompanyTable.id, COMPANY_ID))
            .run()
          const state = current(tx)
          if (state.state !== "ready") return corrupt()
          return state
        }, { behavior: "immediate" }),
      )
    })

    const deferSetupGoal = Effect.fn("Company.deferSetupGoal")(function* (raw: CompanySetupGoalInput) {
      const input = CompanySetupGoalInput.parse(raw)
      return yield* database(() =>
        Database.transaction((tx) => {
          ensureDefaultCompany(tx as Database.Transaction)
          const now = Date.now()
          tx.insert(CompanySetupGoalTable)
            .values({ company_id: COMPANY_ID, body: input.body, time_created: now, time_updated: now })
            .onConflictDoUpdate({ target: CompanySetupGoalTable.company_id, set: { body: input.body, time_updated: now } })
            .run()
          const state = current(tx)
          if (state.state !== "ready") return corrupt()
          return state
        }, { behavior: "immediate" }),
      )
    })

    const bootstrap = Effect.fn("Company.bootstrap")(function* (raw: BootstrapInputType) {
      const input = BootstrapInput.parse(raw)
      const inputPath = path.resolve(input.repository_path)
      const existing = yield* database(() => Database.use(readyRecord))
      if (existing?.row.bootstrap_request_id === input.request_id)
        return yield* database(() => existingResult(existing, input, inputPath))
      if (existing && !sameBusiness(existing, input)) return yield* Effect.fail(new CompanyAlreadyInitialized({}))
      if (existing?.row.bootstrap_input_path === inputPath) return existing.state
      if (existing) {
        const root = yield* Effect.tryPromise({
          try: () => fs.realpath(input.repository_path),
          catch: () => new CompanyAlreadyInitialized({}),
        })
        return yield* database(() => existingResult(existing, input, inputPath, { root_path: root }))
      }

      yield* validateProvider(input)
      const candidate = yield* inspectRepository(input.repository_path)
      return yield* database(() =>
        Database.transaction(
          (tx) => {
            const winner = readyRecord(tx)
            if (winner) return existingResult(winner, input, inputPath, candidate)

            const now = Date.now()
            tx.insert(CompanyTable)
              .values({
                id: COMPANY_ID,
                name: input.company_name,
                data_version: 1,
                default_provider_id: input.provider_id,
                default_model_id: input.model_id,
                bootstrap_request_id: input.request_id,
                bootstrap_input_path: inputPath,
                time_created: now,
                time_updated: now,
              })
              .run()
            tx.insert(ApprovalPolicyTable)
              .values({
                company_id: COMPANY_ID,
                preset: input.approval_preset,
                time_created: now,
                time_updated: now,
              })
              .run()
            tx.insert(RepositoryBindingTable)
              .values({
                id: REPOSITORY_BINDING_ID,
                company_id: COMPANY_ID,
                project_id: candidate.project_id,
                root_path: candidate.root_path,
                default_branch: candidate.default_branch,
                bootstrap_head_commit: candidate.bootstrap_head_commit,
                bootstrap_dirty: candidate.dirty,
                time_created: now,
                time_updated: now,
              })
              .run()
            ensureCompanyChannels({
              companyID: COMPANY_ID,
              boardAgentIDs: BOARD.map((member) => member.id),
              now,
            })
            tx.insert(CompanyAgentTable)
              .values(
                BOARD.map((member) => ({
                  id: member.id,
                  company_id: COMPANY_ID,
                  role_key: member.role,
                  lifecycle: "employee",
                  name: member.name,
                  org_layer: "board",
                  reports_to: member.reports_to,
                  responsibilities: JSON.stringify(member.responsibilities),
                  time_created: now,
                  time_updated: now,
                })),
              )
              .run()
            const state = current(tx)
            if (state.state !== "ready") return corrupt()
            return state
          },
          { behavior: "immediate" },
        ),
      )
    })

    return Service.of({
      current: getCurrent,
      founderOSModes: getFounderOSModes,
      bindProvider,
      updateApprovalPolicy,
      updateFounderOSModes,
      activateBeliefLoop,
      inspectRepository,
      ensureManagedRepository,
      bootstrap,
      deferSetupGoal,
    })
  }),
)

export const defaultLayer = layer
