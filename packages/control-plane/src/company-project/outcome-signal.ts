import { Context, Effect, Layer } from "effect"
import { and, asc, eq } from "drizzle-orm"
import z from "zod"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import type { TxOrDb } from "@/storage/db"
import { DecisionCurrentProjectionTable, DecisionRecordTable } from "@/founder-os/decision-ledger.sql"
import {
  CompanyArtifactTable,
  CompanyOutcomeSignalCurrentTable,
  CompanyOutcomeSignalTable,
  CompanyOutcomeSignalTransitionTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyWorkReceiptTable,
} from "./company-project.sql"
import {
  OutcomeSignal,
  OutcomeSignalSourceRef,
  OutcomeSignalSubmission,
  OutcomeSignalTransition,
  OutcomeSignalTransitionSubmission,
  WorkReceiptEvidenceRef,
  type OutcomeSignal as OutcomeSignalValue,
  type OutcomeSignalSourceRef as OutcomeSignalSourceRefValue,
  type OutcomeSignalSubmission as OutcomeSignalSubmissionValue,
  type OutcomeSignalTransition as OutcomeSignalTransitionValue,
  type OutcomeSignalTransitionSubmission as OutcomeSignalTransitionSubmissionValue,
  type OutcomeSignalValidatorRef,
} from "./schema"

const IndependentArtifactEvidence = z
  .object({
    authority: z.enum(["control_plane", "human", "external_system", "independent_reviewer"]),
    accepted: z.boolean().optional(),
    verified: z.boolean().optional(),
  })
  .catchall(z.unknown())
  .refine((value) => value.accepted === true || value.verified === true)

const normalizedRefs = (refs: OutcomeSignalSourceRefValue[]) =>
  [...refs].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))

const signalFromRow = (
  row: typeof CompanyOutcomeSignalTable.$inferSelect,
  current: typeof CompanyOutcomeSignalCurrentTable.$inferSelect,
) =>
  OutcomeSignal.parse({
    id: row.id,
    schema_version: row.schema_version,
    project_id: row.project_id,
    company_id: row.company_id,
    decision_id: row.decision_id ?? undefined,
    idempotency_key: row.idempotency_key,
    result: row.result,
    summary: row.summary,
    validator_ref: {
      kind: row.validator_kind,
      id: row.validator_id,
    },
    validator_result_ref: {
      kind: row.validator_result_kind ?? row.validator_kind,
      id: row.validator_result_id ?? row.validator_id,
    },
    work_receipt_id: row.work_receipt_id ?? undefined,
    metric_contract_ref: {
      kind: row.metric_contract_kind,
      id: row.metric_contract_id,
      version: row.metric_contract_version,
    },
    observation_window: {
      starts_at: row.observation_window_starts_at,
      ends_at: row.observation_window_ends_at,
    },
    source_refs: JSON.parse(row.source_refs_json),
    observed_at: row.observed_at,
    current_status: current.current_status,
    validated_at: current.validated_at ?? undefined,
    created_at: row.created_at,
  })

const transitionFromRow = (row: typeof CompanyOutcomeSignalTransitionTable.$inferSelect) =>
  OutcomeSignalTransition.parse({
    id: row.id,
    outcome_signal_id: row.outcome_signal_id,
    sequence: row.sequence,
    idempotency_key: row.idempotency_key,
    from_status: row.from_status ?? undefined,
    status: row.to_status,
    reason: row.reason,
    actor_kind: row.actor_kind,
    actor_id: row.actor_id ?? undefined,
    validator_result_ref: {
      kind: row.validator_result_kind,
      id: row.validator_result_id,
    },
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  })

function currentFor(db: TxOrDb, outcome_signal_id: string) {
  const current = db
    .select()
    .from(CompanyOutcomeSignalCurrentTable)
    .where(eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, outcome_signal_id))
    .get()
  if (!current) throw new Error(`Outcome Signal current projection not found: ${outcome_signal_id}`)
  return current
}

