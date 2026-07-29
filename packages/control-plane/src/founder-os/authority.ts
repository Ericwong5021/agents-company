import { createHash } from "node:crypto"
import {
  DecisionAuthorityEvaluation,
  DecisionAuthorityInput,
  DecisionCenterActionInput,
  DecisionCenterProjection,
  DecisionScope,
  DelegationPolicy,
  FounderApprovalGate,
  FounderAuthorityClass,
  FounderCorrectionAppendInput,
  FounderCorrectionRecord,
  GovernanceDecision,
  GovernanceRequest,
  type DecisionAuthorityEvaluation as DecisionAuthorityEvaluationValue,
  type DecisionCenterActionInput as DecisionCenterActionInputValue,
  type DecisionScope as DecisionScopeValue,
  type FounderApprovalActorKind,
  type FounderCorrectionAppendInput as FounderCorrectionAppendInputValue,
  type GovernanceRequest as GovernanceRequestValue,
} from "@agents-company/shared/founder-os"
import { Context, Effect, Layer } from "effect"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import z from "zod"
import { ApprovalPolicyTable, CompanyTable } from "@/company/company.sql"
import { CompanyID } from "@/company/schema"
import {
  CompanyApprovalGateTable,
  CompanyOutcomeSignalCurrentTable,
  CompanyOutcomeSignalTable,
} from "@/company-project/company-project.sql"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import type { TxOrDb } from "@/storage/db"
import {
  DecisionCurrentProjectionTable,
  DecisionRecordTable,
  DecisionTransitionTable,
  DelegationPolicyTable,
  FounderCorrectionTable,
  FounderGovernanceEventTable,
} from "./decision-ledger.sql"
import { ensureDefaultPolicies, recordFromRow } from "./decision-ledger"
import { GovernanceAssetSelectionTable, GovernanceAssetTable } from "./asset.sql"
import * as FounderOSMode from "./mode"
import * as FounderOSAsset from "./asset"
import { yellowSummaryForDecision } from "./yellow-projection"
import { FounderYellowEventTable, FounderYellowRunTable } from "./yellow.sql"

const authorityRank = { green: 0, yellow: 1, red: 2 } as const
const modeRank = { off: -1, shadow: -1, advisor: -1, "green-delegated": 0, "yellow-delegated": 1 } as const
const allowedModeRank = { advisor: -1, green_delegated: 0, yellow_delegated: 1, none: 2 } as const
const allowedTransitions = {
  unknown: ["awaiting_approval", "accepted", "failed"],
  proposed: ["awaiting_approval", "accepted", "overridden", "failed"],
  awaiting_approval: ["accepted", "overridden", "failed"],
  accepted: ["executed", "overridden", "failed"],
  executed: ["overridden", "failed", "rolled_back"],
  overridden: ["rolled_back"],
  failed: [],
  rolled_back: [],
} as const
const hardRedActions = new Set([
  "external.communication.propose",
  "external.payment.propose",
  "production.operation.propose",
  "data.delete.propose",
  "privacy.change.propose",
  "security.change.propose",
  "child_safety.change.propose",
  "strategy.fundamental_change.propose",
  "constitution.change.propose",
])
const ConstitutionBoundary = z
  .object({
    schemaVersion: z.literal(1),
    allowedActionTypes: z.array(z.string().trim().min(1)).max(500),
    deniedActionTypes: z.array(z.string().trim().min(1)).max(500),
  })
  .strict()
  .refine((value) =>
    !value.allowedActionTypes.some((actionType) => value.deniedActionTypes.includes(actionType)),
  )

function maxAuthority(...values: FounderAuthorityClass[]) {
  return values.reduce((current, value) => authorityRank[value] > authorityRank[current] ? value : current)
}

function policyFromRow(row: typeof DelegationPolicyTable.$inferSelect) {
  const scope = row.scope_type === "project"
    ? { type: "project" as const, companyId: row.company_id, projectId: row.project_id! }
    : row.scope_type === "pre_project"
      ? { type: "pre_project" as const, companyId: row.company_id, preProjectId: row.pre_project_id! }
      : { type: "company" as const, companyId: row.company_id }
  return DelegationPolicy.parse({
    schemaVersion: 1,
    id: row.id,
    actionType: row.action_type,
    riskLevel: row.risk_level,
    reversible: row.reversible,
    externalImpact: row.external_impact,
    budgetLimit: row.budget_limit_json ? JSON.parse(row.budget_limit_json) : null,
    requiresApproval: row.requires_approval,
    allowedMode: row.allowed_mode,
    version: row.version,
    scope,
    createdAt: row.created_at,
  })
}

