import { and, asc, count, desc, eq, inArray, or } from "drizzle-orm"
import z from "zod"
import {
  RolloutActionRequest,
  RolloutActionResult,
  RolloutApiError,
  RolloutCandidateFact,
  RolloutEvidence,
  RolloutJournal,
  RolloutJournalEntry,
  RolloutLocalRepeatFact,
  RolloutRollbackFact,
  RolloutShadowEvaluation,
  RolloutState,
  RolloutStatus,
  RolloutTransitionRequest,
  RolloutTransitionResult,
  SeedGrowExecutionMode,
  type RolloutActionRequest as RolloutActionRequestValue,
  type RolloutPhase as RolloutPhaseValue,
} from "@agents-company/shared/rollout"
import {
  ProjectExecutionStrategy,
  type ProjectExecutionStrategy as ProjectExecutionStrategyValue,
} from "@agents-company/shared/project-orchestration"
import {
  CompanyArtifactTable,
  CompanyGraphDecisionTable,
  CompanyGraphMutationTable,
  CompanyPlanTable,
  CompanyProjectCharterTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemDependencyTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "@/company-project/company-project.sql"
import { Flag } from "@/flag/flag"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import type { TxOrDb } from "@/storage/db"
import {
  CompanyRolloutCandidateTable,
  CompanyRolloutJournalTable,
  CompanyRolloutLocalRepeatTable,
  CompanyRolloutRollbackTable,
  CompanyRolloutShadowEvaluationTable,
  CompanyRolloutStateTable,
} from "./company-rollout.sql"

const phases = [
  "off",
  "shadow",
  "opt_in",
  "dogfood_default",
  "pre_public_default",
] as const satisfies readonly RolloutPhaseValue[]

const activeProjectStatuses = ["intake", "planning", "executing", "reviewing", "awaiting_approval"]

export class RolloutStoreError extends Error {
  readonly code: z.infer<typeof RolloutApiError>["code"]

  constructor(code: z.infer<typeof RolloutApiError>["code"], message: string) {
    super(message)
    this.name = "RolloutStoreError"
    this.code = code
  }

  toApiError() {
    return RolloutApiError.parse({ code: this.code, message: this.message })
  }
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]),
  )
}

function payloadJSON(value: unknown) {
  return JSON.stringify(normalized(value))
}

function digest(value: unknown) {
  return new Bun.CryptoHasher("sha256").update(payloadJSON(value)).digest("hex")
}

export function valueSha256(value: unknown) {
  return digest(value)
}

function parsePersistedValue<T>(schema: z.ZodType<T>, value: unknown, message: string) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new RolloutStoreError("invalid_persisted_fact", message)
  return parsed.data
}

function parsePersistedJSON<T>(schema: z.ZodType<T>, value: string) {
  try {
    return parsePersistedValue(schema, JSON.parse(value), "Persisted rollout fact cannot be parsed safely.")
  } catch {
    throw new RolloutStoreError("invalid_persisted_fact", "Persisted rollout fact cannot be parsed safely.")
  }
}

function stateFromRow(row: typeof CompanyRolloutStateTable.$inferSelect) {
  return parsePersistedValue(
    RolloutState,
    {
      id: row.id,
      phase: row.phase,
      version: row.version,
      lastTransitionId: row.last_transition_id ?? undefined,
      updatedAt: row.updated_at,
    },
    "Persisted rollout state cannot be parsed safely.",
  )
}

function journalFromRow(row: typeof CompanyRolloutJournalTable.$inferSelect) {
  return parsePersistedValue(
    RolloutJournalEntry,
    row.kind === "transition"
      ? {
          id: row.id,
          kind: row.kind,
          idempotencyKey: row.idempotency_key,
          payloadSha256: row.payload_sha256,
          resultRefId: row.result_ref_id,
          createdAt: row.created_at,
        }
      : {
          id: row.id,
          kind: row.kind,
          actionKind: row.action_kind,
          idempotencyKey: row.idempotency_key,
          payloadSha256: row.payload_sha256,
          resultRefId: row.result_ref_id,
          createdAt: row.created_at,
        },
    "Persisted rollout journal cannot be parsed safely.",
  )
}

function candidateFromRow(row: typeof CompanyRolloutCandidateTable.$inferSelect) {
  return parsePersistedValue(
    RolloutCandidateFact,
    {
      id: row.id,
      candidateSha: row.candidate_sha,
      targetRef: row.target_ref,
      registeredAt: row.registered_at,
    },
    "Persisted rollout candidate cannot be parsed safely.",
  )
}

