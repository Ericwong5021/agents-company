import z from "zod"
import { eq, and, desc } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../storage"
import { AgentMessageTable } from "./agent-message.sql"
import { AgentMessageID, AgentMessageKind } from "./schema"
import { Identifier } from "@/id/id"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { AuditEvent } from "@/audit-event/audit-event"

// ---------------------------------------------------------------------------
// Info schema
// ---------------------------------------------------------------------------

export const Info = z.object({
  id: z.string(),
  fromAgentID: z.string(),
  toAgentID: z.string(),
  threadID: z.string().optional(),
  rootNeedID: z.string().optional(),
  inReplyTo: z.string().optional(),
  kind: AgentMessageKind,
  depth: z.number().int().nonnegative(),
  spawnedIssueID: z.string().optional(),
  body: z.string(),
  taskSummary: z.string().optional(),
  outcome: z.string().optional(),
  read: z.boolean(),
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
  id: z.string().optional(),
  fromAgentID: z.string().min(1),
  toAgentID: z.string().min(1),
  threadID: z.string().optional(),
  rootNeedID: z.string().optional(),
  inReplyTo: z.string().optional(),
  kind: AgentMessageKind,
  depth: z.number().int().nonnegative().optional(),
  spawnedIssueID: z.string().optional(),
  body: z.string().min(1),
  taskSummary: z.string().optional(),
  outcome: z.string().optional(),
})
export type CreateInput = z.infer<typeof CreateInput>

export const ListByAgentOpts = z.object({
  unreadOnly: z.boolean().optional(),
  kind: AgentMessageKind.optional(),
  limit: z.number().int().positive().optional(),
})
export type ListByAgentOpts = z.infer<typeof ListByAgentOpts>

export const ListPendingApprovalsOpts = z.object({
  limit: z.number().int().positive().optional(),
})
export type ListPendingApprovalsOpts = z.infer<typeof ListPendingApprovalsOpts>