function policyFor(db: TxOrDb, scope: DecisionScopeValue, actionType: string) {
  ensureDefaultPolicies(db, scope.companyId)
  const rows = db
    .select()
    .from(DelegationPolicyTable)
    .where(
      and(
        eq(DelegationPolicyTable.company_id, scope.companyId),
        inArray(DelegationPolicyTable.action_type, [actionType, "*"]),
      ),
    )
    .orderBy(desc(DelegationPolicyTable.version), asc(DelegationPolicyTable.action_type))
    .all()
  const matchesScope = (row: typeof DelegationPolicyTable.$inferSelect) => {
    if (scope.type === "project") return row.scope_type === "project" && row.project_id === scope.projectId
    if (scope.type === "pre_project") return row.scope_type === "pre_project" && row.pre_project_id === scope.preProjectId
    return row.scope_type === "company"
  }
  return policyFromRow(
    rows.find((row) => row.action_type === actionType && matchesScope(row)) ??
      rows.find((row) => row.action_type === "*" && matchesScope(row)) ??
      rows.find((row) => row.action_type === actionType && row.scope_type === "company") ??
      rows.find((row) => row.action_type === "*" && row.scope_type === "company")!,
  )
}

function constitutionFor(db: TxOrDb, companyId: string, actionType: string) {
  const selected = db
    .select()
    .from(GovernanceAssetSelectionTable)
    .where(eq(GovernanceAssetSelectionTable.company_id, companyId))
    .orderBy(desc(GovernanceAssetSelectionTable.created_at), desc(GovernanceAssetSelectionTable.id))
    .all()
    .filter((selection, index, selections) =>
      selections.findIndex((candidate) => candidate.asset_id === selection.asset_id) === index
    )
    .map((selection) =>
      db
        .select()
        .from(GovernanceAssetTable)
        .where(and(
          eq(GovernanceAssetTable.id, selection.asset_id),
          eq(GovernanceAssetTable.version, selection.asset_version),
          eq(GovernanceAssetTable.company_id, companyId),
          eq(GovernanceAssetTable.type, "constitution"),
          eq(GovernanceAssetTable.scope_kind, "company"),
          eq(GovernanceAssetTable.status, "active"),
        ))
        .get(),
    )
    .filter((asset): asset is typeof GovernanceAssetTable.$inferSelect =>
      Boolean(asset && ["human_explicit", "human_confirmed"].includes(asset.authority)),
    )
  if (selected.length !== 1)
    return {
      status: "missing" as const,
      ref: selected.length ? "constitution:ambiguous" : "constitution:missing",
    }
  const content = (() => {
    try {
      return JSON.parse(selected[0].content)
    } catch {
      return undefined
    }
  })()
  const boundary = ConstitutionBoundary.safeParse(content)
  if (!boundary.success)
    return {
      status: "missing" as const,
      ref: `${selected[0].id}@${selected[0].version}:invalid`,
    }
  if (
    boundary.data.deniedActionTypes.includes("*")
    || boundary.data.deniedActionTypes.includes(actionType)
  )
    return {
      status: "deny" as const,
      ref: `${selected[0].id}@${selected[0].version}`,
    }
  return {
    status:
      boundary.data.allowedActionTypes.includes("*")
      || boundary.data.allowedActionTypes.includes(actionType)
        ? "allow" as const
        : "missing" as const,
    ref: `${selected[0].id}@${selected[0].version}`,
  }
}