function repeatFromRow(row: typeof CompanyRolloutLocalRepeatTable.$inferSelect) {
  return parsePersistedValue(
    RolloutLocalRepeatFact,
    {
      id: row.id,
      candidateId: row.candidate_id,
      runId: row.run_id,
      ordinal: row.ordinal,
      outcome: row.outcome,
      environmentSha256: row.environment_sha256,
      evidenceSha256: row.evidence_sha256,
      normalizedResultSha256: row.normalized_result_sha256 ?? undefined,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      recordedAt: row.recorded_at,
    },
    "Persisted rollout local repeat cannot be parsed safely.",
  )
}

function rollbackFromRow(row: typeof CompanyRolloutRollbackTable.$inferSelect) {
  return parsePersistedValue(
    RolloutRollbackFact,
    {
      id: row.id,
      candidateId: row.candidate_id ?? undefined,
      projectId: row.project_id ?? undefined,
      target: row.target,
      phaseAtAction: row.phase_at_action,
      executionModeAfter: row.execution_mode_after,
      outcome: row.outcome,
      evidenceSha256: row.evidence_sha256,
      observedAt: row.observed_at,
      recordedAt: row.recorded_at,
    },
    "Persisted rollout rollback cannot be parsed safely.",
  )
}

function shadowFromRow(row: typeof CompanyRolloutShadowEvaluationTable.$inferSelect) {
  const input = parsePersistedJSON(z.record(z.string(), z.unknown()), row.input_json)
  const output = parsePersistedJSON(z.record(z.string(), z.unknown()), row.output_json)
  if (digest(input) !== row.input_sha256 || digest(output) !== row.output_sha256)
    throw new RolloutStoreError("invalid_persisted_fact", "Persisted rollout shadow digest does not match.")
  return parsePersistedValue(
    RolloutShadowEvaluation,
    {
      id: row.id,
      projectId: row.project_id,
      sourceKey: row.source_key,
      kind: row.kind,
      receiptId: row.receipt_id ?? undefined,
      snapshotSha256: row.snapshot_sha256,
      inputSha256: row.input_sha256,
      outputSha256: row.output_sha256,
      businessStateBeforeSha256: row.business_state_before_sha256,
      businessStateAfterSha256: row.business_state_after_sha256,
      input,
      output,
      status: row.status,
      createdAt: row.created_at,
    },
    "Persisted rollout shadow evaluation cannot be parsed safely.",
  )
}

function executionMode() {
  return SeedGrowExecutionMode.parse(Flag.AGENTCOMPANY_SEED_GROW_ORCHESTRATION)
}

export function projectPolicy(phase: RolloutPhaseValue, mode = executionMode()) {
  if (mode !== "active" || phase === "off" || phase === "shadow")
    return {
      defaultStrategy: "legacy_full_plan" as const,
      seedOptInAllowed: false,
      explicitLegacyFallbackAllowed: false,
    }
  if (phase === "opt_in")
    return {
      defaultStrategy: "legacy_full_plan" as const,
      seedOptInAllowed: true,
      explicitLegacyFallbackAllowed: false,
    }
  return {
    defaultStrategy: "seed_and_grow" as const,
    seedOptInAllowed: true,
    explicitLegacyFallbackAllowed: true,
  }
}

export function resolveProjectStrategy(input: {
  phase: RolloutPhaseValue
  executionMode: z.infer<typeof SeedGrowExecutionMode>
  requested?: ProjectExecutionStrategyValue
}) {
  const requested = input.requested === undefined ? undefined : ProjectExecutionStrategy.parse(input.requested)
  const policy = projectPolicy(input.phase, input.executionMode)
  if (policy.defaultStrategy === "seed_and_grow")
    return requested === "legacy_full_plan" ? "legacy_full_plan" : "seed_and_grow"
  if (policy.seedOptInAllowed && requested === "seed_and_grow") return "seed_and_grow"
  return "legacy_full_plan"
}

export function status() {
  const state = Database.use(readState)
  const mode = executionMode()
  return RolloutStatus.parse({
    state,
    executionMode: mode,
    newProjectPolicy: projectPolicy(state.phase, mode),
  })
}

export function resolveNewProjectStrategy(requested?: ProjectExecutionStrategyValue) {
  const current = status()
  return resolveProjectStrategy({
    phase: current.state.phase,
    executionMode: current.executionMode,
    requested,
  })
}

