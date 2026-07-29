import { createHash } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import z from "zod"
import { CompanyProjectTable } from "@/company-project/company-project.sql"
import { Identifier } from "@/id/id"
import { Database, and, asc, eq } from "@/storage"
import { CompanyGateObservationTable } from "./gate-observation.sql"

const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const SourceReference = z
  .object({
    kind: z.enum([
      "project",
      "project_event",
      "work_item",
      "work_attempt",
      "work_receipt",
      "graph_mutation",
      "project_assignment",
      "validation_gate",
      "approval_gate",
      "attention",
      "agent_run",
      "artifact",
      "rollout_repeat",
      "rollout_rollback",
      "external_report",
    ]),
    id: z.string().trim().min(1),
  })
  .strict()

export const GateObservationEventType = z.enum([
  "terminal.invariant_checked",
  "receipt.recovery_checked",
  "graph_mutation.recovery_checked",
  "delivery.checked",
  "validation_anchor.checked",
  "interruption.checked",
  "review_presence.checked",
  "quality_pair.checked",
  "benchmark.checked",
  "candidate_terminal.checked",
  "shadow_pair.checked",
  "trust.false_state_detected",
  "connection.lost",
  "connection.recovered",
  "graph_mutation.recovered",
  "delivery.presented",
  "delivery.artifact_opened",
  "delivery.criterion_evaluated",
  "validation_gate.evaluated",
  "user.interruption_presented",
  "user.interruption_judged",
  "review.completed",
  "repair.circuit_opened",
  "model.usage_recorded",
  "delivery.quality_compared",
  "benchmark.completed",
  "candidate.terminal_checked",
  "shadow.compared",
])

export const GateObservationInput = z
  .object({
    id: z.string().trim().min(1).optional(),
    projectId: z.string().trim().min(1),
    pairedProjectId: z.string().trim().min(1).optional(),
    candidateSha: z.string().regex(/^[a-f0-9]{40}$/),
    scenarioId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    subjectId: z.string().trim().min(1),
    strategy: z.enum(["legacy_full_plan", "seed_and_grow"]),
    snapshotSha256: Digest,
    eventType: GateObservationEventType,
    properties: z.record(z.string(), z.unknown()),
    sourceRefs: z.array(SourceReference).min(1).max(1_000),
    evidence: z.record(z.string(), z.unknown()),
    producerPath: z.literal("packages/control-plane/script/produce-seed-grow-candidate-facts.ts"),
    producerSha256: Digest,
  })
  .strict()
export type GateObservationInput = z.infer<typeof GateObservationInput>

export const GateObservationInfo = GateObservationInput.extend({
  id: z.string(),
  inputSha256: Digest,
  createdAt: z.number().int().nonnegative(),
}).strict()
export type GateObservationInfo = z.infer<typeof GateObservationInfo>

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

function fromRow(row: typeof CompanyGateObservationTable.$inferSelect) {
  return GateObservationInfo.parse({
    id: row.id,
    projectId: row.project_id,
    pairedProjectId: row.paired_project_id ?? undefined,
    candidateSha: row.candidate_sha,
    scenarioId: row.scenario_id,
    runId: row.run_id,
    subjectId: row.subject_id,
    strategy: row.strategy,
    snapshotSha256: row.snapshot_sha256,
    eventType: row.event_type,
    properties: JSON.parse(row.properties_json),
    sourceRefs: JSON.parse(row.source_refs_json),
    evidence: JSON.parse(row.evidence_json),
    producerPath: row.producer_path,
    producerSha256: row.producer_sha256,
    inputSha256: row.input_sha256,
    createdAt: row.created_at,
  })
}