function evaluateInTransaction(db: TxOrDb, raw: z.input<typeof DecisionAuthorityInput>) {
  const input = DecisionAuthorityInput.parse(raw)
  const row = db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, input.decisionId)).get()
  if (!row) throw new Error("Governance requests require an existing DecisionRecord")
  const decision = recordFromRow(db, row)
  const policy = policyFor(db, decision.scope, input.actionType)
  const constitution = constitutionFor(db, decision.scope.companyId, input.actionType)
  const facts = [
    input.proposedAuthorityClass,
    policy.riskLevel,
    policy.actionType === input.actionType ? "green" : "red",
    constitution.status === "allow" ? "green" : "red",
    hardRedActions.has(input.actionType) ? "red" : "green",
    decision.authorityClass ?? "red",
    !input.evidenceSufficient || !decision.evidenceRefs?.length ? "red" : "green",
    decision.externalImpact === null ? "red" : decision.externalImpact ? "red" : "green",
    decision.reversible === null ? "red" : decision.reversible ? "green" : "yellow",
    decision.riskLevel === null
      ? "red"
      : decision.riskLevel === "critical" || decision.riskLevel === "high"
        ? "red"
        : decision.riskLevel === "medium"
          ? "yellow"
          : "green",
    input.approvalPreset === "strict" ? "yellow" : "green",
  ] satisfies FounderAuthorityClass[]
  const authorityClass = maxAuthority(...facts)
  const requiresApproval = authorityClass === "red" || policy.requiresApproval
  const allowedByMode =
    authorityClass !== "red" &&
    modeRank[input.requestedMode] >= authorityRank[authorityClass] &&
    modeRank[input.requestedMode] >= allowedModeRank[policy.allowedMode]
  return DecisionAuthorityEvaluation.parse({
    schemaVersion: 1,
    decisionId: decision.id,
    authorityClass,
    policyId: policy.id,
    requiresApproval,
    allowed: allowedByMode && !requiresApproval,
    reasons: [
      `action:${input.actionType}`,
      `policy:${policy.riskLevel}`,
      `constitution:${constitution.status}:${constitution.ref}`,
      `preset:${input.approvalPreset}`,
      `mode:${input.requestedMode}`,
      ...(!input.evidenceSufficient || !decision.evidenceRefs?.length ? ["evidence:insufficient"] : []),
      ...(decision.externalImpact === null ? ["external_impact:unknown"] : decision.externalImpact ? ["external_impact:true"] : []),
    ],
  })
}

function scopeColumns(scope: DecisionScopeValue) {
  if (scope.type === "project")
    return { company_id: scope.companyId, scope_type: scope.type, project_id: scope.projectId, pre_project_id: null }
  if (scope.type === "pre_project")
    return { company_id: scope.companyId, scope_type: scope.type, project_id: null, pre_project_id: scope.preProjectId }
  return { company_id: scope.companyId, scope_type: scope.type, project_id: null, pre_project_id: null }
}

function scopeKey(scope: DecisionScopeValue) {
  if (scope.type === "project") return `project:${scope.projectId}`
  if (scope.type === "pre_project") return `pre_project:${scope.preProjectId}`
  return "company"
}

function governanceEvent(
  db: TxOrDb,
  input: {
    scope: DecisionScopeValue
    decisionId: string
    gateId?: string
    type: string
    actor: { kind: FounderApprovalActorKind; id: string }
    data: Record<string, unknown>
  },
) {
  db.insert(FounderGovernanceEventTable)
    .values({
      id: Identifier.create("fgev", "ascending"),
      company_id: input.scope.companyId,
      scope_type: input.scope.type,
      scope_key: scopeKey(input.scope),
      decision_id: input.decisionId,
      gate_id: input.gateId ?? null,
      type: input.type,
      actor_kind: input.actor.kind,
      actor_id: input.actor.id,
      data_json: JSON.stringify(input.data),
      created_at: Date.now(),
    })
    .run()
}

function scopeFromGate(row: typeof CompanyApprovalGateTable.$inferSelect) {
  return DecisionScope.parse(
    row.scope_type === "project"
      ? { type: "project", companyId: row.company_id, projectId: row.project_id }
      : row.scope_type === "pre_project"
        ? { type: "pre_project", companyId: row.company_id, preProjectId: row.pre_project_id }
        : { type: "company", companyId: row.company_id },
  )
}

function gateFromRow(row: typeof CompanyApprovalGateTable.$inferSelect) {
  return FounderApprovalGate.parse({
    id: row.id,
    scope: scopeFromGate(row),
    decisionId: row.decision_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    summary: row.summary,
    requestedBy: {
      kind: row.requested_by_actor_kind,
      id: row.requested_by_actor_id,
    },
    decisionNote: row.decision_note,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
  })
}