export function shadowEnabled() {
  const current = status()
  return current.state.phase === "shadow" && current.executionMode === "shadow"
}

export function projectBusinessStateSha256(projectId: string) {
  return Database.use((db) => {
    const workItems = db
      .select()
      .from(CompanyWorkItemTable)
      .where(eq(CompanyWorkItemTable.project_id, projectId))
      .orderBy(asc(CompanyWorkItemTable.id))
      .all()
    const workItemIDs = new Set(workItems.map((item) => item.id))
    return digest({
      project: db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, projectId)).get(),
      charters: db
        .select()
        .from(CompanyProjectCharterTable)
        .where(eq(CompanyProjectCharterTable.project_id, projectId))
        .orderBy(asc(CompanyProjectCharterTable.project_id))
        .all(),
      plans: db
        .select()
        .from(CompanyPlanTable)
        .where(eq(CompanyPlanTable.project_id, projectId))
        .orderBy(asc(CompanyPlanTable.id))
        .all(),
      workItems,
      dependencies: db
        .select()
        .from(CompanyWorkItemDependencyTable)
        .orderBy(asc(CompanyWorkItemDependencyTable.work_item_id), asc(CompanyWorkItemDependencyTable.depends_on_id))
        .all()
        .filter((dependency) => workItemIDs.has(dependency.work_item_id)),
      artifacts: db
        .select()
        .from(CompanyArtifactTable)
        .where(eq(CompanyArtifactTable.project_id, projectId))
        .orderBy(asc(CompanyArtifactTable.id))
        .all(),
      attempts: db
        .select()
        .from(CompanyWorkAttemptTable)
        .where(eq(CompanyWorkAttemptTable.project_id, projectId))
        .orderBy(asc(CompanyWorkAttemptTable.id))
        .all(),
      receipts: db
        .select()
        .from(CompanyWorkReceiptTable)
        .where(eq(CompanyWorkReceiptTable.project_id, projectId))
        .orderBy(asc(CompanyWorkReceiptTable.id))
        .all(),
      decisions: db
        .select()
        .from(CompanyGraphDecisionTable)
        .where(eq(CompanyGraphDecisionTable.project_id, projectId))
        .orderBy(asc(CompanyGraphDecisionTable.id))
        .all(),
      mutations: db
        .select()
        .from(CompanyGraphMutationTable)
        .where(eq(CompanyGraphMutationTable.project_id, projectId))
        .orderBy(asc(CompanyGraphMutationTable.id))
        .all(),
      validationGates: db
        .select()
        .from(CompanyValidationGateTable)
        .where(eq(CompanyValidationGateTable.project_id, projectId))
        .orderBy(asc(CompanyValidationGateTable.id))
        .all(),
      events: db
        .select()
        .from(CompanyProjectEventTable)
        .where(eq(CompanyProjectEventTable.project_id, projectId))
        .orderBy(asc(CompanyProjectEventTable.id))
        .all(),
    })
  })
}

export function recordShadowEvaluation(input: {
  projectId: string
  sourceKey: string
  kind: "seed_policy" | "supervisor"
  receiptId?: string
  snapshotSha256: string
  businessStateBeforeSha256: string
  businessStateAfterSha256: string
  input: Record<string, unknown>
  output: Record<string, unknown>
  status: "evaluated" | "validated" | "rejected"
}) {
  if (!shadowEnabled())
    throw new RolloutStoreError("entity_conflict", "Rollout shadow evaluation requires the shadow phase and mode.")
  return Database.transaction(
    (db) => {
      const existing = db
        .select()
        .from(CompanyRolloutShadowEvaluationTable)
        .where(eq(CompanyRolloutShadowEvaluationTable.source_key, input.sourceKey))
        .get()
      const project = db
        .select({ execution_strategy: CompanyProjectTable.execution_strategy })
        .from(CompanyProjectTable)
        .where(eq(CompanyProjectTable.id, input.projectId))
        .get()
      if (!project || project.execution_strategy !== "legacy_full_plan")
        throw new RolloutStoreError("entity_conflict", "Rollout shadow evaluation requires a persisted legacy project.")
      const fact = RolloutShadowEvaluation.parse({
        id: existing?.id ?? Identifier.ascending("rolloutShadow"),
        projectId: input.projectId,
        sourceKey: input.sourceKey,
        kind: input.kind,
        receiptId: input.receiptId,
        snapshotSha256: input.snapshotSha256,
        inputSha256: digest(input.input),
        outputSha256: digest(input.output),
        businessStateBeforeSha256: input.businessStateBeforeSha256,
        businessStateAfterSha256: input.businessStateAfterSha256,
        input: input.input,
        output: input.output,
        status: input.status,
        createdAt: existing?.created_at ?? Date.now(),
      })
      if (existing) {
        const persisted = shadowFromRow(existing)
        if (!same(persisted, fact))
          throw new RolloutStoreError(
            "entity_conflict",
            "The rollout shadow source is already bound to a different evaluation.",
          )
        return persisted
      }
      db.insert(CompanyRolloutShadowEvaluationTable)
        .values({
          id: fact.id,
          project_id: fact.projectId,
          source_key: fact.sourceKey,
          kind: fact.kind,
          receipt_id: fact.receiptId ?? null,
          snapshot_sha256: fact.snapshotSha256,
          input_sha256: fact.inputSha256,
          output_sha256: fact.outputSha256,
          business_state_before_sha256: fact.businessStateBeforeSha256,
          business_state_after_sha256: fact.businessStateAfterSha256,
          input_json: payloadJSON(fact.input),
          output_json: payloadJSON(fact.output),
          status: fact.status,
          created_at: fact.createdAt,
        })
        .run()
      return fact
    },
    { behavior: "immediate" },
  )
}

