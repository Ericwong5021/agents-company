import { createHash } from "node:crypto"
import {
  DecisionRecord,
  DecisionRecordAppendInput,
  DecisionDispatchAuthorizeInput,
  DecisionDispatchClaimInput,
  DecisionDispatchEvent,
  DecisionDispatchOutbox,
  DecisionDispatchResolveInput,
  DecisionScope,
  DecisionSourceMapping,
  DecisionStatus,
  DecisionTransition,
  DecisionTransitionAppendInput,
  DelegationPolicy,
  FounderAssetReference,
  FounderEvidenceReference,
  FounderGreenDelegationAction,
  FounderTwinSnapshotReference,
  type DecisionMaker,
  type DecisionOperatingMode,
  type DecisionRecordOrigin,
  type DecisionRiskLevel,
  type DecisionScope as DecisionScopeValue,
  type DecisionSourceMapping as DecisionSourceMappingValue,
  type DecisionStatus as DecisionStatusValue,
  type FounderAuthorityClass,
  type FounderAssetReference as FounderAssetReferenceValue,
  type FounderEvidenceReference as FounderEvidenceReferenceValue,
  type FounderTwinSnapshotReference as FounderTwinSnapshotReferenceValue,
} from "@agents-company/shared/founder-os"
import { NamedError } from "@agents-company/shared/util/error"
import { Context, Effect, Layer } from "effect"
import { and, asc, eq, lte, or } from "drizzle-orm"
import z from "zod"
import {
  ChannelMessageTable,
  ChannelTable,
  ConversationRunTable,
  ConversationThreadTable,
  RootNeedTable,
  SignalProjectionSourceTable,
  SignalProjectionTable,
} from "@/conversation/conversation.sql"
import {
  ChannelID,
  ChannelMessageID,
  ConversationRunID,
  ConversationThreadID,
  RootNeedID,
  SignalProjectionID,
} from "@/conversation/schema"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import type { TxOrDb } from "@/storage/db"
import {
  DecisionCurrentProjectionTable,
  DecisionDispatchCurrentTable,
  DecisionDispatchEventTable,
  DecisionDispatchOutboxTable,
  DecisionRecordTable,
  DecisionSourceMappingTable,
  DecisionTransitionTable,
  DelegationPolicyTable,
} from "./decision-ledger.sql"

export const DecisionLedgerNotFound = NamedError.create(
  "DecisionLedgerNotFound",
  z.object({ decision_id: z.string() }).strict(),
)

export const DecisionLedgerIdempotencyConflict = NamedError.create(
  "DecisionLedgerIdempotencyConflict",
  z.object({ idempotency_key: z.string() }).strict(),
)

export const DecisionLedgerIllegalTransition = NamedError.create(
  "DecisionLedgerIllegalTransition",
  z
    .object({
      decision_id: z.string(),
      from_status: DecisionStatus,
      to_status: DecisionStatus,
    })
    .strict(),
)

export const DecisionLedgerCorrupt = NamedError.create(
  "DecisionLedgerCorrupt",
  z.object({ decision_id: z.string() }).strict(),
)

type AppendCommand = {
  id?: string
  idempotencyKey: string
  recordOrigin: DecisionRecordOrigin
  scope: DecisionScopeValue
  source: DecisionSourceMappingValue | null
  founderTwinSnapshot: FounderTwinSnapshotReferenceValue | null
  subject: string | null
  context: string | null
  options: string[] | null
  recommendation: string | null
  finalDecision: string | null
  decisionMaker: DecisionMaker
  decisionMakerId: string
  authorityClass: FounderAuthorityClass | null
  operatingMode: DecisionOperatingMode | null
  confidence: number | null
  reversible: boolean | null
  externalImpact: boolean | null
  riskLevel: DecisionRiskLevel | null
  evidenceRefs: FounderEvidenceReferenceValue[] | null
  principleRefs: FounderAssetReferenceValue[] | null
  decisionCaseRefs: FounderAssetReferenceValue[] | null
  initialStatus: DecisionStatusValue
  initialTransitionKind: "created" | "historical_imported" | "submitted_for_approval" | "accepted"
  initialReason: string
  overrideOf: string | null
  createdAt: number
  decidedAt: number | null
  decidedAtIdempotencyValue?: number | "server_time" | null
}

type BoardDecisionInput = {
  companyId: string
  projectId: string
  preProjectId?: string
  channelId: string
  channelMessageId: string
  boardThreadId: string
  boardRunId?: string
  runtimeId?: string
  rootNeedId: string
  requestId: string
  decisionMakerId: string
  subject?: string
  context?: string
  finalDecision: string
  riskLevel?: DecisionRiskLevel
  evidenceRefs?: FounderEvidenceReferenceValue[]
  createdAt: number
}

export const decisionTransitions: Record<DecisionStatusValue, readonly DecisionStatusValue[]> = {
  unknown: ["proposed", "awaiting_approval", "accepted", "failed"],
  proposed: ["awaiting_approval", "accepted", "overridden", "failed"],
  awaiting_approval: ["accepted", "overridden", "failed"],
  accepted: ["executed", "overridden", "failed"],
  executed: ["overridden", "failed", "rolled_back"],
  overridden: ["rolled_back"],
  failed: [],
  rolled_back: [],
}

export const decisionTransitionStatus = {
  submitted_for_approval: "awaiting_approval",
  accepted: "accepted",
  executed: "executed",
  overridden: "overridden",
  failed: "failed",
  rolled_back: "rolled_back",
} as const

const policyDefaults = [
  {
    key: "internal_option",
    actionType: "governance.review.request",
    riskLevel: "green",
    reversible: true,
    externalImpact: false,
    budgetLimit: { unit: "request", maximum: 1 },
    requiresApproval: false,
    allowedMode: "green_delegated",
  },
  ...FounderGreenDelegationAction.options.map((actionType) => ({
    key: actionType.replaceAll(".", "_"),
    actionType,
    riskLevel: "green" as const,
    reversible: true,
    externalImpact: false,
    budgetLimit: { unit: "receipt", maximum: 1 },
    requiresApproval: false,
    allowedMode: "green_delegated" as const,
  })),
  {
    key: "project_goal",
    actionType: "project.goal.propose",
    riskLevel: "yellow",
    reversible: true,
    externalImpact: false,
    budgetLimit: { unit: "receipt", maximum: 1 },
    requiresApproval: false,
    allowedMode: "yellow_delegated",
  },
  {
    key: "staffing",
    actionType: "organization.staffing.propose",
    riskLevel: "red",
    reversible: false,
    externalImpact: false,
    budgetLimit: null,
    requiresApproval: true,
    allowedMode: "none",
  },
  ...[
    "external.communication.propose",
    "external.payment.propose",
    "production.operation.propose",
    "data.delete.propose",
    "privacy.change.propose",
    "security.change.propose",
    "child_safety.change.propose",
    "strategy.fundamental_change.propose",
    "constitution.change.propose",
    "*",
  ].map((actionType) => ({
    key: actionType.replaceAll(".", "_").replace("*", "unknown"),
    actionType,
    riskLevel: "red" as const,
    reversible: false,
    externalImpact: true,
    budgetLimit: null,
    requiresApproval: true,
    allowedMode: "none" as const,
  })),
] as const