export const UpdateOutcomeInput = z.object({
  id: z.string().min(1),
  outcome: z.string().min(1),
  read: z.boolean().optional(),
})
export type UpdateOutcomeInput = z.infer<typeof UpdateOutcomeInput>

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const Event = {
  Created: BusEvent.define("agent_message.created", Info),
  Read: BusEvent.define("agent_message.read", Info),
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Row = typeof AgentMessageTable.$inferSelect

function fromRow(row: Row): Info {
  return {
    id: row.id,
    fromAgentID: row.from_agent_id,
    toAgentID: row.to_agent_id,
    threadID: row.thread_id ?? undefined,
    rootNeedID: row.root_need_id ?? undefined,
    inReplyTo: row.in_reply_to ?? undefined,
    kind: row.kind,
    depth: row.depth,
    spawnedIssueID: row.spawned_issue_id ?? undefined,
    body: row.body,
    taskSummary: row.task_summary ?? undefined,
    outcome: row.outcome ?? undefined,
    read: row.read,
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
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly updateSpawnedIssue: (id: string, spawnedIssueID: string) => Effect.Effect<Info>
  readonly updateOutcome: (input: UpdateOutcomeInput) => Effect.Effect<Info>
  readonly listByAgent: (agentId: string, opts?: ListByAgentOpts) => Effect.Effect<Info[]>
  readonly listPendingApprovals: (opts?: ListPendingApprovalsOpts) => Effect.Effect<Info[]>
  readonly listByRootNeed: (rootNeedId: string) => Effect.Effect<Info[]>
  readonly markRead: (id: string) => Effect.Effect<Info>
  readonly getByThread: (threadId: string) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentMessage") {}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const create = Effect.fn("AgentMessage.create")(function* (input: CreateInput) {
      const now = Date.now()
      const id = input.id ?? Identifier.ascending("message")

      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(AgentMessageTable)
            .values({
              id,
              from_agent_id: input.fromAgentID,
              to_agent_id: input.toAgentID,
              thread_id: input.threadID ?? null,
              root_need_id: input.rootNeedID ?? null,
              in_reply_to: input.inReplyTo ?? null,
              kind: input.kind,
              depth: input.depth ?? 0,
              spawned_issue_id: input.spawnedIssueID ?? null,
              body: input.body,
              task_summary: input.taskSummary ?? null,
              outcome: input.outcome ?? null,
              read: false,
              time_created: now,
              time_updated: now,
            })
            .run(),
        ),
      )

      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(AgentMessageTable).where(eq(AgentMessageTable.id, id)).get()),
      )
      if (!row) yield* Effect.die(new Error(`AgentMessage.create: insert failed for id="${id}"`))
      const info = fromRow(row!)
      yield* AuditEvent.record({
        rootNeedID: info.rootNeedID,
        kind: "message",
        action: info.kind,
        actorAgentID: info.fromAgentID,
        targetAgentID: info.toAgentID,
        subjectID: info.id,
        subjectType: "agent_message",
        metadata: {
          threadID: info.threadID,
          depth: info.depth,
          outcome: info.outcome,
          inReplyTo: info.inReplyTo,
        },
      })
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: Event.Created.type, properties: info },
        }),
      )
      return info
    })

    const get = Effect.fn("AgentMessage.get")(function* (id: string) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(AgentMessageTable).where(eq(AgentMessageTable.id, id)).get()),
      )
      return row ? fromRow(row) : undefined
    })

    const updateSpawnedIssue = Effect.fn("AgentMessage.updateSpawnedIssue")(function* (
      id: string,
      spawnedIssueID: string,
    ) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(AgentMessageTable)
            .set({ spawned_issue_id: spawnedIssueID, time_updated: Date.now() })
            .where(eq(AgentMessageTable.id, id))
            .returning()
            .get(),
        ),
      )
      if (!row) yield* Effect.die(new Error(`AgentMessage.updateSpawnedIssue: not found id="${id}"`))
      return fromRow(row!)
    })

    const listByAgent = Effect.fn("AgentMessage.listByAgent")(function* (agentId: string, opts?: ListByAgentOpts) {
      const conditions = [eq(AgentMessageTable.to_agent_id, agentId)]
      if (opts?.unreadOnly) conditions.push(eq(AgentMessageTable.read, false))
      if (opts?.kind) conditions.push(eq(AgentMessageTable.kind, opts.kind))

      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(AgentMessageTable)
            .where(and(...conditions))
            .orderBy(desc(AgentMessageTable.time_created))
            .limit(opts?.limit ?? 1000)
            .all(),
        ),
      )
      return rows.map(fromRow)
    })

    const listPendingApprovals = Effect.fn("AgentMessage.listPendingApprovals")(function* (
      opts?: ListPendingApprovalsOpts,
    ) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(AgentMessageTable)
            .where(and(eq(AgentMessageTable.kind, "reply"), eq(AgentMessageTable.outcome, "needs_approval")))
            .orderBy(desc(AgentMessageTable.time_created))
            .limit(opts?.limit ?? 100)
            .all(),
        ),
      )
      return rows.map(fromRow)
    })

    const updateOutcome = Effect.fn("AgentMessage.updateOutcome")(function* (input: UpdateOutcomeInput) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(AgentMessageTable)
            .set({
              outcome: input.outcome,
              read: input.read ?? true,
              time_updated: Date.now(),
            })
            .where(eq(AgentMessageTable.id, input.id))
            .returning()
            .get(),
        ),
      )
      if (!row) yield* Effect.die(new Error(`AgentMessage.updateOutcome: not found id="${input.id}"`))
      return fromRow(row!)
    })

    const markRead = Effect.fn("AgentMessage.markRead")(function* (id: string) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(AgentMessageTable)
            .set({ read: true, time_updated: Date.now() })
            .where(eq(AgentMessageTable.id, id))
            .returning()
            .get(),
        ),
      )
      if (!row) yield* Effect.die(new Error(`AgentMessage.markRead: not found id="${id}"`))
      const info = fromRow(row!)
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: Event.Read.type, properties: info },
        }),
      )
      return info
    })

    const getByThread = Effect.fn("AgentMessage.getByThread")(function* (threadId: string) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(AgentMessageTable)
            .where(eq(AgentMessageTable.thread_id, threadId))
            .orderBy(AgentMessageTable.time_created)
            .all(),
        ),
      )
      return rows.map(fromRow)
    })

    const listByRootNeed = Effect.fn("AgentMessage.listByRootNeed")(function* (rootNeedId: string) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(AgentMessageTable)
            .where(eq(AgentMessageTable.root_need_id, rootNeedId))
            .orderBy(AgentMessageTable.time_created)
            .all(),
        ),
      )
      return rows.map(fromRow)
    })

    return {
      create,
      get,
      updateSpawnedIssue,
      updateOutcome,
      listByAgent,
      listPendingApprovals,
      listByRootNeed,
      markRead,
      getByThread,
    }
  }),
)

export const defaultLayer = layer

export * as AgentMessage from "./agent-message"
