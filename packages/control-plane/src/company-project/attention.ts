import { createHash } from "node:crypto"
import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import z from "zod"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import {
  CompanyAttentionTable,
  CompanyProjectActionTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
} from "./company-project.sql"
import * as AttentionRouter from "./attention-router"
import {
  AttentionClose,
  AttentionCreate,
  AttentionRecord,
  AttentionStatus,
  ProjectActionRecord,
  ProjectActionRequest,
  type AttentionCreate as AttentionCreateValue,
  type AttentionRecord as AttentionRecordValue,
  type AttentionRouteInput as AttentionRouteInputValue,
  type AttentionStatus as AttentionStatusValue,
  type ProjectActionRecord as ProjectActionRecordValue,
  type ProjectActionRequest as ProjectActionRequestValue,
} from "./schema"

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]),
  )
}

function canonical(value: unknown) {
  return JSON.stringify(normalized(value))
}

function digest(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

function normalizedRefs(refs: AttentionCreateValue["source_refs"]) {
  return [...new Map(refs.map((ref) => [canonical(ref), ref])).values()].sort((left, right) =>
    canonical(left).localeCompare(canonical(right)),
  )
}

function attentionFromRow(row: typeof CompanyAttentionTable.$inferSelect) {
  return AttentionRecord.parse({
    id: row.id,
    project_id: row.project_id,
    idempotency_key: row.idempotency_key,
    issue_kind: row.issue_kind,
    risk: row.risk,
    materiality: row.materiality,
    route: row.route,
    material: row.material,
    interrupts_user: row.interrupts_user,
    title: row.title,
    summary: row.summary,
    required_decision: row.required_decision ?? undefined,
    allowed_actions: JSON.parse(row.allowed_actions_json),
    source_refs: JSON.parse(row.source_refs_json),
    input_sha256: row.input_sha256,
    status: row.status,
    resolution: row.resolution ?? undefined,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at ?? undefined,
  })
}

function actionFromRow(row: typeof CompanyProjectActionTable.$inferSelect) {
  return ProjectActionRecord.parse({
    id: row.id,
    project_id: row.project_id,
    attention_id: row.attention_id ?? undefined,
    action: row.action,
    idempotency_key: row.idempotency_key,
    payload: JSON.parse(row.payload_json),
    payload_sha256: row.payload_sha256,
    expected_revision: row.expected_revision ?? undefined,
    status: row.status,
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    error: row.error ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at ?? undefined,
    finished_at: row.finished_at ?? undefined,
  })
}

function insertEvent(
  project_id: string,
  type: string,
  data: Record<string, unknown>,
  actor_id?: string,
) {
  Database.use((db) =>
    db
      .insert(CompanyProjectEventTable)
      .values({
        id: Identifier.ascending("event"),
        project_id,
        type,
        actor_id: actor_id ?? null,
        data_json: JSON.stringify(data),
        created_at: Date.now(),
      })
      .run(),
  )
}

function createAttention(raw: AttentionCreateValue) {
  const input = AttentionCreate.parse(raw)
  const decision = AttentionRouter.route(input.issue)
  const source_refs = normalizedRefs(input.source_refs)
  const input_sha256 = digest({ ...input, source_refs, decision })
  return Database.transaction(
    (db) => {
      if (!db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, input.project_id)).get())
        throw new Error(`Company project not found: ${input.project_id}`)
      const existing = db
        .select()
        .from(CompanyAttentionTable)
        .where(
          and(
            eq(CompanyAttentionTable.project_id, input.project_id),
            eq(CompanyAttentionTable.idempotency_key, input.idempotency_key),
          ),
        )
        .get()
      if (existing) {
        if (existing.input_sha256 !== input_sha256)
          throw new Error(`Attention idempotency key ${input.idempotency_key} has different facts`)
        return { record: attentionFromRow(existing), replayed: true }
      }
      const id = Identifier.ascending("attention")
      const now = Date.now()
      db.insert(CompanyAttentionTable)
        .values({
          id,
          project_id: input.project_id,
          idempotency_key: input.idempotency_key,
          issue_kind: decision.issue_kind,
          risk: decision.risk,
          materiality: decision.materiality,
          route: decision.route,
          material: decision.material,
          interrupts_user: decision.interrupts_user,
          title: input.title,
          summary: input.summary,
          required_decision: input.required_decision ?? null,
          allowed_actions_json: JSON.stringify(decision.allowed_actions),
          source_refs_json: JSON.stringify(source_refs),
          input_sha256,
          status: "open",
          resolution: null,
          version: 1,
          created_at: now,
          updated_at: now,
          resolved_at: null,
        })
        .run()
      insertEvent(input.project_id, "attention.opened", {
        attention_id: id,
        issue_kind: decision.issue_kind,
        materiality: decision.materiality,
        route: decision.route,
        interrupts_user: decision.interrupts_user,
      })
      return {
        record: attentionFromRow(
          db.select().from(CompanyAttentionTable).where(eq(CompanyAttentionTable.id, id)).get()!,
        ),
        replayed: false,
      }
    },
    { behavior: "immediate" },
  )
}