function sha256(input: unknown) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex")
}

function json<T>(schema: z.ZodType<T>, value: string | null) {
  if (value === null) return null
  return schema.parse(JSON.parse(value))
}

function scopeColumns(scope: DecisionScopeValue) {
  if (scope.type === "project")
    return { scope_type: scope.type, project_id: scope.projectId, pre_project_id: null }
  if (scope.type === "pre_project")
    return { scope_type: scope.type, project_id: null, pre_project_id: scope.preProjectId }
  return { scope_type: scope.type, project_id: null, pre_project_id: null }
}

function scopeFromRow(row: {
  company_id: string
  scope_type: string
  project_id: string | null
  pre_project_id: string | null
}) {
  if (row.scope_type === "project")
    return DecisionScope.parse({ type: row.scope_type, companyId: row.company_id, projectId: row.project_id })
  if (row.scope_type === "pre_project")
    return DecisionScope.parse({ type: row.scope_type, companyId: row.company_id, preProjectId: row.pre_project_id })
  return DecisionScope.parse({ type: row.scope_type, companyId: row.company_id })
}

function sourceFromRow(row: typeof DecisionSourceMappingTable.$inferSelect | undefined) {
  if (!row) return null
  return DecisionSourceMapping.parse({
    channelMessageId: row.channel_message_id,
    boardThreadId: row.board_thread_id,
    boardRunId: row.board_run_id,
    runtimeId: row.runtime_id,
    sourceCompleteness: row.source_completeness,
  })
}

export function recordFromRow(db: TxOrDb, row: typeof DecisionRecordTable.$inferSelect) {
  const projection = db
    .select()
    .from(DecisionCurrentProjectionTable)
    .where(eq(DecisionCurrentProjectionTable.decision_id, row.id))
    .get()
  if (!projection) throw new DecisionLedgerCorrupt({ decision_id: row.id })
  return DecisionRecord.parse({
    schemaVersion: 1,
    id: row.id,
    scope: scopeFromRow(row),
    source: sourceFromRow(
      db.select().from(DecisionSourceMappingTable).where(eq(DecisionSourceMappingTable.decision_id, row.id)).get(),
    ),
    founderTwinSnapshot:
      row.founder_snapshot_id && row.founder_snapshot_version
        ? FounderTwinSnapshotReference.parse({ id: row.founder_snapshot_id, version: row.founder_snapshot_version })
        : null,
    subject: row.subject,
    context: row.context,
    options: json(z.array(z.string()), row.options_json),
    recommendation: row.recommendation,
    finalDecision: projection.final_decision,
    recordOrigin: row.record_origin,
    decisionMaker: row.decision_maker,
    decisionMakerId: row.decision_maker_id,
    authorityClass: row.authority_class,
    operatingMode: row.operating_mode,
    confidence: row.confidence,
    reversible: row.reversible,
    externalImpact: row.external_impact,
    riskLevel: row.risk_level,
    evidenceRefs: json(z.array(FounderEvidenceReference), row.evidence_refs_json),
    principleRefs: json(z.array(FounderAssetReference), row.principle_refs_json),
    decisionCaseRefs: json(z.array(FounderAssetReference), row.decision_case_refs_json),
    currentStatus: projection.current_status,
    overrideOf: row.override_of,
    outcomeRefIds: json(z.array(z.string()), projection.outcome_ref_ids_json) ?? [],
    transitionCount: projection.transition_count,
    createdAt: row.created_at,
    decidedAt: projection.decided_at,
    updatedAt: projection.updated_at,
  })
}

function transitionFromRow(row: typeof DecisionTransitionTable.$inferSelect) {
  return DecisionTransition.parse({
    schemaVersion: 1,
    id: row.id,
    decisionId: row.decision_id,
    sequence: row.sequence,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    kind: row.kind,
    reason: row.reason,
    actorId: row.actor_id,
    finalDecision: row.final_decision,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  })
}

function dispatchFromRow(db: TxOrDb, row: typeof DecisionDispatchOutboxTable.$inferSelect) {
  const current = db
    .select()
    .from(DecisionDispatchCurrentTable)
    .where(eq(DecisionDispatchCurrentTable.outbox_id, row.id))
    .get()
  if (!current) throw new DecisionLedgerCorrupt({ decision_id: row.decision_id })
  return DecisionDispatchOutbox.parse({
    schemaVersion: 1,
    id: row.id,
    companyId: row.company_id,
    decisionId: row.decision_id,
    transitionId: row.transition_id,
    consumer: row.consumer,
    actionType: row.action_type,
    payload: JSON.parse(row.payload_json),
    idempotencyKey: row.idempotency_key,
    executionKey: row.execution_key,
    currentStatus: current.current_status,
    eventCount: current.event_count,
    consumerId: current.consumer_id,
    leaseToken: current.lease_token,
    leaseExpiresAt: current.lease_expires_at,
    executionReceipt: current.execution_receipt,
    lastError: current.last_error,
    createdAt: row.created_at,
    updatedAt: current.updated_at,
  })
}

function dispatchEventFromRow(row: typeof DecisionDispatchEventTable.$inferSelect) {
  return DecisionDispatchEvent.parse({
    schemaVersion: 1,
    id: row.id,
    outboxId: row.outbox_id,
    sequence: row.sequence,
    status: row.status,
    consumerId: row.consumer_id,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    executionReceipt: row.execution_receipt,
    error: row.error,
    createdAt: row.created_at,
  })
}

