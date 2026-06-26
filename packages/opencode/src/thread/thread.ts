import z from "zod"
import { eq, and } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../storage"
import { ThreadTable } from "./thread.sql"
import { ThreadID, ThreadKind, ThreadStatus } from "./schema"
import type { SessionID } from "../session/schema"
import { Identifier } from "@/id/id"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Log } from "@/util"

const log = Log.create({ service: "thread" })

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class PrimaryThreadExists extends Schema.TaggedErrorClass<PrimaryThreadExists>()("PrimaryThreadExists", {
  agentID: Schema.String,
  existingThreadID: Schema.String,
}) {}

export class ReactiveRateLimited extends Schema.TaggedErrorClass<ReactiveRateLimited>()("ReactiveRateLimited", {
  agentID: Schema.String,
  count: Schema.Number,
  limit: Schema.Number,
}) {}

export class ThreadNotFound extends Schema.TaggedErrorClass<ThreadNotFound>()("ThreadNotFound", {
  id: Schema.String,
}) {}

export class InvalidTransition extends Schema.TaggedErrorClass<InvalidTransition>()("InvalidTransition", {
  from: Schema.String,
  to: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

/** Max concurrent active reactive threads per agent. */
export const REACTIVE_RATE_LIMIT = 3

// Valid status transitions: from → allowed-to[]
const VALID_TRANSITIONS: Record<string, string[]> = {
  active: ["paused", "completed"],
  paused: ["active", "completed"],
  completed: [], // terminal state
}

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
// Agent activity (activity registry)
// ---------------------------------------------------------------------------

export const AgentActivity = z.object({
  agentID: z.string(),
  activeThreads: z.array(Info),
  primaryCount: z.number(),
  reactiveCount: z.number(),
  ambientCount: z.number(),
  totalBudgetSpent: z.number(),
  isBusy: z.boolean(),
})
export type AgentActivity = z.infer<typeof AgentActivity>

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
  readonly create: (input: CreateInput) => Effect.Effect<Info, PrimaryThreadExists | ReactiveRateLimited>
  readonly get: (id: ThreadID) => Effect.Effect<Info | undefined>
  readonly listByAgent: (agentID: string) => Effect.Effect<Info[]>
  readonly listActive: () => Effect.Effect<Info[]>
  readonly update: (input: UpdateInput) => Effect.Effect<Info, ThreadNotFound | InvalidTransition>
  readonly complete: (id: ThreadID) => Effect.Effect<Info, ThreadNotFound | InvalidTransition>
  /** Check if agent can accept new work of given kind. */
  readonly canAccept: (agentID: string, kind: ThreadKind) => Effect.Effect<boolean>
  readonly addTokens: (id: ThreadID, tokens: number) => Effect.Effect<Info, ThreadNotFound | InvalidTransition>
  /** Agent-level rollup: idle | busy | paused. */
  readonly agentStatus: (agentID: string) => Effect.Effect<"idle" | "busy" | "paused">
  /** Per-agent activity summary for the activity registry. */
  readonly agentActivity: (agentID: string) => Effect.Effect<AgentActivity>
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
          yield* new PrimaryThreadExists({
            agentID: input.agentID,
            existingThreadID: existing[0].id,
          })
      }

      // Reactive rate limit: cap concurrent active reactive threads per agent
      if (input.kind === "reactive") {
        const activeReactive = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(ThreadTable)
              .where(
                and(
                  eq(ThreadTable.agent_id, input.agentID),
                  eq(ThreadTable.kind, "reactive"),
                  eq(ThreadTable.status, "active"),
                ),
              )
              .all(),
          ),
        )
        if (activeReactive.length >= REACTIVE_RATE_LIMIT) {
          yield* new ReactiveRateLimited({
            agentID: input.agentID,
            count: activeReactive.length,
            limit: REACTIVE_RATE_LIMIT,
          })
        }
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
      // Validate status transition if status is being changed
      if (input.status !== undefined) {
        const current = yield* get(input.id)
        if (!current) yield* new ThreadNotFound({ id: input.id })
        const allowed = VALID_TRANSITIONS[current!.status] ?? []
        if (!allowed.includes(input.status)) {
          yield* new InvalidTransition({ from: current!.status, to: input.status })
        }
      }

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

    const canAccept = Effect.fn("Thread.canAccept")(function* (agentID: string, kind: ThreadKind) {
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
      if (kind === "reactive") {
        const activeReactive = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(ThreadTable)
              .where(
                and(
                  eq(ThreadTable.agent_id, agentID),
                  eq(ThreadTable.kind, "reactive"),
                  eq(ThreadTable.status, "active"),
                ),
              )
              .all(),
          ),
        )
        if (activeReactive.length >= REACTIVE_RATE_LIMIT) return false
      }
      // Check budget constraints on all active threads
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
            .where(eq(ThreadTable.agent_id, agentID))
            .all(),
        ),
      )
      return rollupAgentStatus(threads.map(fromRow))
    })

    const agentActivity = Effect.fn("Thread.agentActivity")(function* (agentID: string) {
      const allThreads = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(ThreadTable)
            .where(eq(ThreadTable.agent_id, agentID))
            .all(),
        ),
      )
      const infos = allThreads.map(fromRow)
      const active = infos.filter((t) => t.status === "active")
      const primaryCount = active.filter((t) => t.kind === "primary").length
      const reactiveCount = active.filter((t) => t.kind === "reactive").length
      const ambientCount = active.filter((t) => t.kind === "ambient").length
      const totalBudgetSpent = infos.reduce((sum, t) => sum + (t.spentTokens ?? 0), 0)
      return {
        agentID,
        activeThreads: active,
        primaryCount,
        reactiveCount,
        ambientCount,
        totalBudgetSpent,
        isBusy: primaryCount > 0,
      }
    })

    return { create, get, listByAgent, listActive, update, complete, canAccept, addTokens, agentStatus, agentActivity }
  }),
)

// ---------------------------------------------------------------------------
// Agent status rollup
// ---------------------------------------------------------------------------

/** Compute agent-level status from all its threads. */
export function rollupAgentStatus(threads: Info[]): "idle" | "busy" | "paused" {
  const active = threads.filter((t) => t.status === "active")
  if (active.length > 0) return "busy"
  const paused = threads.filter((t) => t.status === "paused")
  if (paused.length > 0 && active.length === 0) return "paused"
  return "idle"
}

export const defaultLayer = layer

export * as Thread from "./thread"