function transition(
  db: TxOrDb,
  input: {
    decisionId: string
    idempotencyKey: string
    toStatus: "awaiting_approval" | "accepted" | "failed" | "overridden" | "rolled_back"
    kind: "submitted_for_approval" | "accepted" | "failed" | "overridden" | "rolled_back"
    reason: string
    actorId: string
  },
) {
  const projection = db
    .select()
    .from(DecisionCurrentProjectionTable)
    .where(eq(DecisionCurrentProjectionTable.decision_id, input.decisionId))
    .get()
  if (!projection) throw new Error("Decision projection was not found")
  const existing = db
    .select()
    .from(DecisionTransitionTable)
    .where(
      and(
        eq(DecisionTransitionTable.decision_id, input.decisionId),
        eq(DecisionTransitionTable.idempotency_key, input.idempotencyKey),
      ),
    )
    .get()
  if (existing) return
  if (!(allowedTransitions[projection.current_status as keyof typeof allowedTransitions] ?? []).includes(input.toStatus as never))
    throw new Error(`Illegal decision transition from ${projection.current_status} to ${input.toStatus}`)
  const id = Identifier.ascending("founderDecisionTransition")
  const now = Date.now()
  db.insert(DecisionTransitionTable)
    .values({
      id,
      decision_id: input.decisionId,
      sequence: projection.transition_count + 1,
      idempotency_key: input.idempotencyKey,
      input_sha256: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      from_status: projection.current_status,
      to_status: input.toStatus,
      kind: input.kind,
      reason: input.reason,
      actor_id: input.actorId,
      created_at: now,
    })
    .run()
  db.update(DecisionCurrentProjectionTable)
    .set({
      current_status: input.toStatus,
      latest_transition_id: id,
      transition_count: projection.transition_count + 1,
      updated_at: now,
    })
    .where(eq(DecisionCurrentProjectionTable.decision_id, input.decisionId))
    .run()
}

function correctionFromRow(row: typeof FounderCorrectionTable.$inferSelect) {
  return FounderCorrectionRecord.parse({
    schemaVersion: 1,
    id: row.id,
    decisionId: row.decision_id,
    kind: row.kind,
    originalDecision: row.original_decision,
    humanDecision: row.human_decision,
    reason: row.reason,
    proposedAssetUpdates: JSON.parse(row.proposed_asset_updates_json),
    actorKind: "human",
    actorId: row.actor_id,
    createdAt: row.created_at,
  })
}

export interface DecisionAuthorityInterface {
  readonly evaluate: (
    input: z.input<typeof DecisionAuthorityInput>,
  ) => Effect.Effect<DecisionAuthorityEvaluationValue, unknown>
}

export class DecisionAuthorityService extends Context.Service<
  DecisionAuthorityService,
  DecisionAuthorityInterface
>()("@control-plane/DecisionAuthorityService") {}

export interface DelegationPolicyInterface {
  readonly resolve: (scope: DecisionScopeValue, actionType: string) => Effect.Effect<DelegationPolicy, unknown>
}

export class DelegationPolicyService extends Context.Service<
  DelegationPolicyService,
  DelegationPolicyInterface
>()("@control-plane/DelegationPolicyService") {}

export interface GovernanceInterface {
  readonly submit: (input: GovernanceRequestValue) => Effect.Effect<GovernanceDecision, unknown>
  readonly resolveGate: (input: {
    gateId: string
    decision: "approve" | "reject"
    note: string
    actor: { kind: FounderApprovalActorKind; id: string }
  }) => Effect.Effect<GovernanceDecision, unknown>
}

export class GovernanceService extends Context.Service<GovernanceService, GovernanceInterface>()(
  "@control-plane/GovernanceService",
) {}

export interface FounderCorrectionInterface {
  readonly append: (input: FounderCorrectionAppendInputValue) => Effect.Effect<FounderCorrectionRecord, unknown>
}

export class FounderCorrectionService extends Context.Service<
  FounderCorrectionService,
  FounderCorrectionInterface
>()("@control-plane/FounderCorrectionService") {}