export function getShadowEvaluation(sourceKey: string) {
  const row = Database.use((db) =>
    db
      .select()
      .from(CompanyRolloutShadowEvaluationTable)
      .where(eq(CompanyRolloutShadowEvaluationTable.source_key, sourceKey))
      .get(),
  )
  return row ? shadowFromRow(row) : undefined
}

function existingJournal(db: TxOrDb, kind: "transition" | "action", idempotencyKey: string) {
  return db
    .select()
    .from(CompanyRolloutJournalTable)
    .where(
      and(eq(CompanyRolloutJournalTable.kind, kind), eq(CompanyRolloutJournalTable.idempotency_key, idempotencyKey)),
    )
    .get()
}

function same(left: unknown, right: unknown) {
  return payloadJSON(left) === payloadJSON(right)
}

function journalPayload(row: typeof CompanyRolloutJournalTable.$inferSelect) {
  let persistedPayload: unknown
  try {
    persistedPayload = JSON.parse(row.payload_json) as unknown
  } catch {
    throw new RolloutStoreError("invalid_persisted_fact", "Persisted rollout journal payload cannot be parsed safely.")
  }
  if (digest(persistedPayload) !== row.payload_sha256)
    throw new RolloutStoreError("invalid_persisted_fact", "Persisted rollout journal payload digest does not match.")
  return persistedPayload
}

function validateJournalPayload(row: typeof CompanyRolloutJournalTable.$inferSelect, expectedSha256: string) {
  journalPayload(row)
  if (row.payload_sha256 !== expectedSha256)
    throw new RolloutStoreError(
      "idempotency_collision",
      "The rollout idempotency key is already bound to a different payload.",
    )
}

function transitionRecord(row: typeof CompanyRolloutJournalTable.$inferSelect) {
  const journal = journalFromRow(row)
  const request = parsePersistedValue(
    RolloutTransitionRequest,
    journalPayload(row),
    "Persisted rollout transition payload cannot be parsed safely.",
  )
  const result = parsePersistedJSON(RolloutTransitionResult, row.result_json)
  if (
    row.action_kind !== null ||
    journal.kind !== "transition" ||
    request.idempotencyKey !== journal.idempotencyKey ||
    result.replayed ||
    !same(result.journal, journal) ||
    result.transition.id !== journal.resultRefId ||
    result.transition.to !== request.to ||
    result.transition.reason !== request.reason ||
    result.transition.actorId !== request.actorId
  )
    throw new RolloutStoreError("invalid_persisted_fact", "Persisted rollout transition journal is inconsistent.")
  return { journal, request, result }
}