function recoverCurrentProjection(db: TxOrDb, row: typeof CompanyOutcomeSignalTable.$inferSelect) {
  const transitions = db
    .select()
    .from(CompanyOutcomeSignalTransitionTable)
    .where(eq(CompanyOutcomeSignalTransitionTable.outcome_signal_id, row.id))
    .orderBy(asc(CompanyOutcomeSignalTransitionTable.sequence))
    .all()
  if (
    !transitions.length ||
    transitions.some((transition, index) => transition.sequence !== index + 1) ||
    transitions[0]?.from_status !== null ||
    transitions[0]?.to_status !== "observed"
  )
    throw new Error(`Outcome Signal transition history is corrupt: ${row.id}`)
  transitions.forEach((transition, index) => {
    const previous = transitions[index - 1]
    if (
      (index > 0 && transition.from_status !== previous?.to_status) ||
      (index > 0 &&
        !(
          (previous?.to_status === "observed" &&
            ["validated", "invalidated"].includes(transition.to_status)) ||
          (previous?.to_status === "validated" && transition.to_status === "invalidated")
        )) ||
      transition.validator_result_kind !== row.validator_result_kind ||
      transition.validator_result_id !== row.validator_result_id
    )
      throw new Error(`Outcome Signal transition history is corrupt: ${row.id}`)
  })
  const latest = transitions.at(-1)!
  const current = db
    .select()
    .from(CompanyOutcomeSignalCurrentTable)
    .where(eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, row.id))
    .get()
  const projection = {
    current_status: latest.to_status,
    latest_transition_id: latest.id,
    transition_count: transitions.length,
    validated_at: latest.to_status === "validated" ? latest.occurred_at : null,
    updated_at: latest.created_at,
  }
  if (!current)
    db.insert(CompanyOutcomeSignalCurrentTable)
      .values({ outcome_signal_id: row.id, ...projection })
      .run()
  if (
    current &&
    (current.current_status !== projection.current_status ||
      current.latest_transition_id !== projection.latest_transition_id ||
      current.transition_count !== projection.transition_count ||
      current.validated_at !== projection.validated_at)
  )
    db.update(CompanyOutcomeSignalCurrentTable)
      .set(projection)
      .where(eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, row.id))
      .run()
  return signalFromRow(row, currentFor(db, row.id))
}

function sameSubmission(
  row: typeof CompanyOutcomeSignalTable.$inferSelect,
  input: OutcomeSignalSubmissionValue,
  source_refs: OutcomeSignalSourceRefValue[],
) {
  return (
    row.schema_version === input.schema_version &&
    row.decision_id === (input.decision_id ?? null) &&
    row.result === input.result &&
    row.summary === input.summary &&
    row.validator_kind === input.validator_ref.kind &&
    row.validator_id === input.validator_ref.id &&
    row.validator_result_kind === input.validator_result_ref.kind &&
    row.validator_result_id === input.validator_result_ref.id &&
    row.work_receipt_id === (input.work_receipt_id ?? null) &&
    row.metric_contract_kind === input.metric_contract_ref.kind &&
    row.metric_contract_id === input.metric_contract_ref.id &&
    row.metric_contract_version === input.metric_contract_ref.version &&
    row.observation_window_starts_at === input.observation_window.starts_at &&
    row.observation_window_ends_at === input.observation_window.ends_at &&
    row.source_refs_json === JSON.stringify(source_refs) &&
    row.observed_at === input.observed_at
  )
}

function validateSourceReference(db: TxOrDb, project_id: string, reference: OutcomeSignalSourceRefValue) {
  if (reference.kind === "work_receipt") {
    const receipt = db.select().from(CompanyWorkReceiptTable).where(eq(CompanyWorkReceiptTable.id, reference.id)).get()
    if (
      !receipt ||
      receipt.project_id !== project_id ||
      !["processed", "rejected"].includes(receipt.processing_status)
    )
      throw new Error(`Outcome Signal references an unavailable terminal Work Receipt: ${reference.id}`)
    return
  }
  if (reference.kind === "validation_gate") {
    const gate = db.select().from(CompanyValidationGateTable).where(eq(CompanyValidationGateTable.id, reference.id)).get()
    if (!gate || gate.project_id !== project_id)
      throw new Error(`Outcome Signal references an unavailable Validation Gate: ${reference.id}`)
    return
  }
  const artifact = db.select().from(CompanyArtifactTable).where(eq(CompanyArtifactTable.id, reference.id)).get()
  if (!artifact || artifact.project_id !== project_id)
    throw new Error(`Outcome Signal references an unavailable Artifact: ${reference.id}`)
}