export interface DecisionCenterInterface {
  readonly projection: (companyId: string) => Effect.Effect<DecisionCenterProjection, unknown>
  readonly action: (
    decisionId: string,
    input: DecisionCenterActionInputValue,
  ) => Effect.Effect<DecisionCenterProjection, unknown>
}

export class DecisionCenterService extends Context.Service<DecisionCenterService, DecisionCenterInterface>()(
  "@control-plane/DecisionCenterService",
) {}

function decisionCenterProjection(db: TxOrDb, companyId: string) {
  const items = db
    .select()
    .from(DecisionRecordTable)
    .where(eq(DecisionRecordTable.company_id, companyId))
    .orderBy(desc(DecisionRecordTable.created_at), desc(DecisionRecordTable.id))
    .all()
    .map((row) => {
      const decision = recordFromRow(db, row)
      const gate = db
        .select()
        .from(CompanyApprovalGateTable)
        .where(eq(CompanyApprovalGateTable.decision_id, decision.id))
        .orderBy(desc(CompanyApprovalGateTable.requested_at))
        .get()
      const corrections = db
        .select()
        .from(FounderCorrectionTable)
        .where(eq(FounderCorrectionTable.decision_id, decision.id))
        .orderBy(asc(FounderCorrectionTable.created_at), asc(FounderCorrectionTable.id))
        .all()
        .map(correctionFromRow)
      const outcomes = db
        .select()
        .from(CompanyOutcomeSignalTable)
        .innerJoin(
          CompanyOutcomeSignalCurrentTable,
          eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, CompanyOutcomeSignalTable.id),
        )
        .where(
          and(
            eq(CompanyOutcomeSignalTable.decision_id, decision.id),
            eq(CompanyOutcomeSignalCurrentTable.current_status, "validated"),
          ),
        )
        .orderBy(asc(CompanyOutcomeSignalTable.observed_at), asc(CompanyOutcomeSignalTable.id))
        .all()
        .map((row) => ({
          id: row.company_outcome_signal.id,
          result: row.company_outcome_signal.result,
          summary: row.company_outcome_signal.summary,
          observedAt: row.company_outcome_signal.observed_at,
        }))
      return {
        decision,
        sourceLabel: decision.decisionMaker,
        gate: gate?.kind === "founder_red" ? gateFromRow(gate) : null,
        corrections,
        outcomes,
        yellowSummary: yellowSummaryForDecision(db, decision.id),
      }
    })
  return DecisionCenterProjection.parse({
    schemaVersion: 1,
    companyId,
    pending: items.filter((item) => ["proposed", "awaiting_approval"].includes(item.decision.currentStatus)),
    delegated: items.filter((item) => item.decision.decisionMaker === "ai_founder"),
    executed: items.filter((item) => item.decision.currentStatus === "executed"),
    overridden: items.filter((item) => item.decision.currentStatus === "overridden" || item.corrections.length > 0),
    withOutcomes: items.filter((item) => item.outcomes.length > 0),
  })
}

export const decisionAuthorityLayer = Layer.succeed(
  DecisionAuthorityService,
  DecisionAuthorityService.of({
    evaluate: (input) => Effect.try({ try: () => Database.use((db) => evaluateInTransaction(db, input)), catch: (error) => error }),
  }),
)

export const delegationPolicyLayer = Layer.succeed(
  DelegationPolicyService,
  DelegationPolicyService.of({
    resolve: (scope, actionType) =>
      Effect.try({ try: () => Database.use((db) => policyFor(db, DecisionScope.parse(scope), actionType)), catch: (error) => error }),
  }),
)

