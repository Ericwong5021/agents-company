import { createHash } from "node:crypto"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm"
import z from "zod"
import {
  FounderYellowActionContract,
  FounderYellowActionContracts,
  FounderYellowDelegationAction,
  FounderYellowDelegationInput,
  FounderYellowDelegationProjection,
  FounderYellowReadiness,
  FounderYellowReadinessRecordInput,
  FounderYellowRollbackInput,
  type FounderYellowDelegationInput as FounderYellowDelegationInputValue,
  type FounderYellowReadinessRecordInput as FounderYellowReadinessRecordInputValue,
  type FounderYellowRollbackInput as FounderYellowRollbackInputValue,
} from "@agents-company/shared/founder-os"
import { GoalBriefDraft } from "@agents-company/shared/experience"
import { CompanyTable } from "@/company/company.sql"
import { CompanyID } from "@/company/schema"
import {
  CompanyArtifactTable,
  CompanyGraphDecisionTable,
  CompanyOutcomeSignalCurrentTable,
  CompanyOutcomeSignalTable,
  CompanyPlanTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "@/company-project/company-project.sql"
import { GraphOperation } from "@/company-project/schema"
import { GoalBriefTable, GoalBriefVersionTable } from "@/goal-brief/goal-brief.sql"
import { Identifier } from "@/id/id"
import { FounderInterventionFenceTable } from "./advisor.sql"
import {
  GovernanceService,
  governanceLayer,
  submitGovernanceInTransaction,
} from "./authority"
import {
  appendDecisionDispatchInTransaction,
  appendDecisionTransitionInTransaction,
  defaultLayer as decisionLedgerLayer,
  recordFromRow,
  Service as DecisionLedgerService,
} from "./decision-ledger"
import {
  DecisionCurrentProjectionTable,
  DecisionRecordTable,
  FounderGovernanceEventTable,
} from "./decision-ledger.sql"
import * as FounderOSMode from "./mode"
import { Database } from "@/storage"
import type { TxOrDb } from "@/storage/db"
import { FounderGreenReadinessTable } from "@/project-orchestrator/founder-delegation.sql"
import { ProjectActionExecutor } from "@/project-orchestrator/project-action-executor"
import { ProjectOrchestrator } from "@/project-orchestrator/project-orchestrator"
import {
  FounderYellowCheckpointTable,
  FounderYellowDispatchOutboxTable,
  FounderYellowEventTable,
  FounderYellowReadinessTable,
  FounderYellowRunTable,
} from "./yellow.sql"
import { yellowSummaryFromRow } from "./yellow-projection"

const ReadinessArtifactEvidence = z
  .object({
    verified: z.literal(true),
    gate: z.enum(["W6", "E0"]),
    authority: z.enum(["control_plane", "human", "external_system", "independent_reviewer"]),
  })
  .catchall(z.unknown())

const IndependentOutcomeArtifactEvidence = z
  .object({
    authority: z.enum(["control_plane", "human", "external_system", "independent_reviewer"]),
    accepted: z.boolean().optional(),
    verified: z.boolean().optional(),
  })
  .catchall(z.unknown())
  .refine((value) => value.accepted === true || value.verified === true)

const YellowCheckpointSnapshot = z
  .object({
    schemaVersion: z.literal(1),
    project: z
      .object({
        id: z.string(),
        goal: z.string(),
        title: z.string(),
        status: z.string(),
        graphRevision: z.number().int().nonnegative(),
        dispatchPaused: z.boolean(),
        orchestrationState: z.string(),
        updatedAt: z.number().int().nonnegative(),
      })
      .strict(),
    direction: z
      .object({
        briefId: z.string(),
        briefVersion: z.number().int().positive(),
        planVersion: z.number().int().positive(),
        brief: GoalBriefDraft,
      })
      .strict(),
    workItems: z.array(z.object({
      id: z.string(),
      status: z.string(),
      reviewStatus: z.string(),
      ownerAgentId: z.string().nullable(),
      graphRevisionCreated: z.number().int().nonnegative(),
    }).strict()),
  })
  .strict()

const redInvariants = [
  "external.communication.propose",
  "external.payment.propose",
  "production.operation.propose",
  "data.delete.propose",
  "privacy.change.propose",
  "security.change.propose",
  "child_safety.change.propose",
] as const

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]),
  )
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(normalized(value))).digest("hex")
}

function currentMode(companyId: string) {
  const company = Database.use((db) =>
    db.select().from(CompanyTable).where(eq(CompanyTable.id, CompanyID.parse(companyId))).get(),
  )
  if (!company) throw new Error("Company was not found")
  return FounderOSMode.resolve({
    founderTwinMode: company.founder_twin_mode,
    companyCommonsMode: company.company_commons_mode,
  })
}

function latestGreenReadiness(db: TxOrDb, companyId: string) {
  const row = db
    .select()
    .from(FounderGreenReadinessTable)
    .where(eq(FounderGreenReadinessTable.company_id, companyId))
    .orderBy(desc(FounderGreenReadinessTable.created_at), desc(FounderGreenReadinessTable.id))
    .get()
  if (
    !row
    || row.b3_status !== "passed"
    || row.e0_status !== "passed"
    || row.w5_observation_status !== "passed"
    || row.takeover_fence_status !== "passed"
    || row.preference_holdout_status !== "passed"
    || row.preference_agreement_rate === null
    || row.preference_agreement_rate < 0.8
    || row.metric_contract_status !== "passed"
    || row.metric_window_days !== 30
    || !row.metric_sample_contract_met
    || row.authorization_status !== "human_confirmed"
    || row.exact_commit_status !== "passed"
  )
    return
  return row
}

function readiness(companyId: string) {
  const row = Database.use((db) =>
    db
      .select()
      .from(FounderYellowReadinessTable)
      .where(eq(FounderYellowReadinessTable.company_id, companyId))
      .orderBy(desc(FounderYellowReadinessTable.created_at), desc(FounderYellowReadinessTable.id))
      .get(),
  )
  if (!row)
    return {
      id: null,
      value: FounderYellowReadiness.parse({
        schemaVersion: 1,
        companyId,
        status: "not_confirmed",
        greenReadinessRef: null,
        w6ObservationEvidenceRef: null,
        e0EvidenceRef: null,
        outcomeSignalRef: null,
        authorizationEventRef: null,
        confirmedBy: null,
        failClosedReasons: [
          "W6 real observation is not confirmed.",
          "E0 evidence is not confirmed.",
          "Outcome Signal stability is not confirmed.",
          "Human Yellow authorization is not confirmed.",
        ],
        autoPromotionAllowed: false,
        recordedAt: null,
      }),
    }
  const outcome = Database.use((db) => validatedOutcome(db, row.outcome_signal_id))
  const confirmed = outcome?.result === "succeeded"
  return {
    id: row.id,
    value: FounderYellowReadiness.parse({
      schemaVersion: 1,
      companyId,
      status: confirmed ? "confirmed" : "not_confirmed",
      greenReadinessRef: row.green_readiness_id,
      w6ObservationEvidenceRef: row.w6_observation_evidence_ref,
      e0EvidenceRef: row.e0_evidence_ref,
      outcomeSignalRef: row.outcome_signal_id,
      authorizationEventRef: row.authorization_event_id,
      confirmedBy: row.confirmed_by,
      failClosedReasons: confirmed
        ? []
        : ["Referenced Outcome Signal is no longer validated and successful."],
      autoPromotionAllowed: false,
      recordedAt: row.created_at,
    }),
  }
}

function fenced(companyId: string, boardThreadId: string) {
  return Boolean(Database.use((db) =>
    db
      .select({ id: FounderInterventionFenceTable.id })
      .from(FounderInterventionFenceTable)
      .where(and(
        eq(FounderInterventionFenceTable.company_id, companyId),
        eq(FounderInterventionFenceTable.board_thread_id, boardThreadId),
      ))
      .get(),
  ))
}