export function appendDecisionTransitionInTransaction(
  db: TxOrDb,
  decisionId: string,
  raw: z.input<typeof DecisionTransitionAppendInput>,
) {
  const parsed = DecisionTransitionAppendInput.parse(raw)
  const createdAt = Date.now()
  const record = db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, decisionId)).get()
  if (!record) throw new DecisionLedgerNotFound({ decision_id: decisionId })
  const projection = db
    .select()
    .from(DecisionCurrentProjectionTable)
    .where(eq(DecisionCurrentProjectionTable.decision_id, decisionId))
    .get()
  if (!projection) throw new DecisionLedgerCorrupt({ decision_id: decisionId })
  if (
    parsed.toStatus !== "awaiting_approval" &&
    parsed.toStatus !== "overridden" &&
    projection.final_decision &&
    parsed.finalDecision !== projection.final_decision
  )
    throw new Error("Decision finalization is immutable outside an explicit override")
  const input = {
    ...parsed,
    finalDecision:
      parsed.toStatus === "awaiting_approval"
        ? null
        : parsed.toStatus !== "overridden" && projection.final_decision
          ? projection.final_decision
          : parsed.finalDecision,
    decidedAt:
      parsed.toStatus === "awaiting_approval"
        ? null
        : parsed.toStatus !== "overridden" && projection.decided_at
          ? projection.decided_at
          : parsed.decidedAt ?? createdAt,
  }
  const inputSha256 = sha256({
    ...input,
    decidedAt:
      parsed.toStatus === "awaiting_approval"
        ? null
        : parsed.decidedAt ?? "server_time",
  })
  const existing = db
    .select()
    .from(DecisionTransitionTable)
    .where(
      and(
        eq(DecisionTransitionTable.decision_id, decisionId),
        eq(DecisionTransitionTable.idempotency_key, input.idempotencyKey),
      ),
    )
    .get()
  if (existing) {
    if (existing.input_sha256 === inputSha256) return transitionFromRow(existing)
    throw new DecisionLedgerIdempotencyConflict({ idempotency_key: input.idempotencyKey })
  }
  const fromStatus = DecisionStatus.parse(projection.current_status)
  if (
    decisionTransitionStatus[input.kind] !== input.toStatus ||
    !decisionTransitions[fromStatus].includes(input.toStatus)
  )
    throw new DecisionLedgerIllegalTransition({
      decision_id: decisionId,
      from_status: fromStatus,
      to_status: input.toStatus,
    })
  const id = Identifier.ascending("founderDecisionTransition")
  db.insert(DecisionTransitionTable)
    .values({
      id,
      decision_id: decisionId,
      sequence: projection.transition_count + 1,
      idempotency_key: input.idempotencyKey,
      input_sha256: inputSha256,
      from_status: fromStatus,
      to_status: input.toStatus,
      kind: input.kind,
      reason: input.reason,
      actor_id: input.actorId,
      final_decision: input.finalDecision,
      decided_at: input.decidedAt,
      created_at: createdAt,
    })
    .run()
  const updated = db
    .update(DecisionCurrentProjectionTable)
    .set({
      current_status: input.toStatus,
      latest_transition_id: id,
      transition_count: projection.transition_count + 1,
      final_decision: input.finalDecision,
      decided_at: input.decidedAt,
      updated_at: createdAt,
    })
    .where(
      and(
        eq(DecisionCurrentProjectionTable.decision_id, decisionId),
        eq(DecisionCurrentProjectionTable.latest_transition_id, projection.latest_transition_id),
      ),
    )
    .run()
  if (updated.changes !== 1) throw new DecisionLedgerCorrupt({ decision_id: decisionId })
  const transition = db.select().from(DecisionTransitionTable).where(eq(DecisionTransitionTable.id, id)).get()
  if (!transition) throw new DecisionLedgerCorrupt({ decision_id: decisionId })
  return transitionFromRow(transition)
}

function appendDispatchEvent(
  db: TxOrDb,
  input: {
    outboxId: string
    idempotencyKey: string
    status: "committed" | "claimed" | "completed" | "failed"
    consumerId?: string | null
    leaseToken?: string | null
    leaseExpiresAt?: number | null
    executionReceipt?: string | null
    error?: string | null
  },
) {
  const current = db
    .select()
    .from(DecisionDispatchCurrentTable)
    .where(eq(DecisionDispatchCurrentTable.outbox_id, input.outboxId))
    .get()
  const existing = db
    .select()
    .from(DecisionDispatchEventTable)
    .where(
      and(
        eq(DecisionDispatchEventTable.outbox_id, input.outboxId),
        eq(DecisionDispatchEventTable.idempotency_key, input.idempotencyKey),
      ),
    )
    .get()
  if (existing) {
    if (
      existing.status === input.status &&
      existing.consumer_id === (input.consumerId ?? null) &&
      existing.lease_token === (input.leaseToken ?? null) &&
      existing.lease_expires_at === (input.leaseExpiresAt ?? null) &&
      existing.execution_receipt === (input.executionReceipt ?? null) &&
      existing.error === (input.error ?? null)
    )
      return existing
    throw new DecisionLedgerIdempotencyConflict({ idempotency_key: input.idempotencyKey })
  }
  const id = `fdoe_${Identifier.ascending("event")}`
  const createdAt = Date.now()
  const sequence = (current?.event_count ?? 0) + 1
  db.insert(DecisionDispatchEventTable)
    .values({
      id,
      outbox_id: input.outboxId,
      sequence,
      idempotency_key: input.idempotencyKey,
      status: input.status,
      consumer_id: input.consumerId ?? null,
      lease_token: input.leaseToken ?? null,
      lease_expires_at: input.leaseExpiresAt ?? null,
      execution_receipt: input.executionReceipt ?? null,
      error: input.error ?? null,
      created_at: createdAt,
    })
    .run()
  const values = {
    current_status: input.status,
    latest_event_id: id,
    event_count: sequence,
    consumer_id: input.consumerId ?? null,
    lease_token: input.leaseToken ?? null,
    lease_expires_at: input.leaseExpiresAt ?? null,
    execution_receipt: input.executionReceipt ?? current?.execution_receipt ?? null,
    last_error: input.error ?? null,
    updated_at: createdAt,
  }
  if (!current) db.insert(DecisionDispatchCurrentTable).values({ outbox_id: input.outboxId, ...values }).run()
  if (current) {
    const updated = db
      .update(DecisionDispatchCurrentTable)
      .set(values)
      .where(
        and(
          eq(DecisionDispatchCurrentTable.outbox_id, input.outboxId),
          eq(DecisionDispatchCurrentTable.latest_event_id, current.latest_event_id),
        ),
      )
      .run()
    if (updated.changes !== 1)
      throw new DecisionLedgerIdempotencyConflict({ idempotency_key: input.idempotencyKey })
  }
  return db.select().from(DecisionDispatchEventTable).where(eq(DecisionDispatchEventTable.id, id)).get()!
}