export function submitGovernanceInTransaction(db: TxOrDb, raw: GovernanceRequestValue) {
  const input = GovernanceRequest.parse(raw)
  const row = db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, input.decisionId)).get()
  if (!row) throw new Error("Governance requests require an existing DecisionRecord")
  const decision = recordFromRow(db, row)
  const companyID = CompanyID.parse(decision.scope.companyId)
  const company = db.select().from(CompanyTable).where(eq(CompanyTable.id, companyID)).get()
  const preset = db
    .select()
    .from(ApprovalPolicyTable)
    .where(eq(ApprovalPolicyTable.company_id, companyID))
    .get()
  if (!company || !preset) throw new Error("Company governance settings were not found")
  const authority = evaluateInTransaction(db, {
    decisionId: decision.id,
    actionType: input.actionType,
    proposedAuthorityClass: input.proposedAuthorityClass,
    evidenceSufficient: input.evidenceSufficient,
    requestedMode: FounderOSMode.resolve({
      founderTwinMode: company.founder_twin_mode,
      companyCommonsMode: company.company_commons_mode,
    }).effective.founderTwinMode,
    approvalPreset: preset.preset,
  })
  if (!authority.requiresApproval)
    return GovernanceDecision.parse({
      schemaVersion: 1,
      decision,
      authority,
      gate: null,
      dispatchAllowed: authority.allowed,
    })
  const existing = db
    .select()
    .from(CompanyApprovalGateTable)
    .where(eq(CompanyApprovalGateTable.decision_id, decision.id))
    .orderBy(desc(CompanyApprovalGateTable.requested_at))
    .get()
  const gate = existing ?? {
    id: Identifier.ascending("gate"),
    ...scopeColumns(decision.scope),
    decision_id: decision.id,
    kind: "founder_red",
    status: "pending",
    title: decision.subject ?? "Founder OS red decision",
    summary: decision.recommendation ?? decision.context ?? "Red decision requires explicit approval.",
    requested_by_agent_id: null,
    requested_by_actor_kind: input.requestedBy.kind,
    requested_by_actor_id: input.requestedBy.id,
    work_item_id: null,
    resource_scope_json: "[]",
    worktree_run_id: null,
    decision_note: null,
    requested_at: Date.now(),
    decided_at: null,
  }
  if (!existing) {
    db.insert(CompanyApprovalGateTable).values(gate).run()
    governanceEvent(db, {
      scope: decision.scope,
      decisionId: decision.id,
      gateId: gate.id,
      type: "approval_gate.requested",
      actor: input.requestedBy,
      data: {
        authorityClass: authority.authorityClass,
        actionType: input.actionType,
        proposedAuthorityClass: input.proposedAuthorityClass,
        evidenceSufficient: input.evidenceSufficient,
      },
    })
    if (decision.currentStatus === "proposed")
      transition(db, {
        decisionId: decision.id,
        idempotencyKey: `${input.idempotencyKey}:awaiting`,
        toStatus: "awaiting_approval",
        kind: "submitted_for_approval",
        reason: "Deterministic authority evaluation classified the decision as red.",
        actorId: input.requestedBy.id,
      })
  }
  return GovernanceDecision.parse({
    schemaVersion: 1,
    decision: recordFromRow(db, row),
    authority,
    gate: gateFromRow(gate),
    dispatchAllowed:
      existing?.status === "approved"
      && decision.currentStatus === "accepted"
      && authority.allowed,
  })
}

