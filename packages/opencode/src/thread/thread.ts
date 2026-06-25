import z from "zod"
import { eq, and } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../storage"
import { ThreadTable } from "./thread.sql"
import { ThreadID, ThreadKind, ThreadStatus } from "./schema"
import type { SessionID } from "../session/schema"
import { Identifier } from "@/id/id"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"

// ---------------------------------------------------------------------------
// Info schema
// ---------------------------------------------------------------------------

export const Info = z.object({
  id: ThreadID,
  agentID: z.string(),
  kind: ThreadKind,
  status: ThreadStatus,
  sessionID: z.string().optional(),
  description: z.string().optional(),
  budgetTokens: z.number().optional(),
  spentTokens: z.number().default(0),
  timeStarted: z.number().optional(),
  timeCompleted: z.number().optional(),
  time: z.object({
    created: z.number(),
    updated: z.number(),
  }),
})
export type Info = z.infer<typeof Info>

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const CreateInput = z.object({
  agentID: z.string().min(1),
  kind: ThreadKind,
  sessionID: z.string().optional(),
  description: z.string().optional(),
  budgetTokens: z.number().optional(),
})
export type CreateInput = z.infer<typeof CreateInput>

export const UpdateInput = z.object({
  id: ThreadID,
  status: ThreadStatus.optional(),
  sessionID: z.string().optional(),
  description: z.string().optional(),
  spentTokens: z.number().optional(),
  budgetTokens: z.number().optional(),
})
export type UpdateInput = z.infer<typeof UpdateInput>

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const Event = {
  Created: BusEvent.define("thread.created", Info),
  Updated: BusEvent.define("thread.updated", Info),
  Completed: BusEvent.define("thread.completed", Info),
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Row = typeof ThreadTable.$inferSelect

function fromRow(row: Row): Info {
  return {
    id: row.id as ThreadID,
    agentID: row.agent_id,
    kind: row.kind,
    status: row.status,
    sessionID: row.session_id ?? undefined,
    description: row.description ?? undefined,
    budgetTokens: row.budget_tokens ?? undefined,
    spentTokens: row.spent_tokens ?? 0,
    timeStarted: row.time_started ?? undefined,
    timeCompleted: row.time_completed ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  }
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly get: (id: ThreadID) => Effect.Effect<Info | undefined>
  readonly listByAgent: (agentID: string) => Effect.Effect<Info[]>
  readonly listActive: () => Effect.Effect<Info[]>
  readonly update: (input: UpdateInput) => Effect.Effect<Info>
  readonly complete: (id: ThreadID) => Effect.Effect<Info>
  readonly canAssign: (agentID: string, kind: ThreadKind) => Effect.Effect<boolean>
  readonly addTokens: (id: ThreadID, tokens: number) => Effect.Effect<Info>
  readonly agentStatus: (agentID: string) => Effect.Effect<"idle" | "busy" | "focused">
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Thread") {}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const create = Effect.fn("Thread.create")(function* (input: CreateInput) {
      // Primary thread uniqueness: only one active primary per agent
      if (input.kind === "primary") {
        const existing = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(ThreadTable)
              .where(and(eq(ThreadTable.agent_id, input.agentID), eq(ThreadTable.kind, "primary"), eq(ThreadTable.status, "active")))
              .all(),
          ),
        )
        if (existing.length > 0)
          yield* Effect.die(new Error(`Thread.create: agent "${input.agentID}" already has an active primary thread`))
      }

      const now = Date.now()
      const id = Identifier.ascending("thread") as unknown as ThreadID

      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(ThreadTable)
            .values({
              id,
              agent_id: input.agentID,
              kind: input.kind,
              status: "active",
              session_id: input.sessionID as SessionID | undefined,
              description: input.description,
              budget_tokens: input.budgetTokens,
              spent_tokens: 0,
              time_started: now,
              time_created: now,
              time_updated: now,
            })
            .run(),
        ),
      )

      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(ThreadTable).where(eq(ThreadTable.id, id)).get()),
      )
      if (!row) yield* Effect.die(new Error(`Thread.create: insert failed for id="${id}"`))
      const info = fromRow(row!)
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: Event.Created.type, properties: info },
        }),
      )
      return info
    })

    const get = Effect.fn("Thread.get")(function* (id: ThreadID) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(ThreadTable).where(eq(ThreadTable.id, id)).get()),
      )
      return row ? fromRow(row) : undefined
    })

    const listByAgent = Effect.fn("Thread.listByAgent")(function* (agentID: string) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(ThreadTable).where(eq(ThreadTable.agent_id, agentID)).all()),
      )
      return rows.map(fromRow)
    })

    const listActive = Effect.fn("Thread.listActive")(function* () {
      const rows = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(ThreadTable).where(eq(ThreadTable.status, "active")).all()),
      )
      return rows.map(fromRow)
    })

    const update = Effect.fn("Thread.update")(function* (input: UpdateInput) {
      const now = Date.now()
      const patch: Record<string, unknown> = { time_updated: now }
      if (input.status !== undefined) patch.status = input.status
      if (input.sessionID !== undefined) patch.session_id = input.sessionID
      if (input.description !== undefined) patch.description = input.description
      if (input.spentTokens !== undefined) patch.spent_tokens = input.spentTokens
      if (input.budgetTokens !== undefined) patch.budget_tokens = input.budgetTokens

      if (input.status === "completed") patch.time_completed = now

      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db.update(ThreadTable).set(patch).where(eq(ThreadTable.id, input.id)).returning().get(),
        ),
      )
      if (!row) yield* Effect.die(new Error(`Thread.update: not found id="${input.id}"`))
      const info = fromRow(row!)
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: Event.Updated.type, properties: info },
        }),
      )
      return info
    })

    const complete = Effect.fn("Thread.complete")(function* (id: ThreadID) {
      const info = yield* update({ id, status: "completed" } as UpdateInput)
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: Event.Completed.type, properties: info },
        }),
      )
      return info
    })

    const addTokens = Effect.fn("Thread.addTokens")(function* (id: ThreadID, tokens: number) {
      const current = yield* get(id)
      if (!current) yield* Effect.die(new Error(`Thread.addTokens: not found id="${id}"`))
      const newSpent = (current!.spentTokens ?? 0) + tokens
      return yield* update({ id, spentTokens: newSpent } as UpdateInput)
    })

    const canAssign = Effect.fn("Thread.canAssign")(function* (agentID: string, kind: ThreadKind) {
      if (kind === "primary") {
        const existing = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(ThreadTable)
              .where(and(eq(ThreadTable.agent_id, agentID), eq(ThreadTable.kind, "primary"), eq(ThreadTable.status, "active")))
              .all(),
          ),
        )
        return existing.length === 0
      }
      // reactive and ambient: check budget if set
      const threads = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(ThreadTable)
            .where(and(eq(ThreadTable.agent_id, agentID), eq(ThreadTable.status, "active")))
            .all(),
        ),
      )
      for (const thread of threads) {
        if (thread.budget_tokens !== null && (thread.spent_tokens ?? 0) >= thread.budget_tokens) {
          return false
        }
      }
      return true
    })

    const agentStatus = Effect.fn("Thread.agentStatus")(function* (agentID: string) {
      const threads = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(ThreadTable)
            .where(and(eq(ThreadTable.agent_id, agentID), eq(ThreadTable.status, "active")))
            .all(),
        ),
      )
      if (threads.length === 0) return "idle" as const
      const hasPrimary = threads.some((t) => t.kind === "primary")
      if (hasPrimary) return "focused" as const
      return "busy" as const
    })

    return { create, get, listByAgent, listActive, update, complete, canAssign, addTokens, agentStatus }
  }),
)

export const defaultLayer = layer

export * as Thread from "./thread"