export function appendDecisionDispatchInTransaction(
  db: TxOrDb,
  input: {
    companyId: string
    decisionId: string
    transitionId: string | null
    consumer: string
    actionType: string
    payload: Record<string, unknown>
    idempotencyKey: string
  },
) {
  const normalized = {
    ...input,
    payload: z.record(z.string(), z.unknown()).parse(input.payload),
  }
  const inputSha256 = sha256(normalized)
  const existing = db
    .select()
    .from(DecisionDispatchOutboxTable)
    .where(
      and(
        eq(DecisionDispatchOutboxTable.decision_id, input.decisionId),
        eq(DecisionDispatchOutboxTable.idempotency_key, input.idempotencyKey),
      ),
    )
    .get()
  if (existing) {
    if (existing.input_sha256 === inputSha256) return dispatchFromRow(db, existing)
    throw new DecisionLedgerIdempotencyConflict({ idempotency_key: input.idempotencyKey })
  }
  const id = `fdob_${Identifier.ascending("event")}`
  const createdAt = Date.now()
  db.insert(DecisionDispatchOutboxTable)
    .values({
      id,
      company_id: input.companyId,
      decision_id: input.decisionId,
      transition_id: input.transitionId,
      consumer: input.consumer,
      action_type: input.actionType,
      payload_json: JSON.stringify(normalized.payload),
      idempotency_key: input.idempotencyKey,
      input_sha256: inputSha256,
      execution_key: `founder-dispatch:${input.decisionId}:${input.idempotencyKey}`,
      created_at: createdAt,
    })
    .run()
  appendDispatchEvent(db, {
    outboxId: id,
    idempotencyKey: `${input.idempotencyKey}:committed`,
    status: "committed",
  })
  return dispatchFromRow(
    db,
    db.select().from(DecisionDispatchOutboxTable).where(eq(DecisionDispatchOutboxTable.id, id)).get()!,
  )
}

function mappedDecision(db: TxOrDb, channelMessageId: string) {
  const mapping = db
    .select()
    .from(DecisionSourceMappingTable)
    .where(eq(DecisionSourceMappingTable.channel_message_id, channelMessageId))
    .get()
  if (!mapping) return
  const record = db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, mapping.decision_id)).get()
  if (!record) throw new DecisionLedgerCorrupt({ decision_id: mapping.decision_id })
  return recordFromRow(db, record)
}

export function appendDecisionInTransaction(db: TxOrDb, command: AppendCommand) {
  if (command.source?.channelMessageId) {
    const mapped = mappedDecision(db, command.source.channelMessageId)
    if (mapped) return mapped
  }
  const normalized = {
    ...command,
    scope: DecisionScope.parse(command.scope),
    source: command.source ? DecisionSourceMapping.parse(command.source) : null,
    founderTwinSnapshot: command.founderTwinSnapshot
      ? FounderTwinSnapshotReference.parse(command.founderTwinSnapshot)
      : null,
    evidenceRefs: command.evidenceRefs ? command.evidenceRefs.map((item) => FounderEvidenceReference.parse(item)) : null,
    principleRefs: command.principleRefs ? command.principleRefs.map((item) => FounderAssetReference.parse(item)) : null,
    decisionCaseRefs: command.decisionCaseRefs
      ? command.decisionCaseRefs.map((item) => FounderAssetReference.parse(item))
      : null,
  }
  const inputSha256 = sha256({
    ...normalized,
    id: undefined,
    createdAt: undefined,
    decidedAt:
      normalized.initialStatus === "accepted"
        ? normalized.decidedAtIdempotencyValue ?? normalized.decidedAt
        : null,
    decidedAtIdempotencyValue: undefined,
  })
  const existing = db
    .select()
    .from(DecisionRecordTable)
    .where(
      and(
        eq(DecisionRecordTable.company_id, normalized.scope.companyId),
        eq(DecisionRecordTable.idempotency_key, normalized.idempotencyKey),
      ),
    )
    .get()
  if (existing) {
    if (existing.input_sha256 === inputSha256) return recordFromRow(db, existing)
    throw new DecisionLedgerIdempotencyConflict({ idempotency_key: normalized.idempotencyKey })
  }

  const id = normalized.id ?? Identifier.ascending("founderDecision")
  const transitionID = Identifier.ascending("founderDecisionTransition")
  db.insert(DecisionRecordTable)
    .values({
      id,
      company_id: normalized.scope.companyId,
      ...scopeColumns(normalized.scope),
      idempotency_key: normalized.idempotencyKey,
      input_sha256: inputSha256,
      record_origin: normalized.recordOrigin,
      source_completeness: normalized.source?.sourceCompleteness ?? "complete",
      founder_snapshot_id: normalized.founderTwinSnapshot?.id ?? null,
      founder_snapshot_version: normalized.founderTwinSnapshot?.version ?? null,
      subject: normalized.subject,
      context: normalized.context,
      options_json: normalized.options === null ? null : JSON.stringify(normalized.options),
      recommendation: normalized.recommendation,
      final_decision: null,
      decision_maker: normalized.decisionMaker,
      decision_maker_id: normalized.decisionMakerId,
      authority_class: normalized.authorityClass,
      operating_mode: normalized.operatingMode,
      confidence: normalized.confidence,
      reversible: normalized.reversible,
      external_impact: normalized.externalImpact,
      risk_level: normalized.riskLevel,
      evidence_refs_json: normalized.evidenceRefs === null ? null : JSON.stringify(normalized.evidenceRefs),
      principle_refs_json: normalized.principleRefs === null ? null : JSON.stringify(normalized.principleRefs),
      decision_case_refs_json:
        normalized.decisionCaseRefs === null ? null : JSON.stringify(normalized.decisionCaseRefs),
      override_of: normalized.overrideOf,
      created_at: normalized.createdAt,
      decided_at: null,
    })
    .run()
  db.insert(DecisionTransitionTable)
    .values({
      id: transitionID,
      decision_id: id,
      sequence: 1,
      idempotency_key: `${normalized.idempotencyKey}:initial`,
      input_sha256: sha256({
        toStatus: normalized.initialStatus,
        kind: normalized.initialTransitionKind,
        reason: normalized.initialReason,
        actorId: normalized.decisionMakerId,
      }),
      from_status: null,
      to_status: normalized.initialStatus,
      kind: normalized.initialTransitionKind,
      reason: normalized.initialReason,
      actor_id: normalized.decisionMakerId,
      final_decision: normalized.initialStatus === "accepted" ? normalized.finalDecision : null,
      decided_at: normalized.initialStatus === "accepted" ? normalized.decidedAt : null,
      created_at: normalized.createdAt,
    })
    .run()
  db.insert(DecisionCurrentProjectionTable)
    .values({
      decision_id: id,
      current_status: normalized.initialStatus,
      latest_transition_id: transitionID,
      transition_count: 1,
      outcome_ref_ids_json: "[]",
      final_decision: normalized.initialStatus === "accepted" ? normalized.finalDecision : null,
      decided_at: normalized.initialStatus === "accepted" ? normalized.decidedAt : null,
      updated_at: normalized.createdAt,
    })
    .run()
  if (normalized.source)
    db.insert(DecisionSourceMappingTable)
      .values({
        decision_id: id,
        channel_message_id: normalized.source.channelMessageId,
        board_thread_id: normalized.source.boardThreadId,
        board_run_id: normalized.source.boardRunId,
        runtime_id: normalized.source.runtimeId,
        source_completeness: normalized.source.sourceCompleteness,
        created_at: normalized.createdAt,
      })
      .run()
  const record = db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, id)).get()
  if (!record) throw new DecisionLedgerCorrupt({ decision_id: id })
  return recordFromRow(db, record)
}

