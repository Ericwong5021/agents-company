import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { eq } from "@/storage"
import * as Database from "@/storage/db"
import type { TxOrDb } from "@/storage/db"
import { Global } from "@/global"
import { Git } from "@/git"
import { Project } from "@/project"
import { ProjectID } from "@/project/schema"
import { Provider } from "@/provider"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { ensureCompanyChannels } from "@/conversation/conversation.sql"
import { ApprovalPolicyTable, CompanyTable, RepositoryBindingTable } from "./company.sql"
import * as CompanySetupInstance from "./setup-instance"
import {
  BootstrapInput,
  type BootstrapInput as BootstrapInputType,
  type CompanyState,
  CompanyAlreadyInitialized,
  CompanyCorruptState,
  CompanyID,
  CompanyModelNotAvailable,
  CompanyNeedsBootstrapState,
  CompanyProviderNotConnected,
  CompanyProviderUnsupported,
  CompanyReadyState,
  CompanyRepositoryNotGit,
  type RepositoryCandidate,
} from "./schema"

const COMPANY_ID = CompanyID.parse("cmp_local")
const REPOSITORY_BINDING_ID = "rbd_primary"
const unsupportedProviders = new Set(["opencode"])

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

function needsBootstrap(): CompanyState {
  return CompanyNeedsBootstrapState.parse({
    state: "needs_bootstrap",
    data_directory: Global.Path.data,
    defaults: {
      company_name: "Agent Company",
      approval_preset: "balanced",
      board: BOARD.map((member) => ({
        id: member.id,
        role: member.role,
        name: member.name,
        lifecycle: "employee",
        responsibilities: [...member.responsibilities],
      })),
    },
    capabilities: { board_messages: false },
  })
}

function current(db: TxOrDb): CompanyState {
  const companies = db.select().from(CompanyTable).all()
  if (companies.length === 0) return needsBootstrap()
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
  if (policies.length !== 1 || bindings.length !== 1 || members.length !== BOARD.length) return corrupt()

  const policy = policies[0]
  const binding = bindings[0]
  if (!policy || !binding || binding.id !== REPOSITORY_BINDING_ID || policy.company_id !== company.id) return corrupt()

  const board = BOARD.map((member) => {
    const row = members.find((item) => item.id === member.id)
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
  if (members.some((row) => !BOARD.some((member) => member.id === row.id))) return corrupt()

  const parsed = CompanyReadyState.safeParse({
    state: "ready",
    data_directory: Global.Path.data,
    company: {
      id: company.id,
      name: company.name,
      data_version: company.data_version,
      provider: {
        provider_id: company.default_provider_id,
        model_id: company.default_model_id,
      },
      approval_policy: { preset: policy.preset },
      repository: {
        project_id: binding.project_id,
        root_path: binding.root_path,
        default_branch: binding.default_branch,
        bootstrap_head_commit: binding.bootstrap_head_commit,
        dirty: binding.bootstrap_dirty,
      },
      board,
      created_at: company.time_created,
      updated_at: company.time_updated,
    },
    start_suggestion: {
      kind: "bootstrap_complete",
      action: "open_board",
    },
    capabilities: { board_messages: false },
  })
  if (!parsed.success) return corrupt()
  return parsed.data
}

function readyRecord(db: TxOrDb): ReadyRecord | undefined {
  const state = current(db)
  if (state.state !== "ready") return
  const row = db.select().from(CompanyTable).where(eq(CompanyTable.id, state.company.id)).get()
  if (!row) return corrupt()
  return { state, row }
}

function sameBusiness(record: ReadyRecord, input: BootstrapInputType) {
  return (
    record.state.company.name === input.company_name &&
    record.state.company.provider.provider_id === input.provider_id &&
    record.state.company.provider.model_id === input.model_id &&
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
  if (candidate?.root_path === record.state.company.repository.root_path) return record.state
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
  readonly inspectRepository: (path: string) => Effect.Effect<RepositoryCandidate, unknown, Git.Service | Project.Service>
  readonly bootstrap: (input: BootstrapInputType) => Effect.Effect<CompanyReadyState, unknown, Git.Service | Project.Service>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Company") {}

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

    const validateProvider = Effect.fn("Company.validateProvider")(function* (input: BootstrapInputType) {
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

    const getCurrent = Effect.fn("Company.current")(() => database(() => Database.use(current)))

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
      inspectRepository,
      bootstrap,
    })
  }),
)

export const defaultLayer = layer