function circuitOpen(companyId: string) {
  const latest = Database.use((db) =>
    db
      .select()
      .from(FounderYellowEventTable)
      .where(and(
        eq(FounderYellowEventTable.company_id, companyId),
        inArray(FounderYellowEventTable.type, ["circuit_opened", "override_recorded"]),
      ))
      .orderBy(desc(FounderYellowEventTable.created_at), desc(FounderYellowEventTable.id))
      .all()
      .find((row) =>
        row.type === "circuit_opened"
        || z.object({ circuitReset: z.literal(true) }).catchall(z.unknown()).safeParse(JSON.parse(row.data_json)).success
      ),
  )
  return latest?.type === "circuit_opened"
}

function greenReady(companyId: string) {
  return Boolean(Database.use((db) => latestGreenReadiness(db, companyId)))
}

function event(
  db: TxOrDb,
  input: {
    companyId: string
    runId: string | null
    decisionId: string | null
    idempotencyKey: string
    type:
      | "checkpoint_recorded"
      | "authorized"
      | "dispatch_started"
      | "dispatch_completed"
      | "outcome_recorded"
      | "override_recorded"
      | "circuit_opened"
      | "rollback_requested"
      | "rollback_completed"
      | "rollback_failed"
      | "rejected"
    actor: { kind: "human" | "ai_founder" | "policy_engine" | "control_plane"; id: string }
    data: Record<string, unknown>
  },
) {
  const existing = db
    .select()
    .from(FounderYellowEventTable)
    .where(and(
      eq(FounderYellowEventTable.company_id, input.companyId),
      eq(FounderYellowEventTable.idempotency_key, input.idempotencyKey),
    ))
    .get()
  if (existing) return existing
  const row = {
    id: Identifier.create("fyevt", "ascending"),
    company_id: input.companyId,
    run_id: input.runId,
    decision_id: input.decisionId,
    idempotency_key: input.idempotencyKey,
    type: input.type,
    actor_kind: input.actor.kind,
    actor_id: input.actor.id,
    data_json: JSON.stringify(input.data),
    created_at: Date.now(),
  }
  db.insert(FounderYellowEventTable).values(row).run()
  return row
}

function downgradeInvalidYellowReadiness(companyId: string, readinessId: string | null) {
  Database.transaction((db) => {
    const company = db.select().from(CompanyTable).where(eq(CompanyTable.id, CompanyID.parse(companyId))).get()
    if (company?.founder_twin_mode !== "yellow-delegated") return
    event(db, {
      companyId,
      runId: null,
      decisionId: null,
      idempotencyKey: `yellow-readiness-invalid:${readinessId ?? "missing"}`,
      type: "circuit_opened",
      actor: { kind: "policy_engine", id: "yellow-readiness-monitor" },
      data: {
        reason: "Referenced Outcome Signal is no longer validated and successful.",
        targetMode: "advisor",
      },
    })
    db.update(CompanyTable)
      .set({ founder_twin_mode: "advisor", time_updated: Date.now() })
      .where(eq(CompanyTable.id, CompanyID.parse(companyId)))
      .run()
  }, { behavior: "immediate" })
}

function contract(actionType: string) {
  const parsed = FounderYellowDelegationAction.safeParse(actionType)
  if (!parsed.success) return
  return FounderYellowActionContract.parse(FounderYellowActionContracts[parsed.data])
}

function snapshot(db: TxOrDb, projectId: string) {
  const project = db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, projectId)).get()
  if (!project) throw new Error("Yellow delegation project was not found")
  const briefRoot = db
    .select()
    .from(GoalBriefTable)
    .where(eq(GoalBriefTable.project_id, projectId))
    .get()
  const brief = briefRoot
    ? db
        .select()
        .from(GoalBriefVersionTable)
        .where(eq(GoalBriefVersionTable.brief_id, briefRoot.id))
        .orderBy(desc(GoalBriefVersionTable.version))
        .get()
    : undefined
  const plan = db
    .select()
    .from(CompanyPlanTable)
    .where(eq(CompanyPlanTable.project_id, projectId))
    .orderBy(desc(CompanyPlanTable.version))
    .get()
  if (!briefRoot || !brief || !plan || plan.status !== "active")
    throw new Error("Yellow delegation requires an active Goal Brief and Plan checkpoint")
  return YellowCheckpointSnapshot.parse({
    schemaVersion: 1,
    project: {
      id: project.id,
      goal: project.goal,
      title: project.title,
      status: project.status,
      graphRevision: project.graph_revision,
      dispatchPaused: project.dispatch_paused,
      orchestrationState: project.orchestration_state,
      updatedAt: project.updated_at,
    },
    direction: {
      briefId: briefRoot.id,
      briefVersion: brief.version,
      planVersion: plan.version,
      brief: {
        goal: brief.goal,
        deliverables: JSON.parse(brief.deliverables_json),
        acceptanceCriteria: JSON.parse(brief.acceptance_criteria_json),
        constraints: JSON.parse(brief.constraints_json),
        nonGoals: JSON.parse(brief.non_goals_json),
        assumptions: JSON.parse(brief.assumptions_json),
        openQuestions: JSON.parse(brief.open_questions_json),
        riskLevel: brief.risk_level,
        recommendedPlan: JSON.parse(brief.recommended_plan_json),
        approvalMode: brief.approval_mode,
        sourceRefs: JSON.parse(brief.source_refs_json),
      },
    },
    workItems: db
      .select()
      .from(CompanyWorkItemTable)
      .where(eq(CompanyWorkItemTable.project_id, projectId))
      .orderBy(asc(CompanyWorkItemTable.created_at), asc(CompanyWorkItemTable.id))
      .all()
      .map((item) => ({
        id: item.id,
        status: item.status,
        reviewStatus: item.review_status,
        ownerAgentId: item.owner_agent_id,
        graphRevisionCreated: item.graph_revision_created,
      })),
  })
}

function directionPreflight(input: FounderYellowDelegationInputValue) {
  return Database.use((db) => {
    const root = db
      .select()
      .from(GoalBriefTable)
      .where(eq(GoalBriefTable.project_id, input.projectId))
      .get()
    const brief = root
      ? db
          .select()
          .from(GoalBriefVersionTable)
          .where(eq(GoalBriefVersionTable.brief_id, root.id))
          .orderBy(desc(GoalBriefVersionTable.version))
          .get()
      : undefined
    const plan = db
      .select()
      .from(CompanyPlanTable)
      .where(eq(CompanyPlanTable.project_id, input.projectId))
      .orderBy(desc(CompanyPlanTable.version))
      .get()
    if (!root || !brief || !plan || plan.status !== "active")
      return ["Yellow direction requires an active Goal Brief and Plan."]
    if (
      input.direction.briefId !== root.id
      || input.direction.expectedBriefVersion !== brief.version
      || input.direction.expectedPlanVersion !== plan.version
    )
      return ["Yellow direction request does not match the current Goal Brief and Plan versions."]
    const current = {
      goal: brief.goal,
      deliverables: JSON.parse(brief.deliverables_json),
      acceptanceCriteria: JSON.parse(brief.acceptance_criteria_json),
      constraints: JSON.parse(brief.constraints_json),
      nonGoals: JSON.parse(brief.non_goals_json),
      assumptions: JSON.parse(brief.assumptions_json),
      openQuestions: JSON.parse(brief.open_questions_json),
      riskLevel: brief.risk_level,
      recommendedPlan: JSON.parse(brief.recommended_plan_json),
      approvalMode: brief.approval_mode,
      sourceRefs: JSON.parse(brief.source_refs_json),
    }
    if (digest(current) === digest(input.direction.brief))
      return ["Yellow direction proposal must produce a real, reversible direction change."]
    return []
  })
}