function actionFact(db: TxOrDb, result: z.infer<typeof RolloutActionResult>) {
  if (result.kind === "register_candidate") {
    const row = db
      .select()
      .from(CompanyRolloutCandidateTable)
      .where(eq(CompanyRolloutCandidateTable.id, result.candidate.id))
      .get()
    if (!row) throw new RolloutStoreError("invalid_persisted_fact", "Persisted rollout candidate action has no fact.")
    return candidateFromRow(row)
  }
  if (result.kind === "record_local_repeat") {
    const row = db
      .select()
      .from(CompanyRolloutLocalRepeatTable)
      .where(eq(CompanyRolloutLocalRepeatTable.id, result.repeat.id))
      .get()
    if (!row)
      throw new RolloutStoreError("invalid_persisted_fact", "Persisted rollout local repeat action has no fact.")
    return repeatFromRow(row)
  }
  const row = db
    .select()
    .from(CompanyRolloutRollbackTable)
    .where(eq(CompanyRolloutRollbackTable.id, result.rollback.id))
    .get()
  if (!row) throw new RolloutStoreError("invalid_persisted_fact", "Persisted rollout rollback action has no fact.")
  return rollbackFromRow(row)
}

function actionRequestFromResult(result: z.infer<typeof RolloutActionResult>) {
  if (result.kind === "register_candidate")
    return {
      kind: result.kind,
      idempotencyKey: result.journal.idempotencyKey,
      candidate: {
        id: result.candidate.id,
        candidateSha: result.candidate.candidateSha,
        targetRef: result.candidate.targetRef,
      },
    }
  if (result.kind === "record_local_repeat")
    return {
      kind: result.kind,
      idempotencyKey: result.journal.idempotencyKey,
      repeat: {
        id: result.repeat.id,
        candidateId: result.repeat.candidateId,
        runId: result.repeat.runId,
        ordinal: result.repeat.ordinal,
        outcome: result.repeat.outcome,
        environmentSha256: result.repeat.environmentSha256,
        evidenceSha256: result.repeat.evidenceSha256,
        normalizedResultSha256: result.repeat.normalizedResultSha256,
        startedAt: result.repeat.startedAt,
        finishedAt: result.repeat.finishedAt,
      },
    }
  return {
    kind: result.kind,
    idempotencyKey: result.journal.idempotencyKey,
    rollback: {
      id: result.rollback.id,
      candidateId: result.rollback.candidateId,
      projectId: result.rollback.projectId,
      target: result.rollback.target,
      phaseAtAction: result.rollback.phaseAtAction,
      executionModeAfter: result.rollback.executionModeAfter,
      outcome: result.rollback.outcome,
      evidenceSha256: result.rollback.evidenceSha256,
      observedAt: result.rollback.observedAt,
    },
  }
}

function actionRecord(db: TxOrDb, row: typeof CompanyRolloutJournalTable.$inferSelect) {
  const journal = journalFromRow(row)
  const request = parsePersistedValue(
    RolloutActionRequest,
    journalPayload(row),
    "Persisted rollout action payload cannot be parsed safely.",
  )
  const result = parsePersistedJSON(RolloutActionResult, row.result_json)
  const fact =
    result.kind === "register_candidate"
      ? result.candidate
      : result.kind === "record_local_repeat"
        ? result.repeat
        : result.rollback
  if (
    journal.kind !== "action" ||
    request.idempotencyKey !== journal.idempotencyKey ||
    request.kind !== journal.actionKind ||
    result.kind !== request.kind ||
    result.replayed ||
    !same(result.journal, journal) ||
    !same(request, actionRequestFromResult(result)) ||
    !same(actionFact(db, result), fact)
  )
    throw new RolloutStoreError("invalid_persisted_fact", "Persisted rollout action journal is inconsistent.")
  return { journal, request, result }
}

function validatedJournal(db: TxOrDb, row: typeof CompanyRolloutJournalTable.$inferSelect) {
  if (row.kind === "transition") return transitionRecord(row).journal
  return actionRecord(db, row).journal
}

function validateFactJournal(
  db: TxOrDb,
  actionKind: z.infer<typeof RolloutActionRequest>["kind"],
  resultRefId: string,
) {
  const rows = db
    .select()
    .from(CompanyRolloutJournalTable)
    .where(
      and(
        eq(CompanyRolloutJournalTable.kind, "action"),
        eq(CompanyRolloutJournalTable.action_kind, actionKind),
        eq(CompanyRolloutJournalTable.result_ref_id, resultRefId),
      ),
    )
    .all()
  if (rows.length !== 1)
    throw new RolloutStoreError(
      "invalid_persisted_fact",
      "Persisted rollout evidence must reference exactly one action journal.",
    )
  actionRecord(db, rows[0])
}