export const governanceLayer = Layer.succeed(
  GovernanceService,
  GovernanceService.of({
    submit: (raw) =>
      Effect.try({
        try: () =>
          Database.transaction(
            (db) => submitGovernanceInTransaction(db, raw),
            { behavior: "immediate" },
          ),
        catch: (error) => error,
      }),
    resolveGate: (input) =>
      Effect.try({
        try: () =>
          Database.transaction(
            (db) => {
              if (input.actor.kind !== "human") throw new Error("Red approval requires a human actor")
              const gate = db
                .select()
                .from(CompanyApprovalGateTable)
                .where(eq(CompanyApprovalGateTable.id, input.gateId))
                .get()
              if (!gate || gate.kind !== "founder_red" || !gate.decision_id)
                throw new Error("Founder approval gate was not found")
              if (gate.status !== "pending") throw new Error("Founder approval gate is already resolved")
              const now = Date.now()
              db.update(CompanyApprovalGateTable)
                .set({
                  status: input.decision === "approve" ? "approved" : "rejected",
                  decision_note: input.note,
                  decided_at: now,
                })
                .where(and(eq(CompanyApprovalGateTable.id, gate.id), eq(CompanyApprovalGateTable.status, "pending")))
                .run()
              const row = db
                .select()
                .from(DecisionRecordTable)
                .where(eq(DecisionRecordTable.id, gate.decision_id!))
                .get()!
              const before = recordFromRow(db, row)
              const requestEvent = db
                .select()
                .from(FounderGovernanceEventTable)
                .where(and(
                  eq(FounderGovernanceEventTable.gate_id, gate.id),
                  eq(FounderGovernanceEventTable.type, "approval_gate.requested"),
                ))
                .orderBy(desc(FounderGovernanceEventTable.created_at))
                .get()
              const requestFacts = requestEvent
                ? z
                    .object({
                      actionType: z.string().trim().min(1),
                      proposedAuthorityClass: FounderAuthorityClass,
                      evidenceSufficient: z.boolean(),
                    })
                    .safeParse(JSON.parse(requestEvent.data_json))
                : undefined
              if (!requestFacts?.success)
                throw new Error("ApprovalGate is missing its original deterministic governance facts")
              const company = db.select().from(CompanyTable).where(eq(CompanyTable.id, before.scope.companyId)).get()
              const preset = db
                .select()
                .from(ApprovalPolicyTable)
                .where(eq(ApprovalPolicyTable.company_id, before.scope.companyId))
                .get()
              if (!company || !preset) throw new Error("Company governance settings were not found")
              if (input.decision === "reject" || before.currentStatus !== "accepted")
                transition(db, {
                  decisionId: gate.decision_id,
                  idempotencyKey: `founder-gate:${gate.id}:${input.decision}`,
                  toStatus: input.decision === "approve" ? "accepted" : "failed",
                  kind: input.decision === "approve" ? "accepted" : "failed",
                  reason: input.note,
                  actorId: input.actor.id,
                })
              governanceEvent(db, {
                scope: before.scope,
                decisionId: before.id,
                gateId: gate.id,
                type: "approval_gate.resolved",
                actor: input.actor,
                data: {
                  decision: input.decision,
                  note: input.note,
                  actionType: requestFacts.data.actionType,
                  proposedAuthorityClass: requestFacts.data.proposedAuthorityClass,
                  evidenceSufficient: requestFacts.data.evidenceSufficient,
                },
              })
              const decision = recordFromRow(db, row)
              const authority = evaluateInTransaction(db, {
                decisionId: decision.id,
                actionType: requestFacts.data.actionType,
                proposedAuthorityClass: requestFacts.data.proposedAuthorityClass,
                evidenceSufficient: requestFacts.data.evidenceSufficient,
                requestedMode: FounderOSMode.resolve({
                  founderTwinMode: company.founder_twin_mode,
                  companyCommonsMode: company.company_commons_mode,
                }).effective.founderTwinMode,
                approvalPreset: preset.preset,
              })
              return GovernanceDecision.parse({
                schemaVersion: 1,
                decision,
                authority,
                gate: gateFromRow({
                  ...gate,
                  status: input.decision === "approve" ? "approved" : "rejected",
                  decision_note: input.note,
                  decided_at: now,
                }),
                dispatchAllowed: input.decision === "approve" && authority.allowed,
              })
            },
            { behavior: "immediate" },
          ),
        catch: (error) => error,
      }),
  }),
)