function saveBlocked(
  input: FounderYellowDelegationInputValue,
  inputSha256: string,
  reasons: string[],
  governanceRef: string | null = null,
) {
  const existing = Database.use((db) =>
    db
      .select()
      .from(FounderYellowRunTable)
      .where(and(
        eq(FounderYellowRunTable.company_id, input.companyId),
        eq(FounderYellowRunTable.idempotency_key, input.idempotencyKey),
      ))
      .get(),
  )
  if (existing) {
    if (existing.input_sha256 !== inputSha256)
      throw new Error("Yellow delegation idempotency key has different facts")
    return Database.use((db) => yellowSummaryFromRow(db, existing))
  }
  const id = Identifier.create("fyrun", "ascending")
  const now = Date.now()
  Database.transaction((db) => {
    db.insert(FounderYellowRunTable)
      .values({
        id,
        company_id: input.companyId,
        idempotency_key: input.idempotencyKey,
        input_sha256: inputSha256,
        project_id: input.projectId,
        board_thread_id: input.boardThreadId,
        decision_id: input.decisionId,
        receipt_id: input.receiptId,
        action_type: input.actionType,
        direction_json: JSON.stringify(input.direction),
        status: "blocked",
        readiness_id: readiness(input.companyId).id,
        checkpoint_id: null,
        governance_ref: governanceRef,
        graph_decision_id: null,
        mutation_id: null,
        work_item_ids_json: "[]",
        receipt_ids_json: JSON.stringify([input.receiptId]),
        outcome_ids_json: "[]",
        cost_unit: input.estimatedCost.unit,
        cost_limit: contract(input.actionType)?.costLimit.maximum ?? 1,
        estimated_cost: input.estimatedCost.amount,
        actual_cost: 0,
        rollback_handler_id: contract(input.actionType)?.rollbackHandlerId ?? null,
        dispatched_at: null,
        fail_closed_reasons_json: JSON.stringify(reasons),
        created_at: now,
        updated_at: now,
      })
      .run()
    event(db, {
      companyId: input.companyId,
      runId: id,
      decisionId: input.decisionId,
      idempotencyKey: `${input.idempotencyKey}:rejected`,
      type: "rejected",
      actor: input.requestedBy,
      data: { reasons, governanceRef },
    })
  }, { behavior: "immediate" })
  return Database.use((db) =>
    yellowSummaryFromRow(
      db,
      db.select().from(FounderYellowRunTable).where(eq(FounderYellowRunTable.id, id)).get()!,
    ),
  )
}

function chain(db: TxOrDb, run: typeof FounderYellowRunTable.$inferSelect) {
  const graphDecision = run.graph_decision_id
    ? db
        .select()
        .from(CompanyGraphDecisionTable)
        .where(eq(CompanyGraphDecisionTable.id, run.graph_decision_id))
        .get()
    : undefined
  const triggerReceipt = db
    .select()
    .from(CompanyWorkReceiptTable)
    .where(eq(CompanyWorkReceiptTable.id, run.receipt_id))
    .get()
  const workItemIds = [...new Set([
    ...(triggerReceipt ? [triggerReceipt.work_item_id] : []),
    ...(graphDecision
      ? GraphOperation.array()
          .parse(JSON.parse(graphDecision.operations_json))
          .flatMap((operation) => operation.type === "add_work_item" ? [operation.item.id] : [])
      : []),
  ])].sort()
  const receiptIds = db
    .select({ id: CompanyWorkReceiptTable.id, workItemId: CompanyWorkReceiptTable.work_item_id })
    .from(CompanyWorkReceiptTable)
    .where(eq(CompanyWorkReceiptTable.project_id, run.project_id))
    .orderBy(asc(CompanyWorkReceiptTable.created_at), asc(CompanyWorkReceiptTable.id))
    .all()
    .filter((receipt) => receipt.id === run.receipt_id || workItemIds.includes(receipt.workItemId))
    .map((receipt) => receipt.id)
  const outcomeIds = db
    .select({ id: CompanyOutcomeSignalTable.id })
    .from(CompanyOutcomeSignalTable)
    .innerJoin(
      CompanyOutcomeSignalCurrentTable,
      eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, CompanyOutcomeSignalTable.id),
    )
    .where(and(
      eq(CompanyOutcomeSignalTable.decision_id, run.decision_id),
      eq(CompanyOutcomeSignalCurrentTable.current_status, "validated"),
      inArray(CompanyOutcomeSignalTable.work_receipt_id, receiptIds),
      run.dispatched_at
        ? gte(CompanyOutcomeSignalTable.observed_at, run.dispatched_at)
        : undefined,
      run.dispatched_at
        ? gte(CompanyOutcomeSignalCurrentTable.validated_at, run.dispatched_at)
        : undefined,
    ))
    .orderBy(asc(CompanyOutcomeSignalTable.observed_at), asc(CompanyOutcomeSignalTable.id))
    .all()
    .map((outcome) => outcome.id)
  return { workItemIds, receiptIds, outcomeIds, actualCost: receiptIds.length }
}

function validatedOutcome(db: TxOrDb, id: string) {
  const outcome = db.select().from(CompanyOutcomeSignalTable).where(eq(CompanyOutcomeSignalTable.id, id)).get()
  if (!outcome) return
  const current = db
    .select()
    .from(CompanyOutcomeSignalCurrentTable)
    .where(eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, id))
    .get()
  if (
    current?.current_status !== "validated"
    || !current.validated_at
    || outcome.validator_result_kind !== outcome.validator_kind
    || outcome.validator_result_id !== outcome.validator_id
  )
    return
  const sourceRefs = z
    .array(z.object({ kind: z.string(), id: z.string() }).catchall(z.unknown()))
    .parse(JSON.parse(outcome.source_refs_json))
  if (!sourceRefs.some((reference) =>
    reference.kind === outcome.validator_kind && reference.id === outcome.validator_id
  ))
    return
  if (outcome.validator_kind === "validation_gate") {
    const gate = db
      .select()
      .from(CompanyValidationGateTable)
      .where(eq(CompanyValidationGateTable.id, outcome.validator_id))
      .get()
    if (
      !gate
      || gate.project_id !== outcome.project_id
      || gate.status !== "passed"
      || !gate.evaluated_at
      || !z.array(z.unknown()).parse(JSON.parse(gate.evidence_refs_json)).length
    )
      return
    return outcome
  }
  if (outcome.validator_kind !== "artifact") return
  const artifact = db
    .select()
    .from(CompanyArtifactTable)
    .where(eq(CompanyArtifactTable.id, outcome.validator_id))
    .get()
  if (
    !artifact
    || artifact.project_id !== outcome.project_id
    || artifact.created_by_agent_id
    || !IndependentOutcomeArtifactEvidence.safeParse(JSON.parse(artifact.evidence_json)).success
  )
    return
  return outcome
}

function recordReadiness(raw: FounderYellowReadinessRecordInputValue) {
  const input = FounderYellowReadinessRecordInput.parse(raw)
  const inputSha256 = digest(input)
  Database.transaction((db) => {
    const existing = db
      .select()
      .from(FounderYellowReadinessTable)
      .where(and(
        eq(FounderYellowReadinessTable.company_id, input.companyId),
        eq(FounderYellowReadinessTable.idempotency_key, input.idempotencyKey),
      ))
      .get()
    if (existing) {
      if (existing.input_sha256 !== inputSha256)
        throw new Error("Yellow readiness idempotency key has different facts")
      return
    }
    const company = db.select().from(CompanyTable).where(eq(CompanyTable.id, CompanyID.parse(input.companyId))).get()
    if (!company) throw new Error("Company was not found")
    const resolvedMode = FounderOSMode.resolve({
      founderTwinMode: company.founder_twin_mode,
      companyCommonsMode: company.company_commons_mode,
    })
    if (company.founder_twin_mode !== "green-delegated")
      throw new Error("Yellow readiness promotion requires current company mode green-delegated")
    if (resolvedMode.globalMaximum.founderTwinMode !== "yellow-delegated")
      throw new Error("Global Founder Twin mode does not allow Yellow delegation")
    const green = latestGreenReadiness(db, input.companyId)
    if (!green) throw new Error("Yellow readiness requires confirmed Green readiness")
    const artifact = (id: string, gate: "W6" | "E0") => {
      const row = db.select().from(CompanyArtifactTable).where(eq(CompanyArtifactTable.id, id)).get()
      const project = row?.project_id
        ? db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, row.project_id)).get()
        : undefined
      const evidence = row ? ReadinessArtifactEvidence.safeParse(JSON.parse(row.evidence_json)) : undefined
      if (
        !row
        || (row.company_id !== input.companyId && project?.company_id !== input.companyId)
        || !evidence?.success
        || evidence.data.gate !== gate
      )
        throw new Error(`${gate} readiness requires verified company-scoped evidence`)
      return row
    }
    const w6 = artifact(input.w6ObservationArtifactId, "W6")
    const e0 = artifact(input.e0ArtifactId, "E0")
    const outcome = validatedOutcome(db, input.outcomeSignalId)
    const outcomeProject = outcome
      ? db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, outcome.project_id)).get()
      : undefined
    if (!outcome || outcome.result !== "succeeded" || outcomeProject?.company_id !== input.companyId)
      throw new Error("Yellow readiness requires a successful company Outcome Signal")
    const authorization = db
      .select()
      .from(FounderGovernanceEventTable)
      .where(and(
        eq(FounderGovernanceEventTable.id, input.authorizationEventId),
        eq(FounderGovernanceEventTable.company_id, input.companyId),
        eq(FounderGovernanceEventTable.actor_kind, "human"),
        eq(FounderGovernanceEventTable.actor_id, input.actor.id),
      ))
      .get()
    const authorizationData = authorization
      ? z.object({ decision: z.literal("approve") }).catchall(z.unknown()).safeParse(JSON.parse(authorization.data_json))
      : undefined
    if (authorization?.type !== "approval_gate.resolved" || !authorizationData?.success)
      throw new Error("Yellow readiness requires an approved human authorization event")
    db.insert(FounderYellowReadinessTable)
      .values({
        id: Identifier.create("fyrdy", "ascending"),
        company_id: input.companyId,
        idempotency_key: input.idempotencyKey,
        input_sha256: inputSha256,
        green_readiness_id: green.id,
        w6_observation_evidence_ref: w6.id,
        e0_evidence_ref: e0.id,
        outcome_signal_id: outcome.id,
        authorization_event_id: authorization.id,
        confirmed_by: input.actor.id,
        created_at: Date.now(),
      })
      .run()
    db.update(CompanyTable)
      .set({ founder_twin_mode: "yellow-delegated", time_updated: Date.now() })
      .where(eq(CompanyTable.id, CompanyID.parse(input.companyId)))
      .run()
    event(db, {
      companyId: input.companyId,
      runId: null,
      decisionId: null,
      idempotencyKey: `${input.idempotencyKey}:circuit-reset`,
      type: "override_recorded",
      actor: input.actor,
      data: { circuitReset: true, readinessId: input.idempotencyKey },
    })
  }, { behavior: "immediate" })
  return readiness(input.companyId).value
}