function readState(db: TxOrDb) {
  const row = db.select().from(CompanyRolloutStateTable).where(eq(CompanyRolloutStateTable.id, "seed_and_grow")).get()
  if (!row) throw new RolloutStoreError("invalid_persisted_fact", "Persisted rollout state is missing.")
  const state = stateFromRow(row)
  if (!state.lastTransitionId) return state
  const transitions = db
    .select()
    .from(CompanyRolloutJournalTable)
    .where(
      and(
        eq(CompanyRolloutJournalTable.kind, "transition"),
        eq(CompanyRolloutJournalTable.result_ref_id, state.lastTransitionId),
      ),
    )
    .all()
  if (transitions.length !== 1)
    throw new RolloutStoreError(
      "invalid_persisted_fact",
      "Persisted rollout state must reference exactly one transition.",
    )
  const persisted = transitionRecord(transitions[0]).result.state
  if (!same(persisted, state))
    throw new RolloutStoreError("invalid_persisted_fact", "Persisted rollout state and transition are inconsistent.")
  return state
}

export function transition(input: z.input<typeof RolloutTransitionRequest>) {
  const request = RolloutTransitionRequest.parse(input)
  const payloadSha256 = digest(request)
  return Database.transaction(
    (db) => {
      const existing = existingJournal(db, "transition", request.idempotencyKey)
      if (existing) {
        const record = transitionRecord(existing)
        validateJournalPayload(existing, payloadSha256)
        return RolloutTransitionResult.parse({ ...record.result, journal: record.journal, replayed: true })
      }

      const current = readState(db)
      const next = phases[phases.indexOf(current.phase) + 1]
      if (request.to !== next)
        throw new RolloutStoreError(
          "invalid_transition",
          `Rollout phase ${current.phase} can only advance to ${next ?? "no further phase"}.`,
        )
      const running =
        db
          .select({ value: count() })
          .from(CompanyProjectTable)
          .where(inArray(CompanyProjectTable.status, activeProjectStatuses))
          .get()?.value ?? 0
      if (running > 0)
        throw new RolloutStoreError(
          "running_projects",
          "Rollout phase cannot change while company projects are still active.",
        )

      const now = Date.now()
      const transitionId = Identifier.ascending("rolloutTransition")
      const journalId = Identifier.ascending("rolloutJournal")
      const state = RolloutState.parse({
        id: "seed_and_grow",
        phase: request.to,
        version: current.version + 1,
        lastTransitionId: transitionId,
        updatedAt: now,
      })
      const transitionFact = {
        id: transitionId,
        from: current.phase,
        to: request.to,
        version: state.version,
        reason: request.reason,
        actorId: request.actorId,
        createdAt: now,
      }
      const journal = RolloutJournalEntry.parse({
        id: journalId,
        kind: "transition",
        idempotencyKey: request.idempotencyKey,
        payloadSha256,
        resultRefId: transitionId,
        createdAt: now,
      })
      const result = RolloutTransitionResult.parse({
        state,
        transition: transitionFact,
        journal,
        replayed: false,
      })

      db.insert(CompanyRolloutJournalTable)
        .values({
          id: journal.id,
          kind: journal.kind,
          action_kind: null,
          idempotency_key: journal.idempotencyKey,
          payload_sha256: journal.payloadSha256,
          payload_json: payloadJSON(request),
          result_ref_id: journal.resultRefId,
          result_json: JSON.stringify(result),
          created_at: journal.createdAt,
        })
        .run()
      const updated = db
        .update(CompanyRolloutStateTable)
        .set({
          phase: state.phase,
          version: state.version,
          last_transition_id: transitionId,
          updated_at: now,
        })
        .where(and(eq(CompanyRolloutStateTable.id, state.id), eq(CompanyRolloutStateTable.version, current.version)))
        .returning()
        .get()
      if (!updated || !same(stateFromRow(updated), state))
        throw new RolloutStoreError("invalid_persisted_fact", "Persisted rollout state update was not applied safely.")
      return result
    },
    { behavior: "immediate" },
  )
}

function candidateExists(db: TxOrDb, candidateId: string) {
  return db
    .select({ id: CompanyRolloutCandidateTable.id })
    .from(CompanyRolloutCandidateTable)
    .where(eq(CompanyRolloutCandidateTable.id, candidateId))
    .get()
}