export interface Interface {
  readonly record: (input: GateObservationInput) => Effect.Effect<GateObservationInfo>
  readonly list: (input: {
    candidateSha?: string
    projectId?: string
    runId?: string
  }) => Effect.Effect<GateObservationInfo[]>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/GateObservation") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const list = Effect.fn("GateObservation.list")(function* (
      input: {
        candidateSha?: string
        projectId?: string
        runId?: string
      } = {},
    ) {
      const conditions = [
        input.candidateSha
          ? eq(CompanyGateObservationTable.candidate_sha, input.candidateSha)
          : undefined,
        input.projectId ? eq(CompanyGateObservationTable.project_id, input.projectId) : undefined,
        input.runId ? eq(CompanyGateObservationTable.run_id, input.runId) : undefined,
      ].filter((condition) => condition !== undefined)
      return yield* Effect.sync(() =>
        Database.use((database) =>
          database
            .select()
            .from(CompanyGateObservationTable)
            .where(conditions.length ? and(...conditions) : undefined)
            .orderBy(
              asc(CompanyGateObservationTable.created_at),
              asc(CompanyGateObservationTable.id),
            )
            .all()
            .map(fromRow),
        ),
      )
    })

    const record = Effect.fn("GateObservation.record")(function* (raw: GateObservationInput) {
      const input = GateObservationInput.parse(raw)
      const current = yield* Effect.sync(() =>
        Database.use((database) =>
          database
            .select({
              id: CompanyProjectTable.id,
              execution_strategy: CompanyProjectTable.execution_strategy,
            })
            .from(CompanyProjectTable)
            .where(eq(CompanyProjectTable.id, input.projectId))
            .get(),
        ),
      )
      if (!current || current.execution_strategy !== input.strategy)
        throw new Error("Gate observation project strategy binding is unavailable")
      if (input.pairedProjectId) {
        const paired = yield* Effect.sync(() =>
          Database.use((database) =>
            database
              .select({
                id: CompanyProjectTable.id,
                execution_strategy: CompanyProjectTable.execution_strategy,
              })
              .from(CompanyProjectTable)
              .where(eq(CompanyProjectTable.id, input.pairedProjectId!))
              .get(),
          ),
        )
        if (
          !paired ||
          paired.execution_strategy === input.strategy ||
          !["legacy_full_plan", "seed_and_grow"].includes(paired.execution_strategy)
        )
          throw new Error("Gate observation paired project must use the opposite strategy")
      }
      const source = {
        projectId: input.projectId,
        pairedProjectId: input.pairedProjectId,
        candidateSha: input.candidateSha,
        scenarioId: input.scenarioId,
        runId: input.runId,
        subjectId: input.subjectId,
        strategy: input.strategy,
        snapshotSha256: input.snapshotSha256,
        eventType: input.eventType,
        properties: input.properties,
        sourceRefs: input.sourceRefs,
        evidence: input.evidence,
        producerPath: input.producerPath,
        producerSha256: input.producerSha256,
      }
      const inputSha256 = digest(source)
      const existing = (yield* list({ runId: input.runId })).find(
        (item) => item.eventType === input.eventType && item.subjectId === input.subjectId,
      )
      if (existing) {
        if (existing.inputSha256 !== inputSha256)
          throw new Error("Gate observation run and event are already bound to different evidence")
        return existing
      }
      const createdAt = Date.now()
      const id = input.id ?? Identifier.ascending("event")
      yield* Effect.sync(() =>
        Database.use((database) =>
          database
            .insert(CompanyGateObservationTable)
            .values({
              id,
              project_id: input.projectId,
              paired_project_id: input.pairedProjectId ?? null,
              candidate_sha: input.candidateSha,
              scenario_id: input.scenarioId,
              run_id: input.runId,
              subject_id: input.subjectId,
              strategy: input.strategy,
              snapshot_sha256: input.snapshotSha256,
              event_type: input.eventType,
              properties_json: JSON.stringify(input.properties),
              source_refs_json: JSON.stringify(input.sourceRefs),
              evidence_json: JSON.stringify(input.evidence),
              producer_path: input.producerPath,
              producer_sha256: input.producerSha256,
              input_sha256: inputSha256,
              created_at: createdAt,
            })
            .run(),
        ),
      )
      return GateObservationInfo.parse({ id, ...source, inputSha256, createdAt })
    })

    return Service.of({ record, list })
  }),
)

export const defaultLayer = layer

export * as GateObservation from "./gate-observation"