export interface Interface {
  readonly submit: (
    input: FounderYellowDelegationInputValue,
  ) => Effect.Effect<ReturnType<typeof yellowSummaryFromRow>, unknown>
  readonly projection: (companyId: string) => Effect.Effect<FounderYellowDelegationProjection, unknown>
  readonly recordReadiness: (
    input: FounderYellowReadinessRecordInputValue,
  ) => Effect.Effect<FounderYellowReadiness, unknown>
  readonly rollback: (
    runId: string,
    input: FounderYellowRollbackInputValue,
  ) => Effect.Effect<ReturnType<typeof yellowSummaryFromRow>, unknown>
  readonly recover: () => Effect.Effect<{ pendingOutboxIds: string[]; reconciledRunIds: string[] }, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/FounderYellowDelegation") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const governance = yield* GovernanceService
    const ledger = yield* DecisionLedgerService
    const orchestrator = yield* ProjectOrchestrator.Service
    const executor = yield* ProjectActionExecutor.Service

    const openCircuit = Effect.fn("FounderYellowDelegation.openCircuit")(function* (
      run: typeof FounderYellowRunTable.$inferSelect,
      reason: string,
    ) {
      const targetMode = greenReady(run.company_id)
        ? "green-delegated"
        : "advisor"
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          event(db, {
            companyId: run.company_id,
            runId: run.id,
            decisionId: run.decision_id,
            idempotencyKey: `yellow-circuit:${run.id}:${digest(reason)}`,
            type: "circuit_opened",
            actor: { kind: "policy_engine", id: "yellow-circuit-breaker" },
            data: { reason, targetMode },
          })
          const company = db
            .select()
            .from(CompanyTable)
            .where(eq(CompanyTable.id, CompanyID.parse(run.company_id)))
            .get()
          if (company?.founder_twin_mode === "yellow-delegated")
            db.update(CompanyTable)
              .set({ founder_twin_mode: targetMode, time_updated: Date.now() })
              .where(eq(CompanyTable.id, CompanyID.parse(run.company_id)))
              .run()
        }, { behavior: "immediate" }),
      )
      yield* orchestrator.pauseDispatch(run.project_id, reason)
    })

    const rollback = Effect.fn("FounderYellowDelegation.rollback")(function* (
      runId: string,
      raw: FounderYellowRollbackInputValue,
    ) {
      const input = FounderYellowRollbackInput.parse(raw)
      const run = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(FounderYellowRunTable).where(eq(FounderYellowRunTable.id, runId)).get()),
      )
      if (!run || !run.checkpoint_id || !run.rollback_handler_id)
        throw new Error("Yellow rollback requires an existing persisted checkpoint and handler")
      if (
        input.trigger === "failure_condition"
        && !Database.use((db) =>
          db
            .select({ id: FounderYellowEventTable.id })
            .from(FounderYellowEventTable)
            .where(and(
              eq(FounderYellowEventTable.run_id, run.id),
              eq(FounderYellowEventTable.type, "circuit_opened"),
            ))
            .get(),
        )
      )
        throw new Error("Automatic rollback requires an explicit persisted failure condition")
      const existing = Database.use((db) =>
        db
          .select()
          .from(FounderYellowEventTable)
          .where(and(
            eq(FounderYellowEventTable.company_id, run.company_id),
            eq(FounderYellowEventTable.idempotency_key, input.idempotencyKey),
          ))
          .get(),
      )
      if (existing)
        return Database.use((db) =>
          yellowSummaryFromRow(
            db,
            db.select().from(FounderYellowRunTable).where(eq(FounderYellowRunTable.id, run.id)).get()!,
          ),
        )
      const rollbackId = Identifier.create("fyrollback", "ascending")
      yield* Effect.sync(() =>
        Database.transaction((db) =>
          event(db, {
            companyId: run.company_id,
            runId: run.id,
            decisionId: run.decision_id,
            idempotencyKey: input.idempotencyKey,
            type: "rollback_requested",
            actor: input.actor,
            data: {
              rollbackId,
              trigger: input.trigger,
              handlerId: run.rollback_handler_id,
              checkpointId: run.checkpoint_id,
              reason: input.reason,
            },
          }),
        { behavior: "immediate" }),
      )
      const rollbackOutcome = yield* Effect.exit(
        Effect.gen(function* () {
          yield* orchestrator.pauseDispatch(run.project_id, `Yellow rollback ${rollbackId}`)
          const checkpoint = Database.use((db) =>
            db
              .select()
              .from(FounderYellowCheckpointTable)
              .where(eq(FounderYellowCheckpointTable.id, run.checkpoint_id!))
              .get(),
          )
          if (!checkpoint) throw new Error("Yellow rollback checkpoint was not found")
          const checkpointSnapshot = YellowCheckpointSnapshot.parse(JSON.parse(checkpoint.snapshot_json))
          const current = Database.use((db) => {
            const project = db
              .select()
              .from(CompanyProjectTable)
              .where(eq(CompanyProjectTable.id, run.project_id))
              .get()
            const brief = db
              .select()
              .from(GoalBriefVersionTable)
              .where(eq(GoalBriefVersionTable.brief_id, checkpointSnapshot.direction.briefId))
              .orderBy(desc(GoalBriefVersionTable.version))
              .get()
            const plan = db
              .select()
              .from(CompanyPlanTable)
              .where(eq(CompanyPlanTable.project_id, run.project_id))
              .orderBy(desc(CompanyPlanTable.version))
              .get()
            if (!project || !brief || !plan)
              throw new Error("Yellow rollback current direction state is incomplete")
            return { project, brief, plan }
          })
          const result = yield* executor.execute({
            project_id: run.project_id,
            action: "restore_direction_checkpoint",
            idempotency_key: `yellow-rollback:${rollbackId}:restore`,
            expected_revision: current.project.graph_revision,
            payload: {
              checkpoint_id: checkpoint.id,
              brief_id: checkpointSnapshot.direction.briefId,
              expected_brief_version: current.brief.version,
              expected_plan_version: current.plan.version,
              brief: checkpointSnapshot.direction.brief,
              change_reason: input.reason,
            },
          })
          const restored = Database.use((db) => {
            const project = db
              .select()
              .from(CompanyProjectTable)
              .where(eq(CompanyProjectTable.id, run.project_id))
              .get()
            const brief = db
              .select()
              .from(GoalBriefVersionTable)
              .where(eq(GoalBriefVersionTable.brief_id, checkpointSnapshot.direction.briefId))
              .orderBy(desc(GoalBriefVersionTable.version))
              .get()
            if (!project || !brief) return false
            return project.goal === checkpointSnapshot.direction.brief.goal
              && digest({
                goal: brief.goal,
                deliverables: JSON.parse(brief.deliverables_json),
                acceptanceCriteria: JSON.parse(brief.acceptance_criteria_json),
                constraints: JSON.parse(brief.constraints_json),
                nonGoals: JSON.parse(brief.non_goals_json),
                assumptions: JSON.parse(brief.assumptions_json),
                openQuestions: JSON.parse(brief.open_questions_json),
                riskLevel: brief.risk_level,
                recommendedPlan: JSON.parse(brief.recommended_plan_json),
                approvalMode: brief.approval_mode,
                sourceRefs: JSON.parse(brief.source_refs_json),
              }) === digest(checkpointSnapshot.direction.brief)
          })
          if (result.action.status !== "applied" || !restored)
            throw new Error("Yellow rollback handler did not restore and verify the direction checkpoint")
          return result
        }),
      )
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          const success = Exit.isSuccess(rollbackOutcome) && rollbackOutcome.value.action.status === "applied"
          event(db, {
            companyId: run.company_id,
            runId: run.id,
            decisionId: run.decision_id,
            idempotencyKey: `${input.idempotencyKey}:result`,
            type: success ? "rollback_completed" : "rollback_failed",
            actor: { kind: "control_plane", id: "project-action-executor" },
            data: {
              rollbackId,
              trigger: input.trigger,
              handlerId: run.rollback_handler_id,
              reason: input.reason,
              result: Exit.isSuccess(rollbackOutcome)
                ? `${rollbackOutcome.value.action.id}:${rollbackOutcome.value.action.status}`
                : String(Cause.squash(rollbackOutcome.cause)),
            },
          })
          if (success)
            db.update(FounderYellowRunTable)
              .set({ status: "rolled_back", updated_at: Date.now() })
              .where(eq(FounderYellowRunTable.id, run.id))
              .run()
        }, { behavior: "immediate" }),
      )
      const decision = yield* ledger.get(run.decision_id)
      if (Exit.isSuccess(rollbackOutcome) && ["executed", "overridden"].includes(decision.currentStatus))
        yield* ledger.appendTransition(run.decision_id, {
          schemaVersion: 1,
          idempotencyKey: `${input.idempotencyKey}:ledger`,
          toStatus: "rolled_back",
          kind: "rolled_back",
          reason: input.reason,
          actorId: input.actor.id,
          finalDecision: decision.finalDecision ?? input.reason,
        })
      return Database.use((db) =>
        yellowSummaryFromRow(
          db,
          db.select().from(FounderYellowRunTable).where(eq(FounderYellowRunTable.id, run.id)).get()!,
        ),
      )
    })

    const failRun = Effect.fn("FounderYellowDelegation.failRun")(function* (
      run: typeof FounderYellowRunTable.$inferSelect,
      reason: string,
    ) {
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.update(FounderYellowDispatchOutboxTable)
            .set({ status: "failed", last_error: reason, updated_at: Date.now() })
            .where(eq(FounderYellowDispatchOutboxTable.run_id, run.id))
            .run()
          db.update(FounderYellowRunTable)
            .set({
              status: "failed",
              fail_closed_reasons_json: JSON.stringify([reason]),
              updated_at: Date.now(),
            })
            .where(eq(FounderYellowRunTable.id, run.id))
            .run()
          event(db, {
            companyId: run.company_id,
            runId: run.id,
            decisionId: run.decision_id,
            idempotencyKey: `yellow-failed:${run.id}:${digest(reason)}`,
            type: "rejected",
            actor: { kind: "control_plane", id: "yellow-dispatch-outbox" },
            data: { reason },
          })
        }, { behavior: "immediate" }),
      )
      yield* openCircuit(run, reason)
      yield* rollback(run.id, {
        schemaVersion: 1,
        idempotencyKey: `yellow-auto-rollback:${run.id}:${digest(reason)}`,
        trigger: "failure_condition",
        reason,
        actor: { kind: "policy_engine", id: "yellow-circuit-breaker" },
      })
    })

    const reconcile = Effect.fn("FounderYellowDelegation.reconcile")(function* (
      companyId?: string,
    ) {
      const runs = Database.use((db) =>
        db
          .select()
          .from(FounderYellowRunTable)
          .where(
            companyId
              ? and(
                  eq(FounderYellowRunTable.company_id, companyId),
                  eq(FounderYellowRunTable.status, "outcome_pending"),
                )
              : eq(FounderYellowRunTable.status, "outcome_pending"),
          )
          .orderBy(asc(FounderYellowRunTable.created_at), asc(FounderYellowRunTable.id))
          .all(),
      )
      yield* Effect.forEach(runs, (run) =>
        Effect.gen(function* () {
          const contractValue = contract(run.action_type)
          if (!contractValue) return yield* failRun(run, "Yellow contract disappeared before reconciliation.")
          const currentChain = Database.use((db) => chain(db, run))
          const outcome = currentChain.outcomeIds.length
            ? Database.use((db) =>
                validatedOutcome(db, currentChain.outcomeIds[currentChain.outcomeIds.length - 1]!)
              )
            : undefined
          if (!outcome && run.dispatched_at && Date.now() - run.dispatched_at >= contractValue.outcomeDeadlineMs)
            return yield* failRun(run, "Outcome Signal deadline expired.")
          if (!outcome) return
          if (currentChain.actualCost > contractValue.costLimit.maximum)
            return yield* failRun(
              run,
              `Actual cost ${currentChain.actualCost} ${contractValue.costLimit.unit} exceeded limit ${contractValue.costLimit.maximum}.`,
            )
          if (outcome.result !== "succeeded")
            return yield* failRun(run, `Outcome Signal result is ${outcome.result}.`)
          yield* Effect.sync(() =>
            Database.transaction((db) => {
              db.update(FounderYellowRunTable)
                .set({
                  status: "completed",
                  work_item_ids_json: JSON.stringify(currentChain.workItemIds),
                  receipt_ids_json: JSON.stringify(currentChain.receiptIds),
                  outcome_ids_json: JSON.stringify(currentChain.outcomeIds),
                  actual_cost: currentChain.actualCost,
                  fail_closed_reasons_json: "[]",
                  updated_at: Date.now(),
                })
                .where(eq(FounderYellowRunTable.id, run.id))
                .run()
              event(db, {
                companyId: run.company_id,
                runId: run.id,
                decisionId: run.decision_id,
                idempotencyKey: `yellow-outcome:${run.id}:${outcome.id}`,
                type: "outcome_recorded",
                actor: { kind: "control_plane", id: "company-outcome-signal" },
                data: {
                  outcomeId: outcome.id,
                  result: outcome.result,
                  actualCost: currentChain.actualCost,
                  costUnit: contractValue.costLimit.unit,
                },
              })
            }, { behavior: "immediate" }),
          )
          if (!circuitOpen(run.company_id) && !fenced(run.company_id, run.board_thread_id))
            yield* orchestrator.resumeDispatch(run.project_id, `Yellow Outcome validated for ${run.id}`)
        }),
      { concurrency: 1, discard: true })
      return runs.map((run) => run.id)
    })

    const drain = Effect.fn("FounderYellowDelegation.drain")(function* (
      outboxId: string,
    ) {
      const prepared = Database.transaction((db) => {
        const outbox = db
          .select()
          .from(FounderYellowDispatchOutboxTable)
          .where(eq(FounderYellowDispatchOutboxTable.id, outboxId))
          .get()
        if (!outbox) return
        const run = db
          .select()
          .from(FounderYellowRunTable)
          .where(eq(FounderYellowRunTable.id, outbox.run_id))
          .get()
        if (!run) return
        if (outbox.decision_dispatch_outbox_id)
          return { outbox, run, decisionDispatchOutboxId: outbox.decision_dispatch_outbox_id }
        const projection = db
          .select()
          .from(DecisionCurrentProjectionTable)
          .where(eq(DecisionCurrentProjectionTable.decision_id, run.decision_id))
            .get()
        const decision = db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, run.decision_id)).get()
        if (!decision) return
        const currentDecision = recordFromRow(db, decision)
        const transition = projection?.current_status === "proposed"
          ? appendDecisionTransitionInTransaction(db, run.decision_id, {
              schemaVersion: 1,
              idempotencyKey: `yellow:${run.id}:accepted`,
              toStatus: "accepted",
              kind: "accepted",
              reason: "Recovered Yellow authorization and rollback checkpoint.",
              actorId: "board-ceo",
              finalDecision:
                currentDecision.recommendation ?? "Yellow authorization and rollback checkpoint accepted.",
            })
          : null
        const decisionDispatch = appendDecisionDispatchInTransaction(db, {
          companyId: run.company_id,
          decisionId: run.decision_id,
          transitionId: transition?.id ?? null,
          consumer: `founder_yellow_delegation:${run.id}`,
          actionType: run.action_type,
          payload: {
            runId: run.id,
            projectId: run.project_id,
            receiptId: run.receipt_id,
            checkpointId: run.checkpoint_id,
          },
          idempotencyKey: `yellow:${run.id}:recovered-dispatch`,
        })
        db.update(FounderYellowDispatchOutboxTable)
          .set({ decision_dispatch_outbox_id: decisionDispatch.id, updated_at: Date.now() })
          .where(eq(FounderYellowDispatchOutboxTable.id, outbox.id))
          .run()
        return {
          outbox: { ...outbox, decision_dispatch_outbox_id: decisionDispatch.id },
          run,
          decisionDispatchOutboxId: decisionDispatch.id,
        }
      }, { behavior: "immediate" })
      if (!prepared) return
      const outbox = prepared.outbox
      const run = prepared.run
      const decisionDispatch = (yield* ledger.dispatches(run.decision_id))
        .find((item) => item.id === prepared.decisionDispatchOutboxId)
      if (!decisionDispatch) throw new Error("Yellow dispatch projection is missing its Decision Ledger outbox")
      if (decisionDispatch.currentStatus === "completed") {
        const recoveredStatus =
          decisionDispatch.executionReceipt?.startsWith("yellow_failed_") ? "failed" : "processed"
        if (outbox.status === "pending")
          yield* Effect.sync(() =>
            Database.use((db) =>
              db.update(FounderYellowDispatchOutboxTable)
                .set({
                  status: recoveredStatus,
                  updated_at: Date.now(),
                })
                .where(eq(FounderYellowDispatchOutboxTable.id, outbox.id))
                .run()
            ),
          )
        const decision = yield* ledger.get(run.decision_id)
        if (recoveredStatus === "processed" && decision.currentStatus === "accepted")
          yield* ledger.appendTransition(run.decision_id, {
            schemaVersion: 1,
            idempotencyKey: `yellow:${run.id}:executed`,
            toStatus: "executed",
            kind: "executed",
            reason: "Recovered completed Yellow dispatch from the durable Decision outbox.",
            actorId: "board-ceo",
            finalDecision: decision.finalDecision ?? "Recovered completed Yellow dispatch.",
          })
        if (recoveredStatus === "failed" && decision.currentStatus === "accepted")
          yield* ledger.appendTransition(run.decision_id, {
            schemaVersion: 1,
            idempotencyKey: `yellow:${run.id}:failed`,
            toStatus: "failed",
            kind: "failed",
            reason: "Recovered terminal Yellow dispatch failure from the durable Decision outbox.",
            actorId: "board-ceo",
            finalDecision: decision.finalDecision ?? "Recovered terminal Yellow dispatch failure.",
          })
        return
      }
      const consumerId = `yellow_worker_${run.id}`
      const claimed = yield* ledger.claimDispatch({
        consumer: decisionDispatch.consumer,
        consumerId,
        leaseDurationMs: 300_000,
      })
      if (!claimed || claimed.id !== decisionDispatch.id || !claimed.leaseToken) return
      const completeFailure = (reason: string) =>
        Effect.gen(function* () {
          yield* failRun(run, reason)
          const decision = yield* ledger.get(run.decision_id)
          if (decision.currentStatus === "accepted")
            yield* ledger.appendTransition(run.decision_id, {
              schemaVersion: 1,
              idempotencyKey: `yellow:${run.id}:failed`,
              toStatus: "failed",
              kind: "failed",
              reason,
              actorId: "board-ceo",
              finalDecision: decision.finalDecision ?? reason,
            })
          yield* ledger.completeDispatch(claimed.id, {
            consumerId,
            leaseToken: claimed.leaseToken!,
            executionReceipt: `yellow_failed_${run.id}`,
          })
        })
      if (outbox.status === "failed")
        return yield* ledger.completeDispatch(claimed.id, {
          consumerId,
          leaseToken: claimed.leaseToken,
          executionReceipt: `yellow_failed_${run.id}`,
        })
      if (outbox.status === "processed")
        return yield* ledger.completeDispatch(claimed.id, {
          consumerId,
          leaseToken: claimed.leaseToken,
          executionReceipt: `yellow_processed_${run.id}`,
        })
      if (
        circuitOpen(run.company_id)
        || fenced(run.company_id, run.board_thread_id)
        || currentMode(run.company_id).effective.founderTwinMode !== "yellow-delegated"
      )
        return yield* completeFailure("Yellow dispatch was fenced or downgraded before Orchestrator entry.")
      const decision = yield* ledger.get(run.decision_id)
      if (decision.currentStatus !== "accepted")
        return yield* completeFailure(`Decision status ${decision.currentStatus} cannot enter Yellow dispatch.`)
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.update(FounderYellowDispatchOutboxTable)
            .set({ attempts: outbox.attempts + 1, updated_at: Date.now() })
            .where(eq(FounderYellowDispatchOutboxTable.id, outbox.id))
            .run()
          event(db, {
            companyId: run.company_id,
            runId: run.id,
            decisionId: run.decision_id,
            idempotencyKey: `yellow:${run.id}:dispatch-started`,
            type: "dispatch_started",
            actor: { kind: "control_plane", id: "project-orchestrator" },
            data: { outboxId: outbox.id, checkpointId: outbox.checkpoint_id },
          })
        }, { behavior: "immediate" }),
      )
      if (
        circuitOpen(run.company_id)
        || fenced(run.company_id, run.board_thread_id)
        || currentMode(run.company_id).effective.founderTwinMode !== "yellow-delegated"
      )
        return yield* completeFailure("Yellow dispatch was fenced at the final pre-dispatch check.")
      yield* orchestrator.pauseDispatch(run.project_id, `Yellow checkpoint ${run.checkpoint_id}`)
      const result = yield* Effect.exit(orchestrator.processReceipt(run.receipt_id))
      if (Exit.isFailure(result))
        return yield* completeFailure(String(Cause.squash(result.cause)))
      const processing = result.value.processing
      if (processing.status === "disabled")
        return yield* completeFailure("Graph Supervisor did not apply a reversible Yellow mutation.")
      if (processing.decision.status !== "applied" || !processing.mutation_id)
        return yield* completeFailure("Graph Supervisor did not apply a reversible Yellow mutation.")
      const mutationId = processing.mutation_id
      const direction = FounderYellowDelegationInput.shape.direction.parse(JSON.parse(run.direction_json))
      const project = Database.use((db) =>
        db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, run.project_id)).get(),
      )
      if (!project) return yield* completeFailure("Yellow project disappeared before direction apply.")
      const directionResult = yield* Effect.exit(orchestrator.applyFounderDirection({
        project_id: run.project_id,
        idempotency_key: `yellow:${run.id}:direction`,
        expected_revision: project.graph_revision,
        payload: {
          checkpoint_id: run.checkpoint_id!,
          brief_id: direction.briefId,
          expected_brief_version: direction.expectedBriefVersion,
          expected_plan_version: direction.expectedPlanVersion,
          brief: direction.brief,
          change_reason: `Authorized Yellow direction ${run.id}`,
        },
      }))
      if (Exit.isFailure(directionResult) || directionResult.value.action.status !== "applied")
        return yield* completeFailure(
          Exit.isFailure(directionResult)
            ? String(Cause.squash(directionResult.cause))
            : "Checkpointed Yellow direction handler rejected the mutation.",
        )
      const appliedGoal = Database.use((db) =>
        db.select({ goal: CompanyProjectTable.goal }).from(CompanyProjectTable).where(eq(CompanyProjectTable.id, run.project_id)).get(),
      )
      if (appliedGoal?.goal !== direction.brief.goal)
        return yield* completeFailure("Yellow direction handler did not persist the proposed goal.")
      const updatedChain = Database.use((db) =>
        chain(db, {
          ...run,
          graph_decision_id: processing.decision.id,
          mutation_id: mutationId,
        }),
      )
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.update(FounderYellowDispatchOutboxTable)
            .set({ status: "processed", last_error: null, updated_at: Date.now() })
            .where(eq(FounderYellowDispatchOutboxTable.id, outbox.id))
            .run()
          db.update(FounderYellowRunTable)
            .set({
              status: "outcome_pending",
              graph_decision_id: processing.decision.id,
              mutation_id: mutationId,
              work_item_ids_json: JSON.stringify(updatedChain.workItemIds),
              receipt_ids_json: JSON.stringify(updatedChain.receiptIds),
              actual_cost: updatedChain.actualCost,
              dispatched_at: Date.now(),
              fail_closed_reasons_json: JSON.stringify(["Outcome Signal is pending."]),
              updated_at: Date.now(),
            })
            .where(eq(FounderYellowRunTable.id, run.id))
            .run()
          event(db, {
            companyId: run.company_id,
            runId: run.id,
            decisionId: run.decision_id,
            idempotencyKey: `yellow:${run.id}:dispatch-completed`,
            type: "dispatch_completed",
            actor: { kind: "control_plane", id: "graph-supervisor" },
            data: {
              graphDecisionId: processing.decision.id,
              mutationId,
              workItemIds: updatedChain.workItemIds,
              receiptIds: updatedChain.receiptIds,
              actualCost: updatedChain.actualCost,
              directionActionId: directionResult.value.action.id,
            },
          })
        }, { behavior: "immediate" }),
      )
      yield* ledger.completeDispatch(claimed.id, {
        consumerId,
        leaseToken: claimed.leaseToken,
        executionReceipt: mutationId,
      })
      yield* ledger.appendTransition(run.decision_id, {
        schemaVersion: 1,
        idempotencyKey: `yellow:${run.id}:executed`,
        toStatus: "executed",
        kind: "executed",
        reason: "Yellow mutation applied; independent Outcome Signal remains required.",
        actorId: "board-ceo",
        finalDecision: decision.finalDecision ?? "Yellow mutation applied.",
      })
      const refreshed = Database.use((db) =>
        db.select().from(FounderYellowRunTable).where(eq(FounderYellowRunTable.id, run.id)).get()!,
      )
      if (refreshed.actual_cost > refreshed.cost_limit)
        yield* failRun(
          refreshed,
          `Actual cost ${refreshed.actual_cost} ${refreshed.cost_unit} exceeded limit ${refreshed.cost_limit}.`,
        )
    })

    const submit = Effect.fn("FounderYellowDelegation.submit")(function* (
      raw: FounderYellowDelegationInputValue,
    ) {
      const input = FounderYellowDelegationInput.parse(raw)
      const inputSha256 = digest(input)
      const existing = Database.use((db) =>
        db
          .select()
          .from(FounderYellowRunTable)
          .where(and(
            eq(FounderYellowRunTable.company_id, input.companyId),
            eq(FounderYellowRunTable.idempotency_key, input.idempotencyKey),
          ))
          .get(),
      )
      if (existing) {
        if (existing.input_sha256 !== inputSha256)
          throw new Error("Yellow delegation idempotency key has different facts")
        const pending = Database.use((db) =>
          db
            .select()
            .from(FounderYellowDispatchOutboxTable)
            .where(and(
              eq(FounderYellowDispatchOutboxTable.run_id, existing.id),
              eq(FounderYellowDispatchOutboxTable.status, "pending"),
            ))
            .get(),
        )
        if (pending) yield* drain(pending.id)
        yield* reconcile(input.companyId)
        return Database.use((db) =>
          yellowSummaryFromRow(
            db,
            db.select().from(FounderYellowRunTable).where(eq(FounderYellowRunTable.id, existing.id)).get()!,
          ),
        )
      }
      const contractValue = contract(input.actionType)
      const decision = yield* ledger.get(input.decisionId)
      const receipt = Database.use((db) =>
        db.select().from(CompanyWorkReceiptTable).where(eq(CompanyWorkReceiptTable.id, input.receiptId)).get(),
      )
      if (!contractValue) {
        const verdict = yield* governance.submit({
          schemaVersion: 1,
          idempotencyKey: `yellow-red:${inputSha256}`,
          decisionId: input.decisionId,
          actionType: input.actionType,
          proposedAuthorityClass: "red",
          evidenceSufficient: Boolean(decision.evidenceRefs?.length),
          requestedBy: input.requestedBy,
        })
        return saveBlocked(
          input,
          inputSha256,
          ["Action has no deterministic Yellow contract and was routed to red Governance."],
          verdict.gate?.id ?? verdict.authority.policyId,
        )
      }
      const currentReadiness = readiness(input.companyId)
      if (currentReadiness.value.status !== "confirmed")
        downgradeInvalidYellowReadiness(input.companyId, currentReadiness.id)
      const reasons = [
        ...(currentReadiness.value.status === "confirmed" ? [] : currentReadiness.value.failClosedReasons),
        ...(currentMode(input.companyId).effective.founderTwinMode === "yellow-delegated"
          ? []
          : ["Effective Founder Twin mode is not yellow-delegated."]),
        ...(circuitOpen(input.companyId) ? ["Yellow circuit breaker is open."] : []),
        ...(fenced(input.companyId, input.boardThreadId) ? ["Human intervention fence is active."] : []),
        ...(input.estimatedCost.unit === contractValue.costLimit.unit
          && input.estimatedCost.amount <= contractValue.costLimit.maximum
          ? []
          : ["Estimated cost exceeds the deterministic Yellow contract."]),
        ...(decision.scope.type === "project"
          && decision.scope.companyId === input.companyId
          && decision.scope.projectId === input.projectId
          ? []
          : ["Decision is outside the requested project scope."]),
        ...(decision.source?.boardThreadId === input.boardThreadId
          ? []
          : ["Decision is not bound to the requested Board Thread."]),
        ...(decision.decisionMaker === "ai_founder" && decision.decisionMakerId === "board-ceo"
          ? []
          : ["Yellow delegation requires a board-ceo AI Founder decision."]),
        ...(decision.recordOrigin === "live"
          ? []
          : ["Historical DecisionRecords cannot enter Yellow delegation."]),
        ...(["proposed", "accepted"].includes(decision.currentStatus)
          ? []
          : [`Decision status ${decision.currentStatus} cannot enter Yellow dispatch.`]),
        ...(decision.authorityClass === "yellow"
          && decision.reversible === true
          && decision.externalImpact === false
          && decision.riskLevel === "medium"
          ? []
          : ["Decision Yellow facts are missing, irreversible, externally impactful, or unknown."]),
        ...(!receipt || receipt.project_id !== input.projectId ? ["A matching project Work Receipt is required."] : []),
        ...directionPreflight(input),
      ]
      if (reasons.length) return saveBlocked(input, inputSha256, reasons)
      const runId = Identifier.create("fyrun", "ascending")
      const checkpointId = Identifier.create("fycp", "ascending")
      const outboxId = Identifier.create("fyout", "ascending")
      const checkpointSnapshot = Database.use((db) => snapshot(db, input.projectId))
      const prepared = Database.transaction((db) => {
        const verdict = submitGovernanceInTransaction(db, {
          schemaVersion: 1,
          idempotencyKey: `yellow-governance:${inputSha256}`,
          decisionId: input.decisionId,
          actionType: input.actionType,
          proposedAuthorityClass: "yellow",
          evidenceSufficient: Boolean(decision.evidenceRefs?.length),
          requestedBy: input.requestedBy,
        })
        if (
          !verdict.dispatchAllowed
          || verdict.gate
          || verdict.authority.authorityClass !== "yellow"
          || !verdict.authority.allowed
        )
          return { prepared: false as const, verdict }
        const projection = db
          .select()
          .from(DecisionCurrentProjectionTable)
          .where(eq(DecisionCurrentProjectionTable.decision_id, input.decisionId))
          .get()
        if (!projection || !["proposed", "accepted"].includes(projection.current_status))
          return { prepared: false as const, verdict }
        const transition = projection.current_status === "proposed"
          ? appendDecisionTransitionInTransaction(db, input.decisionId, {
              schemaVersion: 1,
              idempotencyKey: `yellow:${runId}:accepted`,
              toStatus: "accepted",
              kind: "accepted",
              reason: "Yellow Governance authorization and rollback checkpoint persisted.",
              actorId: "board-ceo",
              finalDecision: decision.recommendation ?? "Yellow delegation authorized.",
            })
          : null
        const decisionDispatch = appendDecisionDispatchInTransaction(db, {
          companyId: input.companyId,
          decisionId: input.decisionId,
          transitionId: transition?.id ?? null,
          consumer: `founder_yellow_delegation:${runId}`,
          actionType: input.actionType,
          payload: {
            runId,
            projectId: input.projectId,
            receiptId: input.receiptId,
            checkpointId,
          },
          idempotencyKey: `yellow:${input.idempotencyKey}:dispatch`,
        })
        const now = Date.now()
        db.insert(FounderYellowCheckpointTable)
          .values({
            id: checkpointId,
            company_id: input.companyId,
            project_id: input.projectId,
            decision_id: input.decisionId,
            receipt_id: input.receiptId,
            action_type: input.actionType,
            direction_json: JSON.stringify(input.direction),
            rollback_handler_id: contractValue.rollbackHandlerId,
            snapshot_json: JSON.stringify(checkpointSnapshot),
            snapshot_sha256: digest(checkpointSnapshot),
            created_at: now,
          })
          .run()
        db.insert(FounderYellowRunTable)
          .values({
            id: runId,
            company_id: input.companyId,
            idempotency_key: input.idempotencyKey,
            input_sha256: inputSha256,
            project_id: input.projectId,
            board_thread_id: input.boardThreadId,
            decision_id: input.decisionId,
            receipt_id: input.receiptId,
            action_type: input.actionType,
            direction_json: JSON.stringify(input.direction),
            status: "authorized",
            readiness_id: currentReadiness.id,
            checkpoint_id: checkpointId,
            governance_ref: verdict.authority.policyId,
            graph_decision_id: null,
            mutation_id: null,
            work_item_ids_json: "[]",
            receipt_ids_json: JSON.stringify([input.receiptId]),
            outcome_ids_json: "[]",
            cost_unit: contractValue.costLimit.unit,
            cost_limit: contractValue.costLimit.maximum,
            estimated_cost: input.estimatedCost.amount,
            actual_cost: 0,
            rollback_handler_id: contractValue.rollbackHandlerId,
            dispatched_at: null,
            fail_closed_reasons_json: "[]",
            created_at: now,
            updated_at: now,
          })
          .run()
        db.insert(FounderYellowDispatchOutboxTable)
          .values({
            id: outboxId,
            company_id: input.companyId,
            run_id: runId,
            decision_dispatch_outbox_id: decisionDispatch.id,
            decision_id: input.decisionId,
            receipt_id: input.receiptId,
            checkpoint_id: checkpointId,
            status: "pending",
            attempts: 0,
            last_error: null,
            created_at: now,
            updated_at: now,
          })
          .run()
        event(db, {
          companyId: input.companyId,
          runId,
          decisionId: input.decisionId,
          idempotencyKey: `${input.idempotencyKey}:checkpoint`,
          type: "checkpoint_recorded",
          actor: { kind: "control_plane", id: "yellow-checkpoint" },
          data: {
            checkpointId,
            snapshotSha256: digest(checkpointSnapshot),
            rollbackHandlerId: contractValue.rollbackHandlerId,
          },
        })
        event(db, {
          companyId: input.companyId,
          runId,
          decisionId: input.decisionId,
          idempotencyKey: `${input.idempotencyKey}:authorized`,
          type: "authorized",
          actor: input.requestedBy,
          data: {
            governanceRef: verdict.authority.policyId,
            outboxId,
            decisionDispatchOutboxId: decisionDispatch.id,
            contract: contractValue,
          },
        })
        return { prepared: true as const, verdict, outboxId }
      }, { behavior: "immediate" })
      if (!prepared.prepared)
        return saveBlocked(
          input,
          inputSha256,
          ["Governance did not authorize deterministic Yellow dispatch."],
          prepared.verdict.gate?.id ?? prepared.verdict.authority.policyId,
        )
      yield* drain(prepared.outboxId)
      yield* reconcile(input.companyId)
      return Database.use((db) =>
        yellowSummaryFromRow(
          db,
          db.select().from(FounderYellowRunTable).where(eq(FounderYellowRunTable.id, runId)).get()!,
        ),
      )
    })

    const recover = Effect.fn("FounderYellowDelegation.recover")(function* () {
      const recoverable = Database.use((db) =>
        db
          .select()
          .from(FounderYellowDispatchOutboxTable)
          .where(inArray(FounderYellowDispatchOutboxTable.status, ["pending", "processed", "failed"]))
          .orderBy(asc(FounderYellowDispatchOutboxTable.created_at), asc(FounderYellowDispatchOutboxTable.id))
          .all(),
      )
      yield* Effect.forEach(recoverable, (item) => drain(item.id), { concurrency: 1, discard: true })
      const readinessCompanies = Database.use((db) =>
        [...new Set(
          db
            .select({ companyId: FounderYellowReadinessTable.company_id })
            .from(FounderYellowReadinessTable)
            .all()
            .map((row) => row.companyId),
        )],
      )
      readinessCompanies.map((companyId) => {
        const current = readiness(companyId)
        if (current.value.status !== "confirmed")
          downgradeInvalidYellowReadiness(companyId, current.id)
      })
      return {
        pendingOutboxIds: recoverable.filter((item) => item.status === "pending").map((item) => item.id),
        reconciledRunIds: yield* reconcile(),
      }
    })

    const projection = Effect.fn("FounderYellowDelegation.projection")(function* (companyId: string) {
      yield* reconcile(companyId)
      const currentReadiness = readiness(companyId)
      if (currentReadiness.value.status !== "confirmed")
        downgradeInvalidYellowReadiness(companyId, currentReadiness.id)
      const state = currentMode(companyId)
      const open = circuitOpen(companyId)
      return FounderYellowDelegationProjection.parse({
        schemaVersion: 1,
        companyId,
        readiness: currentReadiness.value,
        mode: state,
        effectiveDelegationMode: open
          ? greenReady(companyId)
            ? "green-delegated"
            : "advisor"
          : state.effective.founderTwinMode === "yellow-delegated"
            ? "yellow-delegated"
            : state.effective.founderTwinMode === "green-delegated"
              ? "green-delegated"
              : "advisor",
        contracts: FounderYellowDelegationAction.options.map((actionType) =>
          FounderYellowActionContract.parse(FounderYellowActionContracts[actionType])
        ),
        redInvariants,
        circuitBreakerOpen: open,
        outcomeConsumer: {
          baseline: "v1",
          validatedOutcomeRequired: true,
        },
        summaries: Database.use((db) =>
          db
            .select()
            .from(FounderYellowRunTable)
            .where(eq(FounderYellowRunTable.company_id, companyId))
            .orderBy(desc(FounderYellowRunTable.created_at), desc(FounderYellowRunTable.id))
            .limit(100)
            .all()
            .map((run) => yellowSummaryFromRow(db, run)),
        ),
        autoPromotionAllowed: false,
      })
    })

    return Service.of({
      submit,
      projection,
      rollback,
      recover,
      recordReadiness: (input) =>
        Effect.try({ try: () => recordReadiness(input), catch: (error) => error }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Layer.mergeAll(
    governanceLayer,
    decisionLedgerLayer,
    ProjectActionExecutor.defaultLayer,
    ProjectOrchestrator.defaultLayer,
  )),
)

export * as FounderYellowDelegation from "./yellow"