function ensureActionEntityAvailable(db: TxOrDb, request: RolloutActionRequestValue) {
  if (request.kind === "register_candidate") {
    const existing = db
      .select({ id: CompanyRolloutCandidateTable.id })
      .from(CompanyRolloutCandidateTable)
      .where(
        or(
          eq(CompanyRolloutCandidateTable.id, request.candidate.id),
          eq(CompanyRolloutCandidateTable.candidate_sha, request.candidate.candidateSha),
        ),
      )
      .get()
    if (existing)
      throw new RolloutStoreError("entity_conflict", "The rollout candidate id or commit SHA is already registered.")
    return
  }
  if (request.kind === "record_local_repeat") {
    if (!candidateExists(db, request.repeat.candidateId))
      throw new RolloutStoreError("missing_candidate", "The local repeat references an unknown rollout candidate.")
    const existing = db
      .select({ id: CompanyRolloutLocalRepeatTable.id })
      .from(CompanyRolloutLocalRepeatTable)
      .where(
        or(
          eq(CompanyRolloutLocalRepeatTable.id, request.repeat.id),
          eq(CompanyRolloutLocalRepeatTable.run_id, request.repeat.runId),
          and(
            eq(CompanyRolloutLocalRepeatTable.candidate_id, request.repeat.candidateId),
            eq(CompanyRolloutLocalRepeatTable.ordinal, request.repeat.ordinal),
          ),
        ),
      )
      .get()
    if (existing)
      throw new RolloutStoreError(
        "entity_conflict",
        "The local repeat id, run id, or candidate ordinal is already recorded.",
      )
    return
  }
  if (request.rollback.candidateId && !candidateExists(db, request.rollback.candidateId))
    throw new RolloutStoreError("missing_candidate", "The rollback fact references an unknown rollout candidate.")
  if (request.rollback.phaseAtAction !== readState(db).phase)
    throw new RolloutStoreError(
      "entity_conflict",
      "The rollback fact phase does not match the persisted rollout phase.",
    )
  if (request.rollback.executionModeAfter !== executionMode())
    throw new RolloutStoreError(
      "entity_conflict",
      "The rollback fact execution mode does not match the low-level execution mode.",
    )
  const existing = db
    .select({ id: CompanyRolloutRollbackTable.id })
    .from(CompanyRolloutRollbackTable)
    .where(eq(CompanyRolloutRollbackTable.id, request.rollback.id))
    .get()
  if (existing) throw new RolloutStoreError("entity_conflict", "The rollout rollback fact id is already recorded.")
  if (!request.rollback.projectId) return
  const project = db
    .select({ id: CompanyProjectTable.id })
    .from(CompanyProjectTable)
    .where(eq(CompanyProjectTable.id, request.rollback.projectId))
    .get()
  if (!project)
    throw new RolloutStoreError("entity_conflict", "The rollback fact references an unknown company project.")
}

function persistActionFact(db: TxOrDb, request: RolloutActionRequestValue, now: number) {
  if (request.kind === "register_candidate") {
    const candidate = RolloutCandidateFact.parse({
      ...request.candidate,
      registeredAt: now,
    })
    db.insert(CompanyRolloutCandidateTable)
      .values({
        id: candidate.id,
        candidate_sha: candidate.candidateSha,
        target_ref: candidate.targetRef,
        registered_at: candidate.registeredAt,
      })
      .run()
    return { kind: request.kind, candidate } as const
  }
  if (request.kind === "record_local_repeat") {
    const repeat = RolloutLocalRepeatFact.parse({
      ...request.repeat,
      recordedAt: now,
    })
    db.insert(CompanyRolloutLocalRepeatTable)
      .values({
        id: repeat.id,
        candidate_id: repeat.candidateId,
        run_id: repeat.runId,
        ordinal: repeat.ordinal,
        outcome: repeat.outcome,
        environment_sha256: repeat.environmentSha256,
        evidence_sha256: repeat.evidenceSha256,
        normalized_result_sha256: repeat.normalizedResultSha256 ?? null,
        started_at: repeat.startedAt,
        finished_at: repeat.finishedAt,
        recorded_at: repeat.recordedAt,
      })
      .run()
    return { kind: request.kind, repeat } as const
  }
  const rollback = RolloutRollbackFact.parse({
    ...request.rollback,
    recordedAt: now,
  })
  db.insert(CompanyRolloutRollbackTable)
    .values({
      id: rollback.id,
      candidate_id: rollback.candidateId ?? null,
      project_id: rollback.projectId ?? null,
      target: rollback.target,
      phase_at_action: rollback.phaseAtAction,
      execution_mode_after: rollback.executionModeAfter,
      outcome: rollback.outcome,
      evidence_sha256: rollback.evidenceSha256,
      observed_at: rollback.observedAt,
      recorded_at: rollback.recordedAt,
    })
    .run()
  return { kind: request.kind, rollback } as const
}

