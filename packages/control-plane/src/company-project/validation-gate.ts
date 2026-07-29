import { Context, Effect, Layer } from "effect"
import { and, asc, eq, inArray } from "drizzle-orm"
import { AgentRunTable } from "@/agent-run/agent-run.sql"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import type { TxOrDb } from "@/storage/db"
import { createWithDatabase as createAttentionWithDatabase } from "./attention"
import { observeGate, type AnchorObservation } from "./validation-anchor"
import {
  CompanyArtifactTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyValidationRepairTable,
  CompanyWorkItemDependencyTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "./company-project.sql"
import {
  GraphMutationProposal,
  PrerequisiteRepairRequest,
  ValidationCriterion,
  ValidationEvaluation,
  ValidationGate,
  ValidationGateCreate,
  ValidationRepairInput,
  WorkReceiptEvidenceRef,
  type GraphMutationProposal as GraphMutationProposalType,
  type PrerequisiteRepairRequest as PrerequisiteRepairRequestType,
  type ValidationCriterion as ValidationCriterionType,
  type ValidationEvidence as ValidationEvidenceType,
  type ValidationEvaluation as ValidationEvaluationType,
  type ValidationEvaluator as ValidationEvaluatorType,
  type ValidationGate as ValidationGateType,
  type ValidationGateCreate as ValidationGateCreateType,
  type ValidationRepairInput as ValidationRepairInputType,
} from "./schema"
export { validationPolicy } from "./validation-policy"

export type EvaluationResult = {
  status: "passed" | "failed"
  gate: ValidationGateType
  failed_criterion_ids: string[]
}

export type RepairResult = {
  status: "passed" | "retry_allowed" | "circuit_open"
  gate: ValidationGateType
  round: number
  replayed: boolean
}

export type RecoveryResult = {
  reset_gate_ids: string[]
  confirmed_gate_ids: string[]
  attention_gate_ids: string[]
}

const evaluatorSupport = {
  fact_match_v1: {
    anchors: ["prerequisite", "policy"],
    operators: ["exists", "equals"],
  },
  command_exit_v1: {
    anchors: ["unit_test", "integration_test"],
    operators: ["exit_code"],
  },
  artifact_digest_v1: {
    anchors: ["artifact"],
    operators: ["exists", "digest"],
  },
  source_reachability_v1: {
    anchors: ["source"],
    operators: ["exists", "equals"],
  },
  runtime_state_v1: {
    anchors: ["runtime", "device"],
    operators: ["exists", "equals"],
  },
  policy_invariant_v1: {
    anchors: ["policy"],
    operators: ["exists", "equals"],
  },
} satisfies Record<ValidationEvaluatorType, { anchors: string[]; operators: string[] }>

const normalizedCriteria = (criteria: ValidationCriterionType[]) =>
  [...criteria].sort((left, right) => left.id.localeCompare(right.id))

const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")

const parseCriteria = (value: string) => normalizedCriteria(ValidationCriterion.array().parse(JSON.parse(value)))

const parseEvidenceRefs = (value: string) => WorkReceiptEvidenceRef.array().parse(JSON.parse(value))

function gateFromRow(row: typeof CompanyValidationGateTable.$inferSelect) {
  return ValidationGate.parse({
    id: row.id,
    project_id: row.project_id,
    work_item_id: row.work_item_id ?? undefined,
    kind: row.kind,
    status: row.status,
    criteria: JSON.parse(row.criteria_json),
    criteria_sha256: row.criteria_sha256,
    blocking_work_item_ids: JSON.parse(row.blocking_work_item_ids_json),
    evidence_refs: JSON.parse(row.evidence_refs_json),
    evaluator: row.evaluator,
    repair_round: row.repair_round,
    max_repair_rounds: row.max_repair_rounds,
    failure_summary: row.failure_summary ?? undefined,
    supersedes_gate_id: row.supersedes_gate_id ?? undefined,
    created_at: row.created_at,
    evaluated_at: row.evaluated_at ?? undefined,
  })
}

function insertEvent(db: TxOrDb, project_id: string, type: string, data: Record<string, unknown>, created_at: number) {
  db.insert(CompanyProjectEventTable)
    .values({
      id: Identifier.ascending("event"),
      project_id,
      type,
      actor_id: null,
      data_json: JSON.stringify(data),
      created_at,
    })
    .run()
}

function assertEvaluator(criteria: ValidationCriterionType[], evaluator: ValidationEvaluatorType) {
  const support = evaluatorSupport[evaluator]
  criteria.forEach((criterion) => {
    if (
      !support.anchors.includes(criterion.anchor.kind) ||
      !support.operators.includes(criterion.operator) ||
      (criterion.operator === "exists" && typeof criterion.expected !== "boolean") ||
      (criterion.operator === "exit_code" &&
        (typeof criterion.expected !== "number" || !Number.isInteger(criterion.expected))) ||
      (criterion.operator === "digest" &&
        (typeof criterion.expected !== "string" || !/^[a-f0-9]{64}$/.test(criterion.expected)))
    ) {
      throw new Error(`Evaluator ${evaluator} cannot enforce criterion ${criterion.id}`)
    }
  })
}

function evidenceReferenceExists(db: TxOrDb, project_id: string, reference: WorkReceiptEvidenceRef) {
  if (reference.kind === "artifact") {
    return (
      db
        .select({ project_id: CompanyArtifactTable.project_id })
        .from(CompanyArtifactTable)
        .where(eq(CompanyArtifactTable.id, reference.id))
        .get()?.project_id === project_id
    )
  }
  if (reference.kind === "agent_run") {
    return (
      db
        .select({ project_id: AgentRunTable.company_project_id })
        .from(AgentRunTable)
        .where(eq(AgentRunTable.id, reference.id))
        .get()?.project_id === project_id
    )
  }
  return (
    db
      .select({ project_id: CompanyProjectEventTable.project_id })
      .from(CompanyProjectEventTable)
      .where(eq(CompanyProjectEventTable.id, reference.id))
      .get()?.project_id === project_id
  )
}

function persistAnchorEvidence(
  db: TxOrDb,
  row: typeof CompanyValidationGateTable.$inferSelect,
  observations: AnchorObservation[],
  created_at: number,
) {
  return observations.map((observation): ValidationEvidenceType => {
    const event_id = Identifier.ascending("event")
    db.insert(CompanyProjectEventTable)
      .values({
        id: event_id,
        project_id: row.project_id,
        type: "validation_anchor.checked",
        actor_id: null,
        data_json: JSON.stringify({
          gate_id: row.id,
          criterion_id: observation.criterion_id,
          anchor: observation.anchor,
          reference: observation.reference,
          observed: observation.observed,
          warning: observation.warning,
          source_ref: observation.source_ref,
        }),
        created_at,
      })
      .run()
    return {
      criterion_id: observation.criterion_id,
      anchor: observation.anchor,
      reference: observation.reference,
      observed: observation.observed,
      evidence_ref: { kind: "project_event", id: event_id },
      warning: observation.warning,
    }
  })
}

function evaluateRow(db: TxOrDb, row: typeof CompanyValidationGateTable.$inferSelect, input: ValidationEvaluationType) {
  if (row.evaluator !== input.evaluator) {
    throw new Error("Validation evaluator cannot change while a Gate is active")
  }
  const criteria = parseCriteria(row.criteria_json)
  assertEvaluator(criteria, input.evaluator)
  if (new Set(input.evidence.map((item) => item.criterion_id)).size !== input.evidence.length) {
    throw new Error("Validation evidence contains duplicate criteria")
  }
  const evidence = new Map(input.evidence.map((item) => [item.criterion_id, item]))
  const failed_criterion_ids = criteria.flatMap((criterion) => {
    const item = evidence.get(criterion.id)
    if (
      !item ||
      item.anchor !== criterion.anchor.kind ||
      item.reference !== criterion.anchor.reference ||
      item.warning ||
      !evidenceReferenceExists(db, row.project_id, item.evidence_ref)
    ) {
      return [criterion.id]
    }
    const passed =
      criterion.operator === "exists" || criterion.operator === "equals"
        ? item.observed === criterion.expected
        : criterion.operator === "exit_code"
          ? typeof item.observed === "number" && Number.isInteger(item.observed) && item.observed === criterion.expected
          : typeof item.observed === "string" && item.observed === criterion.expected
    return passed ? [] : [criterion.id]
  })
  const evidence_refs = [
    ...new Map(
      input.evidence.map((item) => [`${item.evidence_ref.kind}:${item.evidence_ref.id}`, item.evidence_ref]),
    ).values(),
  ]
  return {
    status: failed_criterion_ids.length ? ("failed" as const) : ("passed" as const),
    failed_criterion_ids,
    evidence_refs,
    failure_summary: failed_criterion_ids.length ? `Failed criteria: ${failed_criterion_ids.join(", ")}` : undefined,
  }
}

function sameGate(
  row: typeof CompanyValidationGateTable.$inferSelect,
  input: ValidationGateCreateType,
  criteria: ValidationCriterionType[],
) {
  return (
    row.project_id === input.project_id &&
    row.work_item_id === (input.work_item_id ?? null) &&
    row.kind === input.kind &&
    row.criteria_json === JSON.stringify(criteria) &&
    row.blocking_work_item_ids_json === JSON.stringify([...input.blocking_work_item_ids].sort()) &&
    row.evaluator === input.evaluator &&
    row.max_repair_rounds === input.max_repair_rounds &&
    row.supersedes_gate_id === (input.supersedes_gate_id ?? null)
  )
}

export interface Interface {
  readonly create: (input: ValidationGateCreateType) => Effect.Effect<ValidationGateType>
  readonly evaluate: (input: ValidationEvaluationType) => Effect.Effect<EvaluationResult>
  readonly evaluatePending: (gate_id: string) => Effect.Effect<EvaluationResult>
  readonly evaluateProjectPending: (project_id: string) => Effect.Effect<EvaluationResult[]>
  readonly repair: (input: ValidationRepairInputType) => Effect.Effect<RepairResult>
  readonly planPrerequisiteRepair: (input: PrerequisiteRepairRequestType) => Effect.Effect<GraphMutationProposalType>
  readonly get: (id: string) => Effect.Effect<ValidationGateType | undefined>
  readonly list: (project_id: string) => Effect.Effect<ValidationGateType[]>
  readonly recover: () => Effect.Effect<RecoveryResult>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyValidationGate") {}

export function makeLayer() {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const get = Effect.fn("CompanyValidationGate.get")(function* (id: string) {
        const row = yield* Effect.sync(() =>
          Database.use((db) =>
            db.select().from(CompanyValidationGateTable).where(eq(CompanyValidationGateTable.id, id)).get(),
          ),
        )
        return row ? gateFromRow(row) : undefined
      })

      const list = Effect.fn("CompanyValidationGate.list")(function* (project_id: string) {
        return (yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(CompanyValidationGateTable)
              .where(eq(CompanyValidationGateTable.project_id, project_id))
              .orderBy(asc(CompanyValidationGateTable.created_at), asc(CompanyValidationGateTable.id))
              .all(),
          ),
        )).map(gateFromRow)
      })

      const evaluatePending = Effect.fn("CompanyValidationGate.evaluatePending")(function* (gate_id: string) {
        const claimed = yield* Effect.sync(() =>
          Database.transaction(
            (db) => {
              const row = db
                .select()
                .from(CompanyValidationGateTable)
                .where(eq(CompanyValidationGateTable.id, gate_id))
                .get()
              if (!row) throw new Error(`Validation Gate not found: ${gate_id}`)
              if (row.status === "passed" || row.status === "failed") return gateFromRow(row)
              if (row.status !== "pending" && row.status !== "running")
                throw new Error(`Validation Gate ${row.id} cannot be evaluated from ${row.status}`)
              if (row.status === "pending") {
                const now = Date.now()
                db.update(CompanyValidationGateTable)
                  .set({ status: "running" })
                  .where(
                    and(eq(CompanyValidationGateTable.id, row.id), eq(CompanyValidationGateTable.status, "pending")),
                  )
                  .run()
                insertEvent(
                  db,
                  row.project_id,
                  "validation_gate.evaluation_started",
                  { gate_id: row.id, evaluator: row.evaluator },
                  now,
                )
              }
              return gateFromRow(
                db.select().from(CompanyValidationGateTable).where(eq(CompanyValidationGateTable.id, row.id)).get()!,
              )
            },
            { behavior: "immediate" },
          ),
        )
        if (claimed.status === "passed" || claimed.status === "failed")
          return {
            status: claimed.status,
            gate: claimed,
            failed_criterion_ids: claimed.status === "failed" ? claimed.criteria.map((criterion) => criterion.id) : [],
          }
        const observations = yield* Effect.promise(() => observeGate(claimed))
        return yield* Effect.sync(() =>
          Database.transaction(
            (db): EvaluationResult => {
              const row = db
                .select()
                .from(CompanyValidationGateTable)
                .where(eq(CompanyValidationGateTable.id, gate_id))
                .get()
              if (!row) throw new Error(`Validation Gate not found: ${gate_id}`)
              if (row.status === "passed" || row.status === "failed") {
                const gate = gateFromRow(row)
                return {
                  status: row.status,
                  gate,
                  failed_criterion_ids: row.status === "failed" ? gate.criteria.map((criterion) => criterion.id) : [],
                }
              }
              if (row.status !== "running")
                throw new Error(`Validation Gate ${row.id} cannot finish evaluation from ${row.status}`)
              const now = Date.now()
              const result = evaluateRow(db, row, {
                gate_id: row.id,
                evaluator: gateFromRow(row).evaluator,
                evidence: persistAnchorEvidence(db, row, observations, now),
              })
              db.update(CompanyValidationGateTable)
                .set({
                  status: result.status,
                  evidence_refs_json: JSON.stringify(result.evidence_refs),
                  failure_summary: result.failure_summary ?? null,
                  evaluated_at: now,
                })
                .where(eq(CompanyValidationGateTable.id, row.id))
                .run()
              insertEvent(
                db,
                row.project_id,
                "validation_gate.evaluated",
                {
                  gate_id: row.id,
                  evaluator: row.evaluator,
                  criteria_sha256: row.criteria_sha256,
                  status: result.status,
                  failed_criterion_ids: result.failed_criterion_ids,
                  repair_round: row.repair_round,
                },
                now,
              )
              return {
                status: result.status,
                gate: gateFromRow(
                  db.select().from(CompanyValidationGateTable).where(eq(CompanyValidationGateTable.id, row.id)).get()!,
                ),
                failed_criterion_ids: result.failed_criterion_ids,
              }
            },
            { behavior: "immediate" },
          ),
        )
      })

      const evaluateProjectPending = Effect.fn("CompanyValidationGate.evaluateProjectPending")(function* (
        project_id: string,
      ) {
        const ids = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select({ id: CompanyValidationGateTable.id })
              .from(CompanyValidationGateTable)
              .where(
                and(
                  eq(CompanyValidationGateTable.project_id, project_id),
                  inArray(CompanyValidationGateTable.status, ["pending", "running"]),
                ),
              )
              .orderBy(asc(CompanyValidationGateTable.created_at), asc(CompanyValidationGateTable.id))
              .all()
              .map((row) => row.id),
          ),
        )
        return yield* Effect.forEach(ids, evaluatePending, { concurrency: 1 })
      })

      const create = Effect.fn("CompanyValidationGate.create")(function* (raw: ValidationGateCreateType) {
        const input = ValidationGateCreate.parse(raw)
        const criteria = normalizedCriteria(input.criteria)
        if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) {
          throw new Error("Validation Gate criteria must have unique ids")
        }
        assertEvaluator(criteria, input.evaluator)
        const created = yield* Effect.sync(() =>
          Database.transaction(
            (db) => {
              if (
                !db
                  .select({ id: CompanyProjectTable.id })
                  .from(CompanyProjectTable)
                  .where(eq(CompanyProjectTable.id, input.project_id))
                  .get()
              ) {
                throw new Error(`Company project not found: ${input.project_id}`)
              }
              const workItemIDs = [
                ...new Set([...input.blocking_work_item_ids, ...(input.work_item_id ? [input.work_item_id] : [])]),
              ]
              const existingWorkItemIDs = new Set(
                db
                  .select({ id: CompanyWorkItemTable.id })
                  .from(CompanyWorkItemTable)
                  .where(
                    and(
                      eq(CompanyWorkItemTable.project_id, input.project_id),
                      inArray(CompanyWorkItemTable.id, workItemIDs),
                    ),
                  )
                  .all()
                  .map((item) => item.id),
              )
              if (workItemIDs.some((id) => !existingWorkItemIDs.has(id))) {
                throw new Error("Validation Gate references work outside its project")
              }
              const previous = input.supersedes_gate_id
                ? db
                    .select()
                    .from(CompanyValidationGateTable)
                    .where(eq(CompanyValidationGateTable.id, input.supersedes_gate_id))
                    .get()
                : undefined
              if (input.supersedes_gate_id && (!previous || previous.project_id !== input.project_id)) {
                throw new Error("Superseded Validation Gate is unavailable")
              }
              if (
                previous &&
                (previous.kind !== input.kind ||
                  previous.work_item_id !== (input.work_item_id ?? null) ||
                  previous.evaluator !== input.evaluator ||
                  gateFromRow(previous).blocking_work_item_ids.some(
                    (work_item_id) => !input.blocking_work_item_ids.includes(work_item_id),
                  ) ||
                  parseCriteria(previous.criteria_json).some(
                    (criterion) =>
                      JSON.stringify(criteria.find((candidate) => candidate.id === criterion.id)) !==
                      JSON.stringify(criterion),
                  ))
              ) {
                throw new Error("Validation Gate replacement cannot weaken or rewrite existing criteria")
              }
              const id = input.id ?? Identifier.ascending("validationGate")
              const existing = db
                .select()
                .from(CompanyValidationGateTable)
                .where(eq(CompanyValidationGateTable.id, id))
                .get()
              if (existing) {
                if (!sameGate(existing, input, criteria)) {
                  throw new Error("Validation Gate id conflicts with persisted facts")
                }
                return gateFromRow(existing)
              }
              const now = Date.now()
              db.insert(CompanyValidationGateTable)
                .values({
                  id,
                  project_id: input.project_id,
                  work_item_id: input.work_item_id ?? null,
                  kind: input.kind,
                  status: "pending",
                  criteria_json: JSON.stringify(criteria),
                  criteria_sha256: digest(criteria),
                  blocking_work_item_ids_json: JSON.stringify([...input.blocking_work_item_ids].sort()),
                  evidence_refs_json: "[]",
                  evaluator: input.evaluator,
                  repair_round: 0,
                  max_repair_rounds: input.max_repair_rounds,
                  failure_summary: null,
                  supersedes_gate_id: input.supersedes_gate_id ?? null,
                  created_at: now,
                  evaluated_at: null,
                })
                .run()
              if (previous) {
                db.update(CompanyValidationGateTable)
                  .set({ status: "superseded" })
                  .where(eq(CompanyValidationGateTable.id, previous.id))
                  .run()
              }
              insertEvent(
                db,
                input.project_id,
                "validation_gate.created",
                {
                  gate_id: id,
                  kind: input.kind,
                  criteria_sha256: digest(criteria),
                  blocking_work_item_ids: [...input.blocking_work_item_ids].sort(),
                },
                now,
              )
              return gateFromRow(
                db.select().from(CompanyValidationGateTable).where(eq(CompanyValidationGateTable.id, id)).get()!,
              )
            },
            { behavior: "immediate" },
          ),
        )
        if (created.status === "pending" || created.status === "running")
          return (yield* evaluatePending(created.id)).gate
        return created
      })

      const evaluate = Effect.fn("CompanyValidationGate.evaluate")(function* (raw: ValidationEvaluationType) {
        const input = ValidationEvaluation.parse(raw)
        const gate = yield* get(input.gate_id)
        if (!gate) throw new Error(`Validation Gate not found: ${input.gate_id}`)
        if (gate.evaluator !== input.evaluator)
          throw new Error("Validation evaluator cannot change while a Gate is active")
        return yield* evaluatePending(input.gate_id)
      })

      const planPrerequisiteRepair = Effect.fn("CompanyValidationGate.planPrerequisiteRepair")(function* (
        raw: PrerequisiteRepairRequestType,
      ) {
        const input = PrerequisiteRepairRequest.parse(raw)
        return yield* Effect.sync(() =>
          Database.use((db) => {
            const gate = db
              .select()
              .from(CompanyValidationGateTable)
              .where(eq(CompanyValidationGateTable.id, input.gate_id))
              .get()
            if (!gate || gate.kind !== "prerequisite" || gate.status !== "failed") {
              throw new Error("Prerequisite repair requires a failed prerequisite Gate")
            }
            const receipt = db
              .select()
              .from(CompanyWorkReceiptTable)
              .where(eq(CompanyWorkReceiptTable.id, input.trigger_receipt_id))
              .get()
            if (
              !receipt ||
              receipt.project_id !== gate.project_id ||
              receipt.processing_status !== "processed" ||
              !parseEvidenceRefs(receipt.evidence_refs_json).length ||
              (!JSON.parse(receipt.invalidated_assumptions_json).length && !JSON.parse(receipt.blockers_json).length)
            ) {
              throw new Error("Prerequisite repair requires a processed evidence-backed Receipt")
            }
            if (input.recovery_item.purpose !== "recovery") {
              throw new Error("Prerequisite repair must create a recovery Work Item")
            }
            const project = db
              .select()
              .from(CompanyProjectTable)
              .where(eq(CompanyProjectTable.id, gate.project_id))
              .get()!
            const blocking_work_item_ids = gateFromRow(gate).blocking_work_item_ids
            const replacedDependencies = db
              .select()
              .from(CompanyWorkItemDependencyTable)
              .where(
                and(
                  inArray(CompanyWorkItemDependencyTable.work_item_id, blocking_work_item_ids),
                  eq(CompanyWorkItemDependencyTable.depends_on_id, receipt.work_item_id),
                ),
              )
              .all()
            return GraphMutationProposal.parse({
              project_id: gate.project_id,
              trigger_receipt_id: receipt.id,
              expected_revision: project.graph_revision,
              orchestrator_version: input.orchestrator_version,
              idempotency_key: input.idempotency_key,
              decision: "expand",
              rationale: `Repair failed prerequisite Gate ${gate.id} without changing ${gate.criteria_sha256}`,
              evidence_refs: parseEvidenceRefs(receipt.evidence_refs_json),
              operations: [
                { type: "add_work_item", item: input.recovery_item },
                ...replacedDependencies.map((dependency) => ({
                  type: "remove_dependency" as const,
                  work_item_id: dependency.work_item_id,
                  depends_on_id: dependency.depends_on_id,
                })),
                ...blocking_work_item_ids.map((work_item_id) => ({
                  type: "add_dependency" as const,
                  work_item_id,
                  depends_on_id: input.recovery_item.id,
                })),
              ],
            })
          }),
        )
      })

      const repair = Effect.fn("CompanyValidationGate.repair")(function* (raw: ValidationRepairInputType) {
        const input = ValidationRepairInput.parse(raw)
        const gate = yield* get(input.gate_id)
        if (!gate) throw new Error(`Validation Gate not found: ${input.gate_id}`)
        if (gate.evaluator !== input.evaluator)
          throw new Error("Validation evaluator cannot change while a Gate is active")
        const observations = yield* Effect.promise(() => observeGate(gate, input.evidence))
        return yield* Effect.sync(() =>
          Database.transaction(
            (db): RepairResult => {
              const row = db
                .select()
                .from(CompanyValidationGateTable)
                .where(eq(CompanyValidationGateTable.id, input.gate_id))
                .get()
              if (!row) throw new Error(`Validation Gate not found: ${input.gate_id}`)
              if (
                input.diagnosis.evidence_refs.some(
                  (reference) => !evidenceReferenceExists(db, row.project_id, reference),
                )
              ) {
                throw new Error("Failure diagnosis references unavailable evidence")
              }
              const input_sha256 = digest({ ...input, evidence: observations })
              const existing = db
                .select()
                .from(CompanyValidationRepairTable)
                .where(
                  and(
                    eq(CompanyValidationRepairTable.gate_id, row.id),
                    eq(CompanyValidationRepairTable.idempotency_key, input.idempotency_key),
                  ),
                )
                .get()
              if (existing) {
                if (existing.input_sha256 !== input_sha256) {
                  throw new Error("Validation repair idempotency key conflicts with persisted facts")
                }
                return {
                  status:
                    existing.result === "passed"
                      ? "passed"
                      : existing.round >= row.max_repair_rounds
                        ? "circuit_open"
                        : "retry_allowed",
                  gate: gateFromRow(row),
                  round: existing.round,
                  replayed: true,
                }
              }
              if (row.status !== "failed") {
                throw new Error(`Validation Gate ${row.id} cannot repair from ${row.status}`)
              }
              if (row.repair_round >= row.max_repair_rounds) {
                return {
                  status: "circuit_open",
                  gate: gateFromRow(row),
                  round: row.repair_round,
                  replayed: true,
                }
              }
              const now = Date.now()
              const realEvidence = persistAnchorEvidence(db, row, observations, now)
              const result = evaluateRow(db, row, {
                gate_id: row.id,
                evaluator: input.evaluator,
                evidence: realEvidence,
              })
              const round = row.repair_round + 1
              db.insert(CompanyValidationRepairTable)
                .values({
                  id: Identifier.ascending("validationRepair"),
                  gate_id: row.id,
                  round,
                  idempotency_key: input.idempotency_key,
                  input_sha256,
                  failure_kind: input.diagnosis.kind,
                  diagnosis_json: JSON.stringify(input.diagnosis),
                  fix_summary: input.fix_summary,
                  repair_diff_json: JSON.stringify(input.repair_diff),
                  reverify_evidence_json: JSON.stringify(realEvidence),
                  result: result.status,
                  created_at: now,
                })
                .run()
              db.update(CompanyValidationGateTable)
                .set({
                  status: result.status,
                  evidence_refs_json: JSON.stringify(result.evidence_refs),
                  repair_round: round,
                  failure_summary: result.failure_summary ?? null,
                  evaluated_at: now,
                })
                .where(eq(CompanyValidationGateTable.id, row.id))
                .run()
              insertEvent(
                db,
                row.project_id,
                "failure_diagnosis.recorded",
                {
                  gate_id: row.id,
                  repair_round: round,
                  diagnosis: input.diagnosis,
                },
                now,
              )
              insertEvent(
                db,
                row.project_id,
                "graph_repair.completed",
                {
                  gate_id: row.id,
                  repair_round: round,
                  fix_summary: input.fix_summary,
                  repair_diff: input.repair_diff,
                  result: result.status,
                },
                now,
              )
              insertEvent(
                db,
                row.project_id,
                "validation_gate.evaluated",
                {
                  gate_id: row.id,
                  evaluator: row.evaluator,
                  criteria_sha256: row.criteria_sha256,
                  status: result.status,
                  failed_criterion_ids: result.failed_criterion_ids,
                  repair_round: round,
                },
                now,
              )
              if (result.status === "failed" && round === row.max_repair_rounds) {
                const attention = createAttentionWithDatabase(db, {
                  project_id: row.project_id,
                  idempotency_key: `validation-circuit:${row.id}`,
                  issue: {
                    issue_kind: "acceptance_change",
                    risk: "high",
                    materiality: "acceptance",
                  },
                  title: "Validation Gate requires a decision",
                  summary: result.failure_summary ?? `Validation Gate ${row.id} failed`,
                  required_decision: "Resolve the failed Gate or supersede its scope",
                  source_refs: [
                    { kind: "project", id: row.project_id },
                    { kind: "validation_gate", id: row.id },
                  ],
                })
                if (!attention.replayed)
                  insertEvent(
                    db,
                    row.project_id,
                    "attention.requested",
                    {
                      attention_id: attention.record.id,
                      validation_gate_id: row.id,
                    },
                    now,
                  )
              }
              const gate = gateFromRow(
                db.select().from(CompanyValidationGateTable).where(eq(CompanyValidationGateTable.id, row.id)).get()!,
              )
              return {
                status:
                  result.status === "passed"
                    ? "passed"
                    : round === row.max_repair_rounds
                      ? "circuit_open"
                      : "retry_allowed",
                gate,
                round,
                replayed: false,
              }
            },
            { behavior: "immediate" },
          ),
        )
      })

      const recover = Effect.fn("CompanyValidationGate.recover")(function* () {
        const recovered = yield* Effect.sync(() =>
          Database.transaction(
            (db): RecoveryResult => {
              const reset_gate_ids: string[] = []
              const confirmed_gate_ids: string[] = []
              const attention_gate_ids: string[] = []
              db.select()
                .from(CompanyValidationGateTable)
                .where(inArray(CompanyValidationGateTable.status, ["pending", "running", "passed", "failed"]))
                .orderBy(asc(CompanyValidationGateTable.created_at), asc(CompanyValidationGateTable.id))
                .all()
                .forEach((row) => {
                  const references = parseEvidenceRefs(row.evidence_refs_json)
                  const invalidPassed =
                    row.status === "passed" &&
                    (!row.evaluated_at ||
                      !references.length ||
                      references.some((reference) => !evidenceReferenceExists(db, row.project_id, reference)))
                  if (row.status === "running" || invalidPassed) {
                    const now = Date.now()
                    db.update(CompanyValidationGateTable)
                      .set({
                        status: "pending",
                        evidence_refs_json: "[]",
                        failure_summary: invalidPassed
                          ? "Recovery requires deterministic re-evaluation"
                          : row.failure_summary,
                        evaluated_at: null,
                      })
                      .where(eq(CompanyValidationGateTable.id, row.id))
                      .run()
                    insertEvent(
                      db,
                      row.project_id,
                      "validation_gate.recovered",
                      {
                        gate_id: row.id,
                        previous_status: row.status,
                        next_status: "pending",
                        reason: invalidPassed ? "invalid_pass_evidence" : "interrupted_evaluation",
                      },
                      now,
                    )
                    reset_gate_ids.push(row.id)
                    return
                  }
                  if (row.status === "failed" && row.repair_round >= row.max_repair_rounds) {
                    const attention = createAttentionWithDatabase(db, {
                      project_id: row.project_id,
                      idempotency_key: `validation-circuit:${row.id}`,
                      issue: {
                        issue_kind: "acceptance_change",
                        risk: "high",
                        materiality: "acceptance",
                      },
                      title: "Validation Gate requires a decision",
                      summary: row.failure_summary ?? `Validation Gate ${row.id} failed`,
                      required_decision: "Resolve the failed Gate or supersede its scope",
                      source_refs: [
                        { kind: "project", id: row.project_id },
                        { kind: "validation_gate", id: row.id },
                      ],
                    })
                    if (!attention.replayed) {
                      insertEvent(
                        db,
                        row.project_id,
                        "attention.requested",
                        {
                          attention_id: attention.record.id,
                          validation_gate_id: row.id,
                        },
                        Date.now(),
                      )
                      attention_gate_ids.push(row.id)
                    }
                  }
                  confirmed_gate_ids.push(row.id)
                })
              return { reset_gate_ids, confirmed_gate_ids, attention_gate_ids }
            },
            { behavior: "immediate" },
          ),
        )
        return recovered
      })

      return Service.of({
        create,
        evaluate,
        evaluatePending,
        evaluateProjectPending,
        repair,
        planPrerequisiteRepair,
        get,
        list,
        recover,
      })
    }),
  )
}

export const defaultLayer = makeLayer()

export * as CompanyValidationGate from "./validation-gate"