export function appendBoardDecisionInTransaction(db: TxOrDb, input: BoardDecisionInput) {
  const decision = appendDecisionInTransaction(db, {
    idempotencyKey: `board-channel-message:${input.channelMessageId}`,
    recordOrigin: "live",
    scope: input.preProjectId
      ? { type: "pre_project", companyId: input.companyId, preProjectId: input.preProjectId }
      : { type: "project", companyId: input.companyId, projectId: input.projectId },
    source: {
      channelMessageId: input.channelMessageId,
      boardThreadId: input.boardThreadId,
      boardRunId: input.boardRunId ?? null,
      runtimeId: input.runtimeId ?? null,
      sourceCompleteness: "partial",
    },
    founderTwinSnapshot: null,
    subject: input.subject ?? null,
    context: input.context ?? null,
    options: null,
    recommendation: null,
    finalDecision: input.finalDecision,
    decisionMaker: "board",
    decisionMakerId: input.decisionMakerId,
    authorityClass: null,
    operatingMode: null,
    confidence: null,
    reversible: null,
    externalImpact: null,
    riskLevel: input.riskLevel ?? null,
    evidenceRefs: input.evidenceRefs ?? null,
    principleRefs: null,
    decisionCaseRefs: null,
    initialStatus: "accepted",
    initialTransitionKind: "accepted",
    initialReason: "Board final decision ChannelMessage recorded.",
    overrideOf: null,
    createdAt: input.createdAt,
    decidedAt: input.createdAt,
  })
  appendDecisionDispatchInTransaction(db, {
    companyId: input.companyId,
    decisionId: decision.id,
    transitionId: db
      .select()
      .from(DecisionCurrentProjectionTable)
      .where(eq(DecisionCurrentProjectionTable.decision_id, decision.id))
      .get()!.latest_transition_id,
    consumer: "board_projection",
    actionType: "board.decision.project",
    payload: {
      channelId: input.channelId,
      channelMessageId: input.channelMessageId,
      boardThreadId: input.boardThreadId,
      boardRunId: input.boardRunId ?? null,
      rootNeedId: input.rootNeedId,
      projectId: input.projectId,
      requestId: input.requestId,
      decisionMakerId: input.decisionMakerId,
      body: input.finalDecision,
      createdAt: decision.createdAt,
    },
    idempotencyKey: `board-projection:${input.channelMessageId}`,
  })
  return decision
}