export function recordAction(input: z.input<typeof RolloutActionRequest>) {
  const request = RolloutActionRequest.parse(input)
  const payloadSha256 = digest(request)
  return Database.transaction(
    (db) => {
      const existing = existingJournal(db, "action", request.idempotencyKey)
      if (existing) {
        const record = actionRecord(db, existing)
        validateJournalPayload(existing, payloadSha256)
        return RolloutActionResult.parse({ ...record.result, journal: record.journal, replayed: true })
      }

      ensureActionEntityAvailable(db, request)
      const now = Date.now()
      const fact = persistActionFact(db, request, now)
      const resultRefId =
        fact.kind === "register_candidate"
          ? fact.candidate.id
          : fact.kind === "record_local_repeat"
            ? fact.repeat.id
            : fact.rollback.id
      const journal = RolloutJournalEntry.parse({
        id: Identifier.ascending("rolloutJournal"),
        kind: "action",
        actionKind: request.kind,
        idempotencyKey: request.idempotencyKey,
        payloadSha256,
        resultRefId,
        createdAt: now,
      })
      const result = RolloutActionResult.parse({
        ...fact,
        journal,
        replayed: false,
      })
      if (journal.kind !== "action")
        throw new RolloutStoreError("invalid_persisted_fact", "Rollout action journal kind is invalid.")
      db.insert(CompanyRolloutJournalTable)
        .values({
          id: journal.id,
          kind: journal.kind,
          action_kind: journal.actionKind,
          idempotency_key: journal.idempotencyKey,
          payload_sha256: journal.payloadSha256,
          payload_json: payloadJSON(request),
          result_ref_id: journal.resultRefId,
          result_json: JSON.stringify(result),
          created_at: journal.createdAt,
        })
        .run()
      return result
    },
    { behavior: "immediate" },
  )
}

export function listJournal(limit = 500) {
  const bounded = z.number().int().positive().max(500).parse(limit)
  try {
    return RolloutJournal.parse({
      items: Database.transaction((db) =>
        db
          .select()
          .from(CompanyRolloutJournalTable)
          .orderBy(desc(CompanyRolloutJournalTable.created_at), desc(CompanyRolloutJournalTable.id))
          .limit(bounded)
          .all()
          .map((row) => validatedJournal(db, row)),
      ),
    })
  } catch (error) {
    if (error instanceof RolloutStoreError) throw error
    throw new RolloutStoreError("invalid_persisted_fact", "Persisted rollout journal cannot be parsed safely.")
  }
}

export function evidence(limit = 500) {
  const bounded = z.number().int().positive().max(500).parse(limit)
  try {
    return RolloutEvidence.parse(
      Database.transaction((db) => {
        const candidates = db
          .select()
          .from(CompanyRolloutCandidateTable)
          .orderBy(asc(CompanyRolloutCandidateTable.registered_at), asc(CompanyRolloutCandidateTable.id))
          .limit(bounded)
          .all()
          .map(candidateFromRow)
        const localRepeats = db
          .select()
          .from(CompanyRolloutLocalRepeatTable)
          .orderBy(asc(CompanyRolloutLocalRepeatTable.recorded_at), asc(CompanyRolloutLocalRepeatTable.id))
          .limit(bounded)
          .all()
          .map(repeatFromRow)
        const rollbacks = db
          .select()
          .from(CompanyRolloutRollbackTable)
          .orderBy(asc(CompanyRolloutRollbackTable.recorded_at), asc(CompanyRolloutRollbackTable.id))
          .limit(bounded)
          .all()
          .map(rollbackFromRow)
        const shadowEvaluations = db
          .select()
          .from(CompanyRolloutShadowEvaluationTable)
          .orderBy(asc(CompanyRolloutShadowEvaluationTable.created_at), asc(CompanyRolloutShadowEvaluationTable.id))
          .limit(bounded)
          .all()
          .map(shadowFromRow)
        candidates.forEach((candidate) => validateFactJournal(db, "register_candidate", candidate.id))
        localRepeats.forEach((repeat) => validateFactJournal(db, "record_local_repeat", repeat.id))
        rollbacks.forEach((rollback) => validateFactJournal(db, "record_rollback", rollback.id))
        return { candidates, localRepeats, rollbacks, shadowEvaluations }
      }),
    )
  } catch (error) {
    if (error instanceof RolloutStoreError) throw error
    throw new RolloutStoreError("invalid_persisted_fact", "Persisted rollout evidence cannot be parsed safely.")
  }
}