export type ReplayResult<T> = { record: T; replayed: boolean }

export interface Interface {
  readonly route: (input: AttentionRouteInputValue) => Effect.Effect<ReturnType<typeof AttentionRouter.route>>
  readonly create: (input: AttentionCreateValue) => Effect.Effect<ReplayResult<AttentionRecordValue>>
  readonly open: (input: AttentionCreateValue) => Effect.Effect<ReplayResult<AttentionRecordValue> | undefined>
  readonly list: (input: {
    project_id: string
    status?: AttentionStatusValue
  }) => Effect.Effect<AttentionRecordValue[]>
  readonly close: (input: z.input<typeof AttentionClose>) => Effect.Effect<ReplayResult<AttentionRecordValue>>
  readonly requestAction: (
    input: ProjectActionRequestValue,
  ) => Effect.Effect<ReplayResult<ProjectActionRecordValue>>
  readonly claimAction: (id: string) => Effect.Effect<ReplayResult<ProjectActionRecordValue>>
  readonly applyAction: (input: {
    id: string
    result: Record<string, unknown>
  }) => Effect.Effect<ReplayResult<ProjectActionRecordValue>>
  readonly rejectAction: (input: {
    id: string
    error: string
  }) => Effect.Effect<ReplayResult<ProjectActionRecordValue>>
  readonly replayAction: (input: {
    project_id: string
    idempotency_key: string
  }) => Effect.Effect<ProjectActionRecordValue | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyAttention") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    route: (input) => Effect.sync(() => AttentionRouter.route(input)),
    create: (raw) => Effect.sync(() => createAttention(raw)),
    open: (raw) =>
      Effect.sync(() => {
        const input = AttentionCreate.parse(raw)
        if (!AttentionRouter.route(input.issue).interrupts_user) return
        return createAttention(input)
      }),
    list: (input) =>
      Effect.sync(() => {
        const status = input.status ? AttentionStatus.parse(input.status) : undefined
        return Database.use((db) =>
          db
            .select()
            .from(CompanyAttentionTable)
            .where(
              status
                ? and(
                    eq(CompanyAttentionTable.project_id, input.project_id),
                    eq(CompanyAttentionTable.status, status),
                  )
                : eq(CompanyAttentionTable.project_id, input.project_id),
            )
            .orderBy(asc(CompanyAttentionTable.created_at), asc(CompanyAttentionTable.id))
            .all(),
        ).map(attentionFromRow)
      }),
    close: (raw) =>
      Effect.sync(() => {
        const input = AttentionClose.parse(raw)
        return Database.transaction(
          (db) => {
            const existing = db
              .select()
              .from(CompanyAttentionTable)
              .where(eq(CompanyAttentionTable.id, input.id))
              .get()
            if (!existing) throw new Error(`Attention not found: ${input.id}`)
            if (existing.status === "resolved") {
              if (existing.resolution !== input.resolution)
                throw new Error(`Attention ${input.id} was resolved with different facts`)
              return { record: attentionFromRow(existing), replayed: true }
            }
            if (existing.status !== "open")
              throw new Error(`Attention ${input.id} cannot close from ${existing.status}`)
            if (existing.version !== input.expected_version)
              throw new Error(
                `Attention ${input.id} version changed from ${input.expected_version} to ${existing.version}`,
              )
            const now = Date.now()
            db.update(CompanyAttentionTable)
              .set({
                status: "resolved",
                resolution: input.resolution,
                version: existing.version + 1,
                updated_at: now,
                resolved_at: now,
              })
              .where(
                and(
                  eq(CompanyAttentionTable.id, input.id),
                  eq(CompanyAttentionTable.version, input.expected_version),
                ),
              )
              .run()
            insertEvent(existing.project_id, "attention.closed", {
              attention_id: existing.id,
              version: existing.version + 1,
            })
            return {
              record: attentionFromRow(
                db.select().from(CompanyAttentionTable).where(eq(CompanyAttentionTable.id, input.id)).get()!,
              ),
              replayed: false,
            }
          },
          { behavior: "immediate" },
        )
      }),
    requestAction: (raw) =>
      Effect.sync(() => {
        const input = ProjectActionRequest.parse(raw)
        const payload_json = canonical(input.payload)
        const payload_sha256 = digest({
          action: input.action,
          attention_id: input.attention_id,
          expected_revision: input.expected_revision,
          payload: input.payload,
        })
        return Database.transaction(
          (db) => {
            if (!db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, input.project_id)).get())
              throw new Error(`Company project not found: ${input.project_id}`)
            if (
              input.attention_id &&
              !db
                .select()
                .from(CompanyAttentionTable)
                .where(
                  and(
                    eq(CompanyAttentionTable.id, input.attention_id),
                    eq(CompanyAttentionTable.project_id, input.project_id),
                  ),
                )
                .get()
            )
              throw new Error(`Attention ${input.attention_id} does not belong to project ${input.project_id}`)
            const existing = db
              .select()
              .from(CompanyProjectActionTable)
              .where(
                and(
                  eq(CompanyProjectActionTable.project_id, input.project_id),
                  eq(CompanyProjectActionTable.idempotency_key, input.idempotency_key),
                ),
              )
              .get()
            if (existing) {
              if (existing.payload_sha256 !== payload_sha256)
                throw new Error(`Project action idempotency key ${input.idempotency_key} has different facts`)
              return { record: actionFromRow(existing), replayed: true }
            }
            const id = Identifier.ascending("projectAction")
            const now = Date.now()
            db.insert(CompanyProjectActionTable)
              .values({
                id,
                project_id: input.project_id,
                attention_id: input.attention_id ?? null,
                action: input.action,
                idempotency_key: input.idempotency_key,
                payload_json,
                payload_sha256,
                expected_revision: input.expected_revision ?? null,
                status: "requested",
                result_json: null,
                error: null,
                created_at: now,
                updated_at: now,
                claimed_at: null,
                finished_at: null,
              })
              .run()
            insertEvent(input.project_id, "project_action.requested", {
              action_id: id,
              action: input.action,
              attention_id: input.attention_id,
              expected_revision: input.expected_revision,
            })
            return {
              record: actionFromRow(
                db.select().from(CompanyProjectActionTable).where(eq(CompanyProjectActionTable.id, id)).get()!,
              ),
              replayed: false,
            }
          },
          { behavior: "immediate" },
        )
      }),
    claimAction: (id) =>
      Effect.sync(() =>
        Database.transaction(
          (db) => {
            const existing = db
              .select()
              .from(CompanyProjectActionTable)
              .where(eq(CompanyProjectActionTable.id, id))
              .get()
            if (!existing) throw new Error(`Project action not found: ${id}`)
            if (existing.status !== "requested")
              return { record: actionFromRow(existing), replayed: true }
            const project = db
              .select()
              .from(CompanyProjectTable)
              .where(eq(CompanyProjectTable.id, existing.project_id))
              .get()
            if (!project) throw new Error(`Company project not found: ${existing.project_id}`)
            const now = Date.now()
            if (
              existing.expected_revision !== null &&
              existing.expected_revision !== project.graph_revision
            ) {
              db.update(CompanyProjectActionTable)
                .set({
                  status: "rejected",
                  error: "project_revision_conflict",
                  updated_at: now,
                  finished_at: now,
                })
                .where(eq(CompanyProjectActionTable.id, id))
                .run()
              insertEvent(existing.project_id, "project_action.rejected", {
                action_id: id,
                error: "project_revision_conflict",
              })
              return {
                record: actionFromRow(
                  db.select().from(CompanyProjectActionTable).where(eq(CompanyProjectActionTable.id, id)).get()!,
                ),
                replayed: false,
              }
            }
            db.update(CompanyProjectActionTable)
              .set({ status: "claimed", claimed_at: now, updated_at: now })
              .where(eq(CompanyProjectActionTable.id, id))
              .run()
            insertEvent(existing.project_id, "project_action.claimed", { action_id: id })
            return {
              record: actionFromRow(
                db.select().from(CompanyProjectActionTable).where(eq(CompanyProjectActionTable.id, id)).get()!,
              ),
              replayed: false,
            }
          },
          { behavior: "immediate" },
        ),
      ),
    applyAction: (input) =>
      Effect.sync(() =>
        Database.transaction(
          (db) => {
            const existing = db
              .select()
              .from(CompanyProjectActionTable)
              .where(eq(CompanyProjectActionTable.id, input.id))
              .get()
            if (!existing) throw new Error(`Project action not found: ${input.id}`)
            const result_json = canonical(input.result)
            if (existing.status === "applied") {
              if (existing.result_json !== result_json)
                throw new Error(`Project action ${input.id} was applied with different facts`)
              return { record: actionFromRow(existing), replayed: true }
            }
            if (existing.status !== "claimed")
              throw new Error(`Project action ${input.id} cannot apply from ${existing.status}`)
            const now = Date.now()
            db.update(CompanyProjectActionTable)
              .set({ status: "applied", result_json, updated_at: now, finished_at: now })
              .where(eq(CompanyProjectActionTable.id, input.id))
              .run()
            insertEvent(existing.project_id, "project_action.applied", { action_id: input.id })
            return {
              record: actionFromRow(
                db.select().from(CompanyProjectActionTable).where(eq(CompanyProjectActionTable.id, input.id)).get()!,
              ),
              replayed: false,
            }
          },
          { behavior: "immediate" },
        ),
      ),
    rejectAction: (input) =>
      Effect.sync(() =>
        Database.transaction(
          (db) => {
            const existing = db
              .select()
              .from(CompanyProjectActionTable)
              .where(eq(CompanyProjectActionTable.id, input.id))
              .get()
            if (!existing) throw new Error(`Project action not found: ${input.id}`)
            if (existing.status === "rejected") {
              if (existing.error !== input.error)
                throw new Error(`Project action ${input.id} was rejected with different facts`)
              return { record: actionFromRow(existing), replayed: true }
            }
            if (existing.status === "applied")
              throw new Error(`Project action ${input.id} cannot reject from applied`)
            const now = Date.now()
            db.update(CompanyProjectActionTable)
              .set({ status: "rejected", error: input.error, updated_at: now, finished_at: now })
              .where(eq(CompanyProjectActionTable.id, input.id))
              .run()
            insertEvent(existing.project_id, "project_action.rejected", {
              action_id: input.id,
              error: input.error,
            })
            return {
              record: actionFromRow(
                db.select().from(CompanyProjectActionTable).where(eq(CompanyProjectActionTable.id, input.id)).get()!,
              ),
              replayed: false,
            }
          },
          { behavior: "immediate" },
        ),
      ),
    replayAction: (input) =>
      Effect.sync(() => {
        const row = Database.use((db) =>
          db
            .select()
            .from(CompanyProjectActionTable)
            .where(
              and(
                eq(CompanyProjectActionTable.project_id, input.project_id),
                eq(CompanyProjectActionTable.idempotency_key, input.idempotency_key),
              ),
            )
            .get(),
        )
        return row ? actionFromRow(row) : undefined
      }),
  }),
)

export const defaultLayer = layer

export * as CompanyAttention from "./attention"