function validateValidator(
  db: TxOrDb,
  project_id: string,
  validator: OutcomeSignalValidatorRef,
  requirePassed = false,
) {
  if (validator.kind === "validation_gate") {
    const gate = db.select().from(CompanyValidationGateTable).where(eq(CompanyValidationGateTable.id, validator.id)).get()
    if (
      !gate ||
      gate.project_id !== project_id ||
      (requirePassed ? gate.status !== "passed" : !["passed", "failed"].includes(gate.status)) ||
      !gate.evaluated_at ||
      !WorkReceiptEvidenceRef.array().parse(JSON.parse(gate.evidence_refs_json)).length
    )
      throw new Error(`Outcome Signal requires a terminal evidence-backed Validation Gate: ${validator.id}`)
    return
  }
  const artifact = db.select().from(CompanyArtifactTable).where(eq(CompanyArtifactTable.id, validator.id)).get()
  if (
    !artifact ||
    artifact.project_id !== project_id ||
    artifact.created_by_agent_id ||
    !artifact.content ||
    !IndependentArtifactEvidence.safeParse(JSON.parse(artifact.evidence_json)).success
  )
    throw new Error(`Outcome Signal requires an independently verified Artifact: ${validator.id}`)
}

function validateDecisionReference(db: TxOrDb, project_id: string, decision_id?: string) {
  if (!decision_id) return
  const decision = db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, decision_id)).get()
  if (!decision || decision.scope_type !== "project" || decision.project_id !== project_id)
    throw new Error(`Outcome Signal references an unavailable project DecisionRecord: ${decision_id}`)
}

function linkDecisionOutcome(db: TxOrDb, decision_id: string | undefined, outcome_id: string) {
  if (!decision_id) return
  const projection = db
    .select()
    .from(DecisionCurrentProjectionTable)
    .where(eq(DecisionCurrentProjectionTable.decision_id, decision_id))
    .get()
  if (!projection) throw new Error(`Decision projection was not found: ${decision_id}`)
  const outcome_ids = z.array(z.string()).parse(JSON.parse(projection.outcome_ref_ids_json))
  if (outcome_ids.includes(outcome_id)) return
  db.update(DecisionCurrentProjectionTable)
    .set({
      outcome_ref_ids_json: JSON.stringify([...outcome_ids, outcome_id]),
      updated_at: Date.now(),
    })
    .where(eq(DecisionCurrentProjectionTable.decision_id, decision_id))
    .run()
}

function insertEvent(db: TxOrDb, project_id: string, signal: OutcomeSignalValue) {
  db.insert(CompanyProjectEventTable)
    .values({
      id: Identifier.ascending("event"),
      project_id,
      type: "outcome_signal.recorded",
      actor_id: null,
      data_json: JSON.stringify({
        outcome_signal_id: signal.id,
        schema_version: signal.schema_version,
        decision_id: signal.decision_id,
        result: signal.result,
        validator_ref: signal.validator_ref,
        source_refs: signal.source_refs,
      }),
      created_at: signal.created_at,
    })
    .run()
}

export type SubmissionResult = {
  signal: OutcomeSignalValue
  replayed: boolean
}

