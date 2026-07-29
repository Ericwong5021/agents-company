import { Context, Effect, Layer } from "effect"
import { and, asc, eq } from "drizzle-orm"
import z from "zod"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import type { TxOrDb } from "@/storage/db"
import { DecisionCurrentProjectionTable, DecisionRecordTable } from "@/founder-os/decision-ledger.sql"
import {
  CompanyArtifactTable,
  CompanyOutcomeSignalTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyWorkReceiptTable,
} from "./company-project.sql"
import {
  OutcomeSignal,
  OutcomeSignalSourceRef,
  OutcomeSignalSubmission,
  WorkReceiptEvidenceRef,
  type OutcomeSignal as OutcomeSignalValue,
  type OutcomeSignalSourceRef as OutcomeSignalSourceRefValue,
  type OutcomeSignalSubmission as OutcomeSignalSubmissionValue,
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

const signalFromRow = (row: typeof CompanyOutcomeSignalTable.$inferSelect) =>
  OutcomeSignal.parse({
    id: row.id,
    schema_version: row.schema_version,
    project_id: row.project_id,
    decision_id: row.decision_id ?? undefined,
    idempotency_key: row.idempotency_key,
    result: row.result,
    summary: row.summary,
    validator_ref: {
      kind: row.validator_kind,
      id: row.validator_id,
    },
    source_refs: JSON.parse(row.source_refs_json),
    observed_at: row.observed_at,
    created_at: row.created_at,
  })

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

function validateValidator(db: TxOrDb, project_id: string, validator: OutcomeSignalValidatorRef) {
  if (validator.kind === "validation_gate") {
    const gate = db.select().from(CompanyValidationGateTable).where(eq(CompanyValidationGateTable.id, validator.id)).get()
    if (
      !gate ||
      gate.project_id !== project_id ||
      !["passed", "failed"].includes(gate.status) ||
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
          return row ? signalFromRow(row) : undefined
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
            .map(signalFromRow),
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
              return { signal: signalFromRow(existing), replayed: true }
            }
            source_refs.forEach((reference) => validateSourceReference(db, project_id, reference))
            validateValidator(db, project_id, input.validator_ref)
            const now = Date.now()
            const id = Identifier.ascending("outcomeSignal")
            db.insert(CompanyOutcomeSignalTable)
              .values({
                id,
                schema_version: input.schema_version,
                project_id,
                decision_id: input.decision_id ?? null,
                idempotency_key: input.idempotency_key,
                result: input.result,
                summary: input.summary,
                validator_kind: input.validator_ref.kind,
                validator_id: input.validator_ref.id,
                source_refs_json: JSON.stringify(source_refs),
                observed_at: input.observed_at,
                created_at: now,
              })
              .run()
            const signal = signalFromRow(
              db.select().from(CompanyOutcomeSignalTable).where(eq(CompanyOutcomeSignalTable.id, id)).get()!,
            )
            linkDecisionOutcome(db, input.decision_id, id)
            insertEvent(db, project_id, signal)
            return { signal, replayed: false }
          },
          { behavior: "immediate" },
        ),
      )
    })

    const recover = Effect.fn("CompanyOutcomeSignal.recover")(function* () {
      return yield* Effect.sync(() => ({
        signal_ids: Database.use((db) =>
          db
            .select()
            .from(CompanyOutcomeSignalTable)
            .orderBy(asc(CompanyOutcomeSignalTable.created_at), asc(CompanyOutcomeSignalTable.id))
            .all()
            .map((row) => {
              const signal = signalFromRow(row)
              validateDecisionReference(db, signal.project_id, signal.decision_id)
              signal.source_refs.forEach((reference) => validateSourceReference(db, signal.project_id, reference))
              validateValidator(db, signal.project_id, signal.validator_ref)
              linkDecisionOutcome(db, signal.decision_id, signal.id)
              return signal.id
            }),
        ),
      }))
    })

    return Service.of({ submit, get, list, recover })
  }),
)

export const defaultLayer = layer

export * as CompanyOutcomeSignal from "./outcome-signal"
