import { Context, Effect, Layer } from "effect"
import { and, asc, desc, eq, gte, inArray, or } from "drizzle-orm"
import { AgentRunTable } from "@/agent-run/agent-run.sql"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import type { TxOrDb } from "@/storage/db"
import {
  CompanyArtifactTable,
  CompanyProjectEventTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "./company-project.sql"
import {
  WorkAttempt,
  type WorkAttemptFailureKind,
  type WorkAttemptStatus,
  WorkReceipt,
  WorkReceiptSubmission,
  type WorkReceiptSubmission as WorkReceiptSubmissionType,
} from "./schema"

const parseList = (value: string) => JSON.parse(value) as unknown[]

const attemptFromRow = (row: typeof CompanyWorkAttemptTable.$inferSelect) =>
  WorkAttempt.parse({
    ...row,
    agent_run_id: row.agent_run_id ?? undefined,
    failure_kind: row.failure_kind ?? undefined,
    safe_summary: row.safe_summary ?? undefined,
    finished_at: row.finished_at ?? undefined,
  })

const receiptFromRow = (row: typeof CompanyWorkReceiptTable.$inferSelect) =>
  WorkReceipt.parse({
    id: row.id,
    project_id: row.project_id,
    work_item_id: row.work_item_id,
    attempt_id: row.attempt_id,
    idempotency_key: row.idempotency_key,
    outcome: row.outcome,
    summary: row.summary,
    artifact_ids: parseList(row.artifact_ids_json),
    evidence_refs: parseList(row.evidence_refs_json),
    confirmed_facts: parseList(row.confirmed_facts_json),
    invalidated_assumptions: parseList(row.invalidated_assumptions_json),
    unknowns: parseList(row.unknowns_json),
    blockers: parseList(row.blockers_json),
    capability_gaps: parseList(row.capability_gaps_json),
    task_proposals: parseList(row.task_proposals_json),
    dependency_proposals: parseList(row.dependency_proposals_json),
    questions: parseList(row.questions_json),
    processing_status: row.processing_status,
    processed_mutation_id: row.processed_mutation_id ?? undefined,
    created_at: row.created_at,
    processed_at: row.processed_at ?? undefined,
  })

function insertEvent(
  db: TxOrDb,
  project_id: string,
  type: string,
  data: Record<string, unknown>,
  actor_id?: string,
) {
  db.insert(CompanyProjectEventTable)
    .values({
      id: Identifier.ascending("event"),
      project_id,
      type,
      actor_id: actor_id ?? null,
      data_json: JSON.stringify(data),
      created_at: Date.now(),
    })
    .run()
}

function sameSubmission(row: typeof CompanyWorkReceiptTable.$inferSelect, input: WorkReceiptSubmissionType) {
  return (
    row.idempotency_key === input.idempotency_key &&
    row.outcome === input.outcome &&
    row.summary === input.summary &&
    row.artifact_ids_json === JSON.stringify(input.artifact_ids) &&
    row.evidence_refs_json === JSON.stringify(input.evidence_refs) &&
    row.confirmed_facts_json === JSON.stringify(input.confirmed_facts) &&
    row.invalidated_assumptions_json === JSON.stringify(input.invalidated_assumptions) &&
    row.unknowns_json === JSON.stringify(input.unknowns) &&
    row.blockers_json === JSON.stringify(input.blockers) &&
    row.capability_gaps_json === JSON.stringify(input.capability_gaps) &&
    row.task_proposals_json === JSON.stringify(input.task_proposals) &&
    row.dependency_proposals_json === JSON.stringify(input.dependency_proposals) &&
    row.questions_json === JSON.stringify(input.questions)
  )
}

function validateReferences(
  db: TxOrDb,
  attempt: typeof CompanyWorkAttemptTable.$inferSelect,
  input: WorkReceiptSubmissionType,
) {
  if (new Set(input.artifact_ids).size !== input.artifact_ids.length) {
    throw new Error("Work Receipt artifact IDs must be unique")
  }
  if (
    new Set(input.evidence_refs.map((reference) => `${reference.kind}:${reference.id}`)).size !==
    input.evidence_refs.length
  ) {
    throw new Error("Work Receipt evidence references must be unique")
  }
  const artifacts = input.artifact_ids.length
    ? db
        .select()
        .from(CompanyArtifactTable)
        .where(inArray(CompanyArtifactTable.id, input.artifact_ids))
        .all()
    : []
  if (
    artifacts.length !== input.artifact_ids.length ||
    artifacts.some(
      (artifact) => artifact.project_id !== attempt.project_id || artifact.work_item_id !== attempt.work_item_id,
    )
  ) {
    throw new Error("Work Receipt references an unavailable Artifact")
  }
  for (const reference of input.evidence_refs) {
    if (reference.kind === "artifact") {
      if (!input.artifact_ids.includes(reference.id)) {
        throw new Error("Work Receipt Artifact evidence must appear in artifact_ids")
      }
      continue
    }
    if (reference.kind === "agent_run") {
      const run = db.select().from(AgentRunTable).where(eq(AgentRunTable.id, reference.id)).get()
      if (
        !run ||
        run.company_project_id !== attempt.project_id ||
        run.work_item_id !== attempt.work_item_id
      ) {
        throw new Error("Work Receipt references an unavailable AgentRun")
      }
      continue
    }
    const event = db
      .select()
      .from(CompanyProjectEventTable)
      .where(eq(CompanyProjectEventTable.id, reference.id))
      .get()
    if (!event || event.project_id !== attempt.project_id) {
      throw new Error("Work Receipt references an unavailable ProjectEvent")
    }
  }
}

export interface Interface {
  readonly startAttempt: (input: {
    project_id: string
    work_item_id: string
    ordinal: number
    actor_id?: string
    agent_run_id?: string
  }) => Effect.Effect<WorkAttempt>
  readonly bindAgentRun: (input: { attempt_id: string; agent_run_id: string }) => Effect.Effect<WorkAttempt>
  readonly finishAttempt: (input: {
    attempt_id: string
    status: Exclude<WorkAttemptStatus, "running">
    failure_kind?: WorkAttemptFailureKind
    safe_summary?: string
    actor_id?: string
    receipt: WorkReceiptSubmissionType
  }) => Effect.Effect<{ attempt: WorkAttempt; receipt: WorkReceipt }>
  readonly processReceipt: (id: string) => Effect.Effect<WorkReceipt>
  readonly finalizeWorkItem: (input: {
    project_id: string
    work_item_id: string
    ordinal: number
    status: "completed" | "failed" | "stopped"
    outcome: "completed" | "blocked" | "failed" | "ask"
    summary: string
    failure_kind?: WorkAttemptFailureKind
    actor_id?: string
  }) => Effect.Effect<{ attempt: WorkAttempt; receipt: WorkReceipt }>
  readonly recover: () => Effect.Effect<{
    reconciled_attempt_ids: string[]
    processed_receipt_ids: string[]
  }>
  readonly listAttempts: (project_id: string) => Effect.Effect<WorkAttempt[]>
  readonly listReceipts: (project_id: string) => Effect.Effect<WorkReceipt[]>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyWorkFacts") {}

function makeService(recoverOnStart: boolean) {
  return Effect.gen(function* () {
    const startAttempt = Effect.fn("CompanyWorkFacts.startAttempt")(function* (input: {
      project_id: string
      work_item_id: string
      ordinal: number
      actor_id?: string
      agent_run_id?: string
    }) {
      if (!Number.isInteger(input.ordinal) || input.ordinal < 1) {
        throw new Error("Work Attempt ordinal must be a positive integer")
      }
      return yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const item = db
              .select()
              .from(CompanyWorkItemTable)
              .where(eq(CompanyWorkItemTable.id, input.work_item_id))
              .get()
            if (!item || item.project_id !== input.project_id) {
              throw new Error(`Company work item not found: ${input.work_item_id}`)
            }
            const existing = db
              .select()
              .from(CompanyWorkAttemptTable)
              .where(
                and(
                  eq(CompanyWorkAttemptTable.work_item_id, input.work_item_id),
                  eq(CompanyWorkAttemptTable.ordinal, input.ordinal),
                ),
              )
              .get()
            if (existing) {
              if (input.agent_run_id && existing.agent_run_id && existing.agent_run_id !== input.agent_run_id) {
                throw new Error(`Work Attempt ${existing.id} is already bound to another AgentRun`)
              }
              return attemptFromRow(existing)
            }
            if (input.agent_run_id) {
              const run = db.select().from(AgentRunTable).where(eq(AgentRunTable.id, input.agent_run_id)).get()
              if (
                !run ||
                run.company_project_id !== input.project_id ||
                run.work_item_id !== input.work_item_id
              ) {
                throw new Error("Work Attempt references an unavailable AgentRun")
              }
            }
            const row = {
              id: Identifier.ascending("workAttempt"),
              project_id: input.project_id,
              work_item_id: input.work_item_id,
              agent_run_id: input.agent_run_id ?? null,
              ordinal: input.ordinal,
              status: "running",
              failure_kind: null,
              safe_summary: null,
              started_at: Date.now(),
              finished_at: null,
            }
            db.insert(CompanyWorkAttemptTable).values(row).run()
            insertEvent(
              db,
              input.project_id,
              "work_attempt.started",
              { attempt_id: row.id, work_item_id: input.work_item_id, ordinal: input.ordinal },
              input.actor_id,
            )
            return attemptFromRow(row)
          },
          { behavior: "immediate" },
        ),
      )
    })

    const bindAgentRun = Effect.fn("CompanyWorkFacts.bindAgentRun")(function* (input: {
      attempt_id: string
      agent_run_id: string
    }) {
      return yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const attempt = db
              .select()
              .from(CompanyWorkAttemptTable)
              .where(eq(CompanyWorkAttemptTable.id, input.attempt_id))
              .get()
            if (!attempt) throw new Error(`Work Attempt not found: ${input.attempt_id}`)
            if (attempt.agent_run_id === input.agent_run_id) return attemptFromRow(attempt)
            if (attempt.agent_run_id) throw new Error(`Work Attempt ${attempt.id} is already bound to another AgentRun`)
            const run = db.select().from(AgentRunTable).where(eq(AgentRunTable.id, input.agent_run_id)).get()
            if (
              !run ||
              run.company_project_id !== attempt.project_id ||
              run.work_item_id !== attempt.work_item_id
            ) {
              throw new Error("Work Attempt references an unavailable AgentRun")
            }
            db.update(CompanyWorkAttemptTable)
              .set({ agent_run_id: input.agent_run_id })
              .where(eq(CompanyWorkAttemptTable.id, input.attempt_id))
              .run()
            return attemptFromRow({
              ...attempt,
              agent_run_id: input.agent_run_id,
            })
          },
          { behavior: "immediate" },
        ),
      )
    })

    const finishAttempt = Effect.fn("CompanyWorkFacts.finishAttempt")(function* (input: {
      attempt_id: string
      status: Exclude<WorkAttemptStatus, "running">
      failure_kind?: WorkAttemptFailureKind
      safe_summary?: string
      actor_id?: string
      receipt: WorkReceiptSubmissionType
    }) {
      const receiptInput = WorkReceiptSubmission.parse(input.receipt)
      if (input.status === "completed" && receiptInput.outcome !== "completed") {
        throw new Error("Completed Work Attempt requires a completed Receipt")
      }
      if (input.status !== "completed" && receiptInput.outcome === "completed") {
        throw new Error("Non-completed Work Attempt cannot submit a completed Receipt")
      }
      return yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const attempt = db
              .select()
              .from(CompanyWorkAttemptTable)
              .where(eq(CompanyWorkAttemptTable.id, input.attempt_id))
              .get()
            if (!attempt) throw new Error(`Work Attempt not found: ${input.attempt_id}`)
            const existing = db
              .select()
              .from(CompanyWorkReceiptTable)
              .where(
                or(
                  eq(CompanyWorkReceiptTable.attempt_id, input.attempt_id),
                  eq(CompanyWorkReceiptTable.idempotency_key, receiptInput.idempotency_key),
                ),
              )
              .get()
            if (existing) {
              if (
                existing.attempt_id !== input.attempt_id ||
                attempt.status !== input.status ||
                !sameSubmission(existing, receiptInput)
              ) {
                throw new Error("Work Receipt idempotency key conflicts with persisted facts")
              }
              return { attempt: attemptFromRow(attempt), receipt: receiptFromRow(existing) }
            }
            if (attempt.status !== "running" && attempt.status !== input.status) {
              throw new Error(`Work Attempt ${attempt.id} cannot finish from ${attempt.status}`)
            }
            validateReferences(db, attempt, receiptInput)
            const now = Date.now()
            db.update(CompanyWorkAttemptTable)
              .set({
                status: input.status,
                failure_kind: input.failure_kind ?? null,
                safe_summary: input.safe_summary ?? null,
                finished_at: now,
              })
              .where(eq(CompanyWorkAttemptTable.id, attempt.id))
              .run()
            const row = {
              id: Identifier.ascending("workReceipt"),
              project_id: attempt.project_id,
              work_item_id: attempt.work_item_id,
              attempt_id: attempt.id,
              idempotency_key: receiptInput.idempotency_key,
              outcome: receiptInput.outcome,
              summary: receiptInput.summary,
              artifact_ids_json: JSON.stringify(receiptInput.artifact_ids),
              evidence_refs_json: JSON.stringify(receiptInput.evidence_refs),
              confirmed_facts_json: JSON.stringify(receiptInput.confirmed_facts),
              invalidated_assumptions_json: JSON.stringify(receiptInput.invalidated_assumptions),
              unknowns_json: JSON.stringify(receiptInput.unknowns),
              blockers_json: JSON.stringify(receiptInput.blockers),
              capability_gaps_json: JSON.stringify(receiptInput.capability_gaps),
              task_proposals_json: JSON.stringify(receiptInput.task_proposals),
              dependency_proposals_json: JSON.stringify(receiptInput.dependency_proposals),
              questions_json: JSON.stringify(receiptInput.questions),
              processing_status: "pending",
              processed_mutation_id: null,
              created_at: now,
              processed_at: null,
            }
            db.insert(CompanyWorkReceiptTable).values(row).run()
            insertEvent(
              db,
              attempt.project_id,
              "work_attempt.finished",
              {
                attempt_id: attempt.id,
                work_item_id: attempt.work_item_id,
                status: input.status,
                receipt_id: row.id,
              },
              input.actor_id,
            )
            insertEvent(
              db,
              attempt.project_id,
              "work_receipt.submitted",
              { receipt_id: row.id, attempt_id: attempt.id, work_item_id: attempt.work_item_id },
              input.actor_id,
            )
            return {
              attempt: attemptFromRow({
                ...attempt,
                status: input.status,
                failure_kind: input.failure_kind ?? null,
                safe_summary: input.safe_summary ?? null,
                finished_at: now,
              }),
              receipt: receiptFromRow(row),
            }
          },
          { behavior: "immediate" },
        ),
      )
    })

    const processReceipt = Effect.fn("CompanyWorkFacts.processReceipt")(function* (id: string) {
      return yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const receipt = db
              .select()
              .from(CompanyWorkReceiptTable)
              .where(eq(CompanyWorkReceiptTable.id, id))
              .get()
            if (!receipt) throw new Error(`Work Receipt not found: ${id}`)
            if (receipt.processing_status === "processed" || receipt.processing_status === "rejected") {
              return receiptFromRow(receipt)
            }
            const processed_at = Date.now()
            db.update(CompanyWorkReceiptTable)
              .set({ processing_status: "processed", processed_at })
              .where(eq(CompanyWorkReceiptTable.id, id))
              .run()
            insertEvent(
              db,
              receipt.project_id,
              "work_receipt.processed",
              { receipt_id: id, attempt_id: receipt.attempt_id, work_item_id: receipt.work_item_id },
            )
            return receiptFromRow({
              ...receipt,
              processing_status: "processed",
              processed_at,
            })
          },
          { behavior: "immediate" },
        ),
      )
    })

    const finalizeWorkItem = Effect.fn("CompanyWorkFacts.finalizeWorkItem")(function* (input: {
      project_id: string
      work_item_id: string
      ordinal: number
      status: "completed" | "failed" | "stopped"
      outcome: "completed" | "blocked" | "failed" | "ask"
      summary: string
      failure_kind?: WorkAttemptFailureKind
      actor_id?: string
    }) {
      const attempt = yield* startAttempt({
        project_id: input.project_id,
        work_item_id: input.work_item_id,
        ordinal: input.ordinal,
        actor_id: input.actor_id,
      })
      const source = yield* Effect.sync(() =>
        Database.use((db) => {
          const artifacts = db
            .select()
            .from(CompanyArtifactTable)
            .where(
              and(
                eq(CompanyArtifactTable.project_id, input.project_id),
                eq(CompanyArtifactTable.work_item_id, input.work_item_id),
              ),
            )
            .orderBy(asc(CompanyArtifactTable.created_at), asc(CompanyArtifactTable.id))
            .all()
            .filter((artifact) => artifact.created_at >= attempt.started_at)
          const run = db
            .select()
            .from(AgentRunTable)
            .where(
              and(
                eq(AgentRunTable.company_project_id, input.project_id),
                eq(AgentRunTable.work_item_id, input.work_item_id),
                gte(AgentRunTable.time_created, attempt.started_at),
              ),
            )
            .orderBy(desc(AgentRunTable.time_created), desc(AgentRunTable.id))
            .get()
          return { artifacts, run }
        }),
      )
      const boundAttempt =
        source.run && !attempt.agent_run_id
          ? yield* bindAgentRun({ attempt_id: attempt.id, agent_run_id: source.run.id })
          : attempt
      const finalized = yield* finishAttempt({
        attempt_id: boundAttempt.id,
        status: input.status,
        failure_kind: input.failure_kind,
        safe_summary: input.summary.slice(0, 8_000),
        actor_id: input.actor_id,
        receipt: {
          idempotency_key: `legacy-work-item:${input.work_item_id}:attempt:${input.ordinal}:terminal`,
          outcome: input.outcome,
          summary: input.summary.slice(0, 8_000),
          artifact_ids: source.artifacts.map((artifact) => artifact.id),
          evidence_refs: [
            ...(source.run ? [{ kind: "agent_run" as const, id: source.run.id }] : []),
            ...source.artifacts.map((artifact) => ({ kind: "artifact" as const, id: artifact.id })),
          ],
          confirmed_facts:
            input.status === "completed" ? [`work_item:${input.work_item_id}:completed`] : [],
          invalidated_assumptions: [],
          unknowns: [],
          blockers: input.status === "completed" ? [] : [input.summary.slice(0, 8_000)],
          capability_gaps: [],
          task_proposals: [],
          dependency_proposals: [],
          questions: [],
        },
      })
      return {
        attempt: finalized.attempt,
        receipt: yield* processReceipt(finalized.receipt.id),
      }
    })

    const recover = Effect.fn("CompanyWorkFacts.recover")(function* () {
      const reconciled_attempt_ids = yield* Effect.sync(() =>
        Database.transaction(
          (db) =>
            db
              .select()
              .from(CompanyWorkItemTable)
              .where(eq(CompanyWorkItemTable.status, "running"))
              .orderBy(asc(CompanyWorkItemTable.created_at), asc(CompanyWorkItemTable.id))
              .all()
              .flatMap((item) => {
                if (item.attempt < 1) return []
                const existing = db
                  .select()
                  .from(CompanyWorkAttemptTable)
                  .where(
                    and(
                      eq(CompanyWorkAttemptTable.work_item_id, item.id),
                      eq(CompanyWorkAttemptTable.ordinal, item.attempt),
                    ),
                  )
                  .get()
                if (existing) return []
                const id = Identifier.ascending("workAttempt")
                db.insert(CompanyWorkAttemptTable)
                  .values({
                    id,
                    project_id: item.project_id,
                    work_item_id: item.id,
                    agent_run_id: null,
                    ordinal: item.attempt,
                    status: "running",
                    failure_kind: null,
                    safe_summary: null,
                    started_at: item.started_at ?? item.updated_at,
                    finished_at: null,
                  })
                  .run()
                insertEvent(db, item.project_id, "work_attempt.started", {
                  attempt_id: id,
                  work_item_id: item.id,
                  ordinal: item.attempt,
                  recovered: true,
                })
                return [id]
              }),
          { behavior: "immediate" },
        ),
      )
      const pending = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({ id: CompanyWorkReceiptTable.id })
            .from(CompanyWorkReceiptTable)
            .where(
              inArray(CompanyWorkReceiptTable.processing_status, ["pending", "processing"]),
            )
            .orderBy(asc(CompanyWorkReceiptTable.created_at), asc(CompanyWorkReceiptTable.id))
            .all(),
        ),
      )
      const processed_receipt_ids = yield* Effect.forEach(
        pending,
        (receipt) => processReceipt(receipt.id).pipe(Effect.as(receipt.id)),
        { concurrency: 1 },
      )
      return { reconciled_attempt_ids, processed_receipt_ids }
    })

    const listAttempts = Effect.fn("CompanyWorkFacts.listAttempts")(function* (project_id: string) {
      return (yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyWorkAttemptTable)
            .where(eq(CompanyWorkAttemptTable.project_id, project_id))
            .orderBy(
              asc(CompanyWorkAttemptTable.started_at),
              asc(CompanyWorkAttemptTable.ordinal),
              asc(CompanyWorkAttemptTable.id),
            )
            .all(),
        ),
      )).map(attemptFromRow)
    })

    const listReceipts = Effect.fn("CompanyWorkFacts.listReceipts")(function* (project_id: string) {
      return (yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyWorkReceiptTable)
            .where(eq(CompanyWorkReceiptTable.project_id, project_id))
            .orderBy(asc(CompanyWorkReceiptTable.created_at), asc(CompanyWorkReceiptTable.id))
            .all(),
        ),
      )).map(receiptFromRow)
    })

    const service = Service.of({
      startAttempt,
      bindAgentRun,
      finishAttempt,
      processReceipt,
      finalizeWorkItem,
      recover,
      listAttempts,
      listReceipts,
    })
    if (recoverOnStart) yield* recover()
    return service
  })
}

export function makeLayer(options: { recoverOnStart?: boolean } = {}) {
  return Layer.effect(Service, makeService(options.recoverOnStart ?? true))
}

export const layer = makeLayer()

export const defaultLayer = layer

export * as CompanyWorkFacts from "./work-facts"