export interface Interface {
  readonly submit: (input: {
    project_id: string
    signal: OutcomeSignalSubmissionValue
  }) => Effect.Effect<SubmissionResult>
  readonly get: (id: string) => Effect.Effect<OutcomeSignalValue | undefined>
  readonly list: (
    project_id: string,
    page?: { limit: number; offset: number },
  ) => Effect.Effect<OutcomeSignalValue[]>
  readonly transition: (input: {
    outcome_signal_id: string
    transition: OutcomeSignalTransitionSubmissionValue
  }) => Effect.Effect<{ signal: OutcomeSignalValue; transition: OutcomeSignalTransitionValue; replayed: boolean }>
  readonly listTransitions: (outcome_signal_id: string) => Effect.Effect<OutcomeSignalTransitionValue[]>
  readonly recover: () => Effect.Effect<{ signal_ids: string[] }>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyOutcomeSignal") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const get = Effect.fn("CompanyOutcomeSignal.get")(function* (id: string) {
      return yield* Effect.sync(() =>
        Database.use((db) => {
          const row = db.select().from(CompanyOutcomeSignalTable).where(eq(CompanyOutcomeSignalTable.id, id)).get()
          return row ? signalFromRow(row, currentFor(db, row.id)) : undefined
        }),
      )
    })

    const list = Effect.fn("CompanyOutcomeSignal.list")(function* (
      project_id: string,
      page = { limit: 51, offset: 0 },
    ) {
      return yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyOutcomeSignalTable)
            .where(eq(CompanyOutcomeSignalTable.project_id, project_id))
            .orderBy(asc(CompanyOutcomeSignalTable.created_at), asc(CompanyOutcomeSignalTable.id))
            .limit(page.limit)
            .offset(page.offset)
            .all()
            .map((row) => signalFromRow(row, currentFor(db, row.id))),
        ),
      )
    })

    const submit = Effect.fn("CompanyOutcomeSignal.submit")(function* (raw: {
      project_id: string
      signal: OutcomeSignalSubmissionValue
    }) {
      const project_id = z.string().trim().min(1).parse(raw.project_id)
      const input = OutcomeSignalSubmission.parse(raw.signal)
      const source_refs = normalizedRefs(input.source_refs.map((reference) => OutcomeSignalSourceRef.parse(reference)))
      if (new Set(source_refs.map((reference) => `${reference.kind}:${reference.id}`)).size !== source_refs.length)
        throw new Error("Outcome Signal source references must be unique")
      if (
        !source_refs.some(
          (reference) => reference.kind === input.validator_ref.kind && reference.id === input.validator_ref.id,
        )
      )
        throw new Error("Outcome Signal validator must be included in source references")
      if (input.observed_at > Date.now() + 300_000) throw new Error("Outcome Signal observation time is in the future")
      if (
        input.observed_at < input.observation_window.starts_at ||
        input.observed_at > input.observation_window.ends_at
      )
        throw new Error("Outcome Signal observation must fall inside the observation window")
      if (
        input.validator_ref.kind !== input.validator_result_ref.kind ||
        input.validator_ref.id !== input.validator_result_ref.id
      )
        throw new Error("Outcome Signal validator result must identify the independent validator")
      if (input.result === "succeeded" && input.validator_ref.kind !== "validation_gate")
        throw new Error("Successful Outcome Signals require a passed Validation Gate")
      if (
        input.work_receipt_id &&
        !source_refs.some((reference) => reference.kind === "work_receipt" && reference.id === input.work_receipt_id)
      )
        throw new Error("Outcome Signal typed Work Receipt must be included in source references")
      return yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            if (!db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, project_id)).get())
              throw new Error(`Company project not found: ${project_id}`)
            validateDecisionReference(db, project_id, input.decision_id)
            const existing = db
              .select()
              .from(CompanyOutcomeSignalTable)
              .where(
                and(
                  eq(CompanyOutcomeSignalTable.project_id, project_id),
                  eq(CompanyOutcomeSignalTable.idempotency_key, input.idempotency_key),
                ),
              )
              .get()
            if (existing) {
              if (!sameSubmission(existing, input, source_refs))
                throw new Error(`Outcome Signal idempotency key ${input.idempotency_key} has different facts`)
              return { signal: signalFromRow(existing, currentFor(db, existing.id)), replayed: true }
            }
            source_refs.forEach((reference) => validateSourceReference(db, project_id, reference))
            validateValidator(db, project_id, input.validator_ref, input.result === "succeeded")
            const now = Date.now()
            const id = Identifier.ascending("outcomeSignal")
            const transition_id = Identifier.ascending("outcomeTransition")
            const project = db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, project_id)).get()!
            if (!project.company_id) throw new Error("Outcome Signal project is not attached to a company")
            db.insert(CompanyOutcomeSignalTable)
              .values({
                id,
                schema_version: input.schema_version,
                company_id: project.company_id,
                project_id,
                decision_id: input.decision_id ?? null,
                idempotency_key: input.idempotency_key,
                result: input.result,
                summary: input.summary,
                validator_kind: input.validator_ref.kind,
                validator_id: input.validator_ref.id,
                validator_result_kind: input.validator_result_ref.kind,
                validator_result_id: input.validator_result_ref.id,
                work_receipt_id: input.work_receipt_id ?? null,
                metric_contract_kind: input.metric_contract_ref.kind,
                metric_contract_id: input.metric_contract_ref.id,
                metric_contract_version: input.metric_contract_ref.version,
                observation_window_starts_at: input.observation_window.starts_at,
                observation_window_ends_at: input.observation_window.ends_at,
                source_refs_json: JSON.stringify(source_refs),
                observed_at: input.observed_at,
                created_at: now,
              })
              .run()
            db.insert(CompanyOutcomeSignalTransitionTable)
              .values({
                id: transition_id,
                outcome_signal_id: id,
                sequence: 1,
                idempotency_key: `observation:${input.idempotency_key}`,
                from_status: null,
                to_status: "observed",
                reason: "Independent outcome observation recorded pending explicit validation",
                actor_kind: "control_plane",
                actor_id: null,
                validator_result_kind: input.validator_result_ref.kind,
                validator_result_id: input.validator_result_ref.id,
                occurred_at: input.observed_at,
                created_at: now,
              })
              .run()
            db.insert(CompanyOutcomeSignalCurrentTable)
              .values({
                outcome_signal_id: id,
                current_status: "observed",
                latest_transition_id: transition_id,
                transition_count: 1,
                validated_at: null,
                updated_at: now,
              })
              .run()
            const signal = signalFromRow(
              db.select().from(CompanyOutcomeSignalTable).where(eq(CompanyOutcomeSignalTable.id, id)).get()!,
              currentFor(db, id),
            )
            linkDecisionOutcome(db, input.decision_id, id)
            insertEvent(db, project_id, signal)
            return { signal, replayed: false }
          },
          { behavior: "immediate" },
        ),
      )
    })

    const listTransitions = Effect.fn("CompanyOutcomeSignal.listTransitions")(function* (outcome_signal_id: string) {
      return yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyOutcomeSignalTransitionTable)
            .where(eq(CompanyOutcomeSignalTransitionTable.outcome_signal_id, outcome_signal_id))
            .orderBy(asc(CompanyOutcomeSignalTransitionTable.sequence))
            .all()
            .map(transitionFromRow),
        ),
      )
    })

    const transition = Effect.fn("CompanyOutcomeSignal.transition")(function* (raw: {
      outcome_signal_id: string
      transition: OutcomeSignalTransitionSubmissionValue
    }) {
      const input = OutcomeSignalTransitionSubmission.parse(raw.transition)
      if (input.occurred_at > Date.now() + 300_000) throw new Error("Outcome transition time is in the future")
      return yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const row = db
              .select()
              .from(CompanyOutcomeSignalTable)
              .where(eq(CompanyOutcomeSignalTable.id, raw.outcome_signal_id))
              .get()
            if (!row) throw new Error(`Outcome Signal not found: ${raw.outcome_signal_id}`)
            const existing = db
              .select()
              .from(CompanyOutcomeSignalTransitionTable)
              .where(
                and(
                  eq(CompanyOutcomeSignalTransitionTable.outcome_signal_id, row.id),
                  eq(CompanyOutcomeSignalTransitionTable.idempotency_key, input.idempotency_key),
                ),
              )
              .get()
            if (existing) {
              const parsed = transitionFromRow(existing)
              if (
                parsed.status !== input.status ||
                parsed.reason !== input.reason ||
                parsed.actor_kind !== input.actor_kind ||
                parsed.actor_id !== input.actor_id ||
                parsed.occurred_at !== input.occurred_at ||
                parsed.validator_result_ref.kind !== input.validator_result_ref.kind ||
                parsed.validator_result_ref.id !== input.validator_result_ref.id
              )
                throw new Error("Outcome transition idempotency key has different facts")
              return {
                signal: signalFromRow(row, currentFor(db, row.id)),
                transition: parsed,
                replayed: true,
              }
            }
            const current = currentFor(db, row.id)
            if (
              !(
                (current.current_status === "observed" &&
                  ["validated", "invalidated"].includes(input.status)) ||
                (current.current_status === "validated" && input.status === "invalidated")
              )
            )
              throw new Error(`Outcome Signal cannot transition from ${current.current_status}`)
            if (
              row.validator_result_kind !== input.validator_result_ref.kind ||
              row.validator_result_id !== input.validator_result_ref.id
            )
              throw new Error("Outcome transition validator result differs from the observed contract")
            if (row.result === "succeeded" && input.validator_result_ref.kind !== "validation_gate")
              throw new Error("Successful Outcome Signals require a passed Validation Gate")
            validateValidator(db, row.project_id, input.validator_result_ref, input.status === "validated")
            const now = Date.now()
            const transition_id = Identifier.ascending("outcomeTransition")
            db.insert(CompanyOutcomeSignalTransitionTable)
              .values({
                id: transition_id,
                outcome_signal_id: row.id,
                sequence: current.transition_count + 1,
                idempotency_key: input.idempotency_key,
                from_status: current.current_status,
                to_status: input.status,
                reason: input.reason,
                actor_kind: input.actor_kind,
                actor_id: input.actor_id ?? null,
                validator_result_kind: input.validator_result_ref.kind,
                validator_result_id: input.validator_result_ref.id,
                occurred_at: input.occurred_at,
                created_at: now,
              })
              .run()
            db.update(CompanyOutcomeSignalCurrentTable)
              .set({
                current_status: input.status,
                latest_transition_id: transition_id,
                transition_count: current.transition_count + 1,
                validated_at: input.status === "validated" ? input.occurred_at : null,
                updated_at: now,
              })
              .where(eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, row.id))
              .run()
            return {
              signal: signalFromRow(row, currentFor(db, row.id)),
              transition: transitionFromRow(
                db
                  .select()
                  .from(CompanyOutcomeSignalTransitionTable)
                  .where(eq(CompanyOutcomeSignalTransitionTable.id, transition_id))
                  .get()!,
              ),
              replayed: false,
            }
          },
          { behavior: "immediate" },
        ),
      )
    })

    const recover = Effect.fn("CompanyOutcomeSignal.recover")(function* () {
      return yield* Effect.sync(() =>
        Database.transaction(
          (db) => ({
            signal_ids: db
            .select()
            .from(CompanyOutcomeSignalTable)
            .orderBy(asc(CompanyOutcomeSignalTable.created_at), asc(CompanyOutcomeSignalTable.id))
            .all()
            .map((row) => {
              const signal = recoverCurrentProjection(db, row)
              validateDecisionReference(db, signal.project_id, signal.decision_id)
              signal.source_refs.forEach((reference) => validateSourceReference(db, signal.project_id, reference))
              if (signal.result === "succeeded" && signal.validator_result_ref.kind !== "validation_gate")
                throw new Error("Successful Outcome Signals require a passed Validation Gate")
              if (signal.current_status === "validated" || signal.result === "succeeded")
                validateValidator(db, signal.project_id, signal.validator_result_ref, true)
              linkDecisionOutcome(db, signal.decision_id, signal.id)
              return signal.id
            }),
          }),
          { behavior: "immediate" },
        ),
      )
    })

    return Service.of({ submit, get, list, transition, listTransitions, recover })
  }),
)

export const defaultLayer = layer

export * as CompanyOutcomeSignal from "./outcome-signal"