const BoardProjectionPayload = z
  .object({
    channelId: z.string().min(1),
    channelMessageId: z.string().min(1),
    boardThreadId: z.string().min(1),
    boardRunId: z.string().nullable(),
    rootNeedId: z.string().min(1),
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    decisionMakerId: z.string().min(1),
    body: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()

export function reconcileBoardDecisionProjectionsInTransaction(db: TxOrDb) {
  return db
    .select()
    .from(DecisionDispatchOutboxTable)
    .innerJoin(
      DecisionDispatchCurrentTable,
      eq(DecisionDispatchCurrentTable.outbox_id, DecisionDispatchOutboxTable.id),
    )
    .where(
      and(
        eq(DecisionDispatchOutboxTable.consumer, "board_projection"),
        or(
          eq(DecisionDispatchCurrentTable.current_status, "committed"),
          eq(DecisionDispatchCurrentTable.current_status, "failed"),
        ),
      ),
    )
    .orderBy(asc(DecisionDispatchOutboxTable.created_at), asc(DecisionDispatchOutboxTable.id))
    .all()
    .map((joined) => {
      const outbox = joined.founder_decision_dispatch_outbox
      const input = BoardProjectionPayload.parse(JSON.parse(outbox.payload_json))
      const messageID = ChannelMessageID.parse(input.channelMessageId)
      const channelID = ChannelID.parse(input.channelId)
      const threadID = ConversationThreadID.parse(input.boardThreadId)
      const rootNeedID = RootNeedID.parse(input.rootNeedId)
      const runID = input.boardRunId ? ConversationRunID.parse(input.boardRunId) : null
      const existing = db.select().from(ChannelMessageTable).where(eq(ChannelMessageTable.id, messageID)).get()
      if (
        existing &&
        (
          existing.channel_id !== input.channelId ||
          existing.source_thread_id !== input.boardThreadId ||
          existing.root_need_id !== input.rootNeedId ||
          existing.request_id !== input.requestId ||
          existing.body !== input.body ||
          existing.signal_type !== "decision"
        )
      )
        throw new DecisionLedgerIdempotencyConflict({ idempotency_key: outbox.idempotency_key })
      const now = Date.now()
      if (!existing)
        db.insert(ChannelMessageTable)
          .values({
            id: messageID,
            channel_id: channelID,
            root_need_id: rootNeedID,
            source_thread_id: threadID,
            reply_to_id: null,
            request_id: input.requestId,
            author_kind: "agent",
            author_id: input.decisionMakerId,
            body: input.body,
            signal_type: "decision",
            dri_principal_kind: "agent",
            dri_principal_id: input.decisionMakerId,
            visibility: "company",
            mentions: [],
            time_created: input.createdAt,
            time_updated: input.createdAt,
          })
          .run()
      const existingProjection = db
        .select()
        .from(SignalProjectionTable)
        .where(eq(SignalProjectionTable.channel_message_id, messageID))
        .get()
      const projectionID =
        existingProjection?.id ??
        SignalProjectionID.parse(`spr_${sha256(outbox.execution_key).slice(0, 26)}`)
      if (!existingProjection) {
        db.insert(SignalProjectionTable)
          .values({
            id: projectionID,
            channel_message_id: messageID,
            conversation_thread_id: threadID,
            conversation_run_id: runID,
            projector_version: 3,
            source_watermark: `decision-ledger:${outbox.decision_id}`,
            time_created: input.createdAt,
            time_updated: input.createdAt,
          })
          .run()
        db.insert(SignalProjectionSourceTable)
          .values({
            signal_projection_id: projectionID,
            ordinal: 0,
            source_kind: "decision",
            source_id: outbox.decision_id,
            time_created: input.createdAt,
            time_updated: input.createdAt,
          })
          .run()
      }
      db.update(ConversationThreadTable)
        .set({ project_scope_id: input.projectId, status: "completed", time_updated: now })
        .where(eq(ConversationThreadTable.id, threadID))
        .run()
      db.update(RootNeedTable)
        .set({ status: "in_progress", time_updated: now })
        .where(eq(RootNeedTable.id, rootNeedID))
        .run()
      db.update(ChannelTable).set({ time_updated: now }).where(eq(ChannelTable.id, channelID)).run()
      appendDispatchEvent(db, {
        outboxId: outbox.id,
        idempotencyKey: `projection:${outbox.execution_key}:completed`,
        status: "completed",
        consumerId: "decision-projection-reconciler",
        executionReceipt: `projection:${projectionID}`,
      })
      return messageID
    })
}

function recoverHistoricalBoardDecisions(db: TxOrDb) {
  db.select()
    .from(ChannelMessageTable)
    .where(eq(ChannelMessageTable.signal_type, "decision"))
    .all()
    .filter((message) => message.source_thread_id && !mappedDecision(db, message.id))
    .map((message) => {
      const thread = db
        .select()
        .from(ConversationThreadTable)
        .where(eq(ConversationThreadTable.id, message.source_thread_id!))
        .get()
      if (!thread) return
      const channel = db.select().from(ChannelTable).where(eq(ChannelTable.id, message.channel_id)).get()
      if (!channel || channel.kind !== "board") return
      const projection = db
        .select()
        .from(SignalProjectionTable)
        .where(eq(SignalProjectionTable.channel_message_id, message.id))
        .get()
      const run = projection?.conversation_run_id
        ? db
            .select()
            .from(ConversationRunTable)
            .where(eq(ConversationRunTable.id, projection.conversation_run_id))
            .get()
        : undefined
      appendDecisionInTransaction(db, {
        idempotencyKey: `historical-board-channel-message:${message.id}`,
        recordOrigin: "historical_import",
        scope: thread.project_scope_id
          ? { type: "project", companyId: channel.company_id, projectId: thread.project_scope_id }
          : thread.root_need_id
            ? { type: "pre_project", companyId: channel.company_id, preProjectId: thread.root_need_id }
            : { type: "company", companyId: channel.company_id },
        source: {
          channelMessageId: message.id,
          boardThreadId: thread.id,
          boardRunId: run?.id ?? null,
          runtimeId: run?.runtime_id ?? null,
          sourceCompleteness: "partial",
        },
        founderTwinSnapshot: null,
        subject: null,
        context: null,
        options: null,
        recommendation: null,
        finalDecision: null,
        decisionMaker: "unknown",
        decisionMakerId: message.author_id,
        authorityClass: null,
        operatingMode: null,
        confidence: null,
        reversible: null,
        externalImpact: null,
        riskLevel: null,
        evidenceRefs: null,
        principleRefs: null,
        decisionCaseRefs: null,
        initialStatus: "unknown",
        initialTransitionKind: "historical_imported",
        initialReason: "Historical decision ChannelMessage imported without inferred decision fields.",
        overrideOf: null,
        createdAt: message.time_created,
        decidedAt: null,
      })
    })
}

function scopeKey(scope: DecisionScopeValue) {
  if (scope.type === "project") return `project:${scope.projectId}`
  if (scope.type === "pre_project") return `pre_project:${scope.preProjectId}`
  return "company"
}

export function ensureDefaultPolicies(db: TxOrDb, companyId: string) {
  const createdAt = Date.now()
  policyDefaults.map((policy) =>
    db
      .insert(DelegationPolicyTable)
      .values({
        id: `fpol_${companyId}_${policy.key}_v1`,
        company_id: companyId,
        action_type: policy.actionType,
        risk_level: policy.riskLevel,
        reversible: policy.reversible,
        external_impact: policy.externalImpact,
        budget_limit_json: policy.budgetLimit === null ? null : JSON.stringify(policy.budgetLimit),
        requires_approval: policy.requiresApproval,
        allowed_mode: policy.allowedMode,
        version: 1,
        scope_type: "company",
        scope_key: "company",
        project_id: null,
        pre_project_id: null,
        created_at: createdAt,
      })
      .onConflictDoNothing({ target: DelegationPolicyTable.id })
      .run(),
  )
}

function policyFromRow(row: typeof DelegationPolicyTable.$inferSelect) {
  const scope = scopeFromRow(row)
  if (scopeKey(scope) !== row.scope_key) throw new DecisionLedgerCorrupt({ decision_id: row.id })
  return DelegationPolicy.parse({
    schemaVersion: 1,
    id: row.id,
    actionType: row.action_type,
    riskLevel: row.risk_level,
    reversible: row.reversible,
    externalImpact: row.external_impact,
    budgetLimit: json(z.record(z.string(), z.unknown()), row.budget_limit_json),
    requiresApproval: row.requires_approval,
    allowedMode: row.allowed_mode,
    version: row.version,
    scope,
    createdAt: row.created_at,
  })
}

function database<A>(fn: () => A) {
  return Effect.try({ try: fn, catch: (error) => error })
}

export function claimDecisionDispatchInTransaction(
  db: TxOrDb,
  raw: z.input<typeof DecisionDispatchClaimInput>,
) {
  const input = DecisionDispatchClaimInput.parse(raw)
  const now = Date.now()
  const held = db
    .select()
    .from(DecisionDispatchOutboxTable)
    .innerJoin(
      DecisionDispatchCurrentTable,
      eq(DecisionDispatchCurrentTable.outbox_id, DecisionDispatchOutboxTable.id),
    )
    .where(
      and(
        eq(DecisionDispatchOutboxTable.consumer, input.consumer),
        eq(DecisionDispatchCurrentTable.current_status, "claimed"),
        eq(DecisionDispatchCurrentTable.consumer_id, input.consumerId),
      ),
    )
    .get()
  if (held && (held.founder_decision_dispatch_current.lease_expires_at ?? 0) > now)
    return dispatchFromRow(db, held.founder_decision_dispatch_outbox)
  const row = db
    .select()
    .from(DecisionDispatchOutboxTable)
    .innerJoin(
      DecisionDispatchCurrentTable,
      eq(DecisionDispatchCurrentTable.outbox_id, DecisionDispatchOutboxTable.id),
    )
    .where(
      and(
        eq(DecisionDispatchOutboxTable.consumer, input.consumer),
        or(
          eq(DecisionDispatchCurrentTable.current_status, "committed"),
          eq(DecisionDispatchCurrentTable.current_status, "failed"),
          and(
            eq(DecisionDispatchCurrentTable.current_status, "claimed"),
            lte(DecisionDispatchCurrentTable.lease_expires_at, now),
          ),
        ),
      ),
    )
    .orderBy(asc(DecisionDispatchOutboxTable.created_at), asc(DecisionDispatchOutboxTable.id))
    .get()
  if (!row) return null
  const leaseToken = `fdlease_${Identifier.ascending("event")}`
  appendDispatchEvent(db, {
    outboxId: row.founder_decision_dispatch_outbox.id,
    idempotencyKey: `claim:${leaseToken}`,
    status: "claimed",
    consumerId: input.consumerId,
    leaseToken,
    leaseExpiresAt: now + input.leaseDurationMs,
  })
  return dispatchFromRow(db, row.founder_decision_dispatch_outbox)
}

export function resolveDecisionDispatchInTransaction(
  db: TxOrDb,
  outboxId: string,
  status: "completed" | "failed",
  raw: z.input<typeof DecisionDispatchResolveInput>,
) {
  const input = DecisionDispatchResolveInput.parse(raw)
  const row = db.select().from(DecisionDispatchOutboxTable).where(eq(DecisionDispatchOutboxTable.id, outboxId)).get()
  if (!row) throw new DecisionLedgerNotFound({ decision_id: outboxId })
  const current = db
    .select()
    .from(DecisionDispatchCurrentTable)
    .where(eq(DecisionDispatchCurrentTable.outbox_id, outboxId))
    .get()
  if (!current) throw new DecisionLedgerCorrupt({ decision_id: row.decision_id })
  if (current.current_status === "completed") {
    if (status === "completed" && current.execution_receipt === input.executionReceipt) return dispatchFromRow(db, row)
    throw new DecisionLedgerIdempotencyConflict({ idempotency_key: input.executionReceipt ?? input.leaseToken })
  }
  if (
    current.current_status !== "claimed" ||
    current.consumer_id !== input.consumerId ||
    current.lease_token !== input.leaseToken
  )
    throw new DecisionLedgerIdempotencyConflict({ idempotency_key: input.leaseToken })
  if (status === "completed" && !input.executionReceipt)
    throw new DecisionLedgerIdempotencyConflict({ idempotency_key: input.leaseToken })
  if (status === "failed" && !input.error)
    throw new DecisionLedgerIdempotencyConflict({ idempotency_key: input.leaseToken })
  appendDispatchEvent(db, {
    outboxId,
    idempotencyKey: `${status}:${input.executionReceipt ?? input.leaseToken}`,
    status,
    consumerId: input.consumerId,
    executionReceipt: input.executionReceipt ?? null,
    error: input.error ?? null,
  })
  return dispatchFromRow(db, row)
}

export interface Interface {
  readonly append: (input: z.input<typeof DecisionRecordAppendInput>) => Effect.Effect<DecisionRecord, unknown>
  readonly appendTransition: (
    decisionId: string,
    input: z.input<typeof DecisionTransitionAppendInput>,
  ) => Effect.Effect<DecisionTransition, unknown>
  readonly get: (decisionId: string) => Effect.Effect<DecisionRecord, unknown>
  readonly list: (input: {
    companyId: string
    scopeType?: DecisionScopeValue["type"]
    projectId?: string
    preProjectId?: string
  }) => Effect.Effect<DecisionRecord[], unknown>
  readonly transitions: (decisionId: string) => Effect.Effect<DecisionTransition[], unknown>
  readonly authorizeDispatch: (
    decisionId: string,
    input: z.input<typeof DecisionDispatchAuthorizeInput>,
  ) => Effect.Effect<DecisionDispatchOutbox, unknown>
  readonly claimDispatch: (
    input: z.input<typeof DecisionDispatchClaimInput>,
  ) => Effect.Effect<DecisionDispatchOutbox | null, unknown>
  readonly completeDispatch: (
    outboxId: string,
    input: z.input<typeof DecisionDispatchResolveInput>,
  ) => Effect.Effect<DecisionDispatchOutbox, unknown>
  readonly failDispatch: (
    outboxId: string,
    input: z.input<typeof DecisionDispatchResolveInput>,
  ) => Effect.Effect<DecisionDispatchOutbox, unknown>
  readonly dispatches: (decisionId: string) => Effect.Effect<DecisionDispatchOutbox[], unknown>
  readonly dispatchEvents: (outboxId: string) => Effect.Effect<DecisionDispatchEvent[], unknown>
  readonly policies: (companyId: string) => Effect.Effect<DelegationPolicy[], unknown>
  readonly recover: () => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/DecisionLedger") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    append: (raw) =>
      database(() => {
        const input = DecisionRecordAppendInput.parse(raw)
        const createdAt = Date.now()
        return Database.transaction(
          (db) =>
            appendDecisionInTransaction(db, {
              idempotencyKey: input.idempotencyKey,
              recordOrigin: "live",
              scope: input.scope,
              source: null,
              founderTwinSnapshot: input.founderTwinSnapshot,
              subject: input.subject,
              context: input.context,
              options: input.options,
              recommendation: input.recommendation,
              finalDecision: input.finalDecision,
              decisionMaker: input.decisionMaker,
              decisionMakerId: input.decisionMakerId,
              authorityClass: input.authorityClass,
              operatingMode: input.operatingMode,
              confidence: input.confidence,
              reversible: input.reversible,
              externalImpact: input.externalImpact,
              riskLevel: input.riskLevel,
              evidenceRefs: input.evidenceRefs,
              principleRefs: input.principleRefs,
              decisionCaseRefs: input.decisionCaseRefs,
              initialStatus: input.initialStatus,
              initialTransitionKind:
                input.initialStatus === "accepted"
                  ? "accepted"
                  : input.initialStatus === "awaiting_approval"
                    ? "submitted_for_approval"
                    : "created",
              initialReason: "Decision record appended.",
              overrideOf: input.overrideOf,
              createdAt,
              decidedAt: input.initialStatus === "accepted" ? input.decidedAt ?? createdAt : null,
              decidedAtIdempotencyValue:
                input.initialStatus === "accepted" ? input.decidedAt ?? "server_time" : null,
            }),
          { behavior: "immediate" },
        )
      }),
    appendTransition: (decisionId, raw) =>
      database(() => {
        if (raw.toStatus === "accepted")
          throw new DecisionLedgerIllegalTransition({
            decision_id: decisionId,
            from_status: "proposed",
            to_status: "accepted",
          })
        return Database.transaction(
          (db) => appendDecisionTransitionInTransaction(db, decisionId, raw),
          { behavior: "immediate" },
        )
      }),
    authorizeDispatch: (decisionId, raw) =>
      database(() =>
        Database.transaction(
          (db) => {
            const input = DecisionDispatchAuthorizeInput.parse(raw)
            const row = db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, decisionId)).get()
            if (!row) throw new DecisionLedgerNotFound({ decision_id: decisionId })
            const decision = recordFromRow(db, row)
            if (decision.recordOrigin === "historical_import")
              throw new DecisionLedgerIllegalTransition({
                decision_id: decisionId,
                from_status: decision.currentStatus,
                to_status: "accepted",
              })
            const transition =
              decision.currentStatus === "proposed"
                ? appendDecisionTransitionInTransaction(db, decisionId, {
                    schemaVersion: 1,
                    idempotencyKey: `${input.idempotencyKey}:accepted`,
                    toStatus: "accepted",
                    kind: "accepted",
                    reason: input.reason,
                    actorId: input.actorId,
                    finalDecision: decision.recommendation ?? input.reason,
                  })
                : null
            if (!["proposed", "accepted"].includes(decision.currentStatus))
              throw new DecisionLedgerIllegalTransition({
                decision_id: decisionId,
                from_status: decision.currentStatus,
                to_status: "accepted",
              })
            return appendDecisionDispatchInTransaction(db, {
              companyId: decision.scope.companyId,
              decisionId,
              transitionId:
                transition?.id ??
                db
                  .select()
                  .from(DecisionCurrentProjectionTable)
                  .where(eq(DecisionCurrentProjectionTable.decision_id, decisionId))
                  .get()!.latest_transition_id,
              consumer: input.consumer,
              actionType: input.actionType,
              payload: input.payload,
              idempotencyKey: input.idempotencyKey,
            })
          },
          { behavior: "immediate" },
        ),
      ),
    claimDispatch: (input) =>
      database(() =>
        Database.transaction((db) => claimDecisionDispatchInTransaction(db, input), { behavior: "immediate" }),
      ),
    completeDispatch: (outboxId, input) =>
      database(() =>
        Database.transaction(
          (db) => resolveDecisionDispatchInTransaction(db, outboxId, "completed", input),
          { behavior: "immediate" },
        ),
      ),
    failDispatch: (outboxId, input) =>
      database(() =>
        Database.transaction(
          (db) => resolveDecisionDispatchInTransaction(db, outboxId, "failed", input),
          { behavior: "immediate" },
        ),
      ),
    dispatches: (decisionId) =>
      database(() =>
        Database.use((db) =>
          db
            .select()
            .from(DecisionDispatchOutboxTable)
            .where(eq(DecisionDispatchOutboxTable.decision_id, decisionId))
            .orderBy(asc(DecisionDispatchOutboxTable.created_at), asc(DecisionDispatchOutboxTable.id))
            .all()
            .map((row) => dispatchFromRow(db, row)),
        ),
      ),
    dispatchEvents: (outboxId) =>
      database(() =>
        Database.use((db) =>
          db
            .select()
            .from(DecisionDispatchEventTable)
            .where(eq(DecisionDispatchEventTable.outbox_id, outboxId))
            .orderBy(asc(DecisionDispatchEventTable.sequence))
            .all()
            .map(dispatchEventFromRow),
        ),
      ),
    get: (decisionId) =>
      database(() =>
        Database.transaction(
          (db) => {
            recoverHistoricalBoardDecisions(db)
            const record = db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, decisionId)).get()
            if (!record) throw new DecisionLedgerNotFound({ decision_id: decisionId })
            return recordFromRow(db, record)
          },
          { behavior: "immediate" },
        ),
      ),
    list: (input) =>
      database(() =>
        Database.transaction(
          (db) => {
            recoverHistoricalBoardDecisions(db)
            return db
              .select()
              .from(DecisionRecordTable)
              .where(eq(DecisionRecordTable.company_id, input.companyId))
              .orderBy(asc(DecisionRecordTable.created_at), asc(DecisionRecordTable.id))
              .all()
              .filter(
                (record) =>
                  (!input.scopeType || record.scope_type === input.scopeType) &&
                  (!input.projectId || record.project_id === input.projectId) &&
                  (!input.preProjectId || record.pre_project_id === input.preProjectId),
              )
              .map((record) => recordFromRow(db, record))
          },
          { behavior: "immediate" },
        ),
      ),
    transitions: (decisionId) =>
      database(() =>
        Database.use((db) => {
          if (!db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, decisionId)).get())
            throw new DecisionLedgerNotFound({ decision_id: decisionId })
          return db
            .select()
            .from(DecisionTransitionTable)
            .where(eq(DecisionTransitionTable.decision_id, decisionId))
            .orderBy(asc(DecisionTransitionTable.sequence))
            .all()
            .map(transitionFromRow)
        }),
      ),
    policies: (companyId) =>
      database(() =>
        Database.transaction(
          (db) => {
            ensureDefaultPolicies(db, companyId)
            return db
              .select()
              .from(DelegationPolicyTable)
              .where(eq(DelegationPolicyTable.company_id, companyId))
              .orderBy(asc(DelegationPolicyTable.action_type), asc(DelegationPolicyTable.version))
              .all()
              .map(policyFromRow)
          },
          { behavior: "immediate" },
        ),
      ),
    recover: () =>
      database(() =>
        Database.transaction(
          (db) => {
            recoverHistoricalBoardDecisions(db)
            reconcileBoardDecisionProjectionsInTransaction(db)
          },
          { behavior: "immediate" },
        ),
      ),
  }),
)

export const defaultLayer = layer