export const founderCorrectionLayer = Layer.succeed(
  FounderCorrectionService,
  FounderCorrectionService.of({
    append: (raw) =>
      Effect.try({
        try: () =>
          Database.transaction(
            (db) => {
              const input = FounderCorrectionAppendInput.parse(raw)
              const decision = db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, input.decisionId)).get()
              if (!decision) throw new Error("Correction requires an existing DecisionRecord")
              const existing = db
                .select()
                .from(FounderCorrectionTable)
                .where(
                  and(
                    eq(FounderCorrectionTable.company_id, decision.company_id),
                    eq(FounderCorrectionTable.idempotency_key, input.idempotencyKey),
                  ),
                )
                .get()
              if (existing) {
                if (
                  existing.decision_id !== input.decisionId ||
                  existing.kind !== input.kind ||
                  existing.human_decision !== input.humanDecision ||
                  existing.reason !== input.reason ||
                  existing.proposed_asset_updates_json !== JSON.stringify(input.proposedAssetUpdates) ||
                  existing.actor_id !== input.actorId
                )
                  throw new Error("Correction idempotency key has different facts")
                FounderOSAsset.materializeCorrectionProposals(db, {
                  companyId: decision.company_id,
                  decisionId: decision.id,
                  correctionId: existing.id,
                  proposals: input.proposedAssetUpdates,
                })
                return correctionFromRow(existing)
              }
              const row = {
                id: Identifier.create("fcorr", "ascending"),
                company_id: decision.company_id,
                decision_id: decision.id,
                idempotency_key: input.idempotencyKey,
                kind: input.kind,
                original_decision: decision.final_decision,
                human_decision: input.humanDecision,
                reason: input.reason,
                proposed_asset_updates_json: JSON.stringify(input.proposedAssetUpdates),
                actor_id: input.actorId,
                created_at: Date.now(),
              }
              db.insert(FounderCorrectionTable).values(row).run()
              FounderOSAsset.materializeCorrectionProposals(db, {
                companyId: decision.company_id,
                decisionId: decision.id,
                correctionId: row.id,
                proposals: input.proposedAssetUpdates,
              })
              if (input.kind === "override")
                transition(db, {
                  decisionId: decision.id,
                  idempotencyKey: `${input.idempotencyKey}:override`,
                  toStatus: "overridden",
                  kind: "overridden",
                  reason: input.reason,
                  actorId: input.actorId,
                })
              if (input.kind === "override") {
                const yellowRun = db
                  .select()
                  .from(FounderYellowRunTable)
                  .where(eq(FounderYellowRunTable.decision_id, decision.id))
                  .orderBy(desc(FounderYellowRunTable.created_at), desc(FounderYellowRunTable.id))
                  .get()
                if (yellowRun)
                  db
                    .insert(FounderYellowEventTable)
                    .values({
                      id: Identifier.create("fyevt", "ascending"),
                      company_id: decision.company_id,
                      run_id: yellowRun.id,
                      decision_id: decision.id,
                      idempotency_key: `${input.idempotencyKey}:yellow-override`,
                      type: "override_recorded",
                      actor_kind: "human",
                      actor_id: input.actorId,
                      data_json: JSON.stringify({
                        correctionId: row.id,
                        reason: input.reason,
                      }),
                      created_at: row.created_at,
                    })
                    .onConflictDoNothing()
                    .run()
              }
              return correctionFromRow(row)
            },
            { behavior: "immediate" },
          ),
        catch: (error) => error,
      }),
  }),
)

export const decisionCenterLayer = Layer.succeed(
  DecisionCenterService,
  DecisionCenterService.of({
    projection: (companyId) =>
      Effect.try({
        try: () => Database.use((db) => decisionCenterProjection(db, z.string().trim().min(1).parse(companyId))),
        catch: (error) => error,
      }),
    action: (decisionId, raw) =>
      Effect.try({
        try: () =>
          Database.transaction(
            (db) => {
              const input = DecisionCenterActionInput.parse(raw)
              const decision = db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, decisionId)).get()
              if (!decision) throw new Error("DecisionRecord was not found")
              if (
                input.action === "accept" &&
                (
                  decision.authority_class === "red" ||
                  decision.authority_class === null ||
                  decision.external_impact !== false ||
                  decision.reversible === null ||
                  decision.risk_level === null ||
                  ["high", "critical"].includes(decision.risk_level) ||
                  !decision.evidence_refs_json ||
                  !z.array(z.unknown()).parse(JSON.parse(decision.evidence_refs_json)).length
                )
              ) {
                const gate = db
                  .select()
                  .from(CompanyApprovalGateTable)
                  .where(
                    and(
                      eq(CompanyApprovalGateTable.decision_id, decisionId),
                      eq(CompanyApprovalGateTable.kind, "founder_red"),
                      eq(CompanyApprovalGateTable.status, "approved"),
                    ),
                  )
                  .get()
                if (!gate) throw new Error("Red decisions require an approved ApprovalGate")
              }
              const target = input.action === "accept" ? "accepted" : input.action === "reject" ? "failed" : "rolled_back"
              transition(db, {
                decisionId,
                idempotencyKey: input.idempotencyKey,
                toStatus: target,
                kind: target,
                reason: input.reason,
                actorId: input.actorId,
              })
              return decisionCenterProjection(db, decision.company_id)
            },
            { behavior: "immediate" },
          ),
        catch: (error) => error,
      }),
  }),
)

export const defaultLayers = [
  decisionAuthorityLayer,
  delegationPolicyLayer,
  governanceLayer,
  founderCorrectionLayer,
  decisionCenterLayer,
] as const
