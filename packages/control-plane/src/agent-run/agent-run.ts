import z from "zod"
import { Context, Effect, Layer } from "effect"
import { and, asc, desc, eq, isNull, or, sql } from "@/storage"
import { Database } from "@/storage"
import { Identifier } from "@/id/id"
import { GlobalBus } from "@/bus/global"
import { BusEvent } from "@/bus/bus-event"
import {
  AgentRunEventTable,
  AgentRunTable,
  InternalExecutionMessageTable,
  RuntimeHomeTable,
  SkillSnapshotTable,
} from "./agent-run.sql"

export const Runtime = z.enum(["pi", "claude-code", "codex"])
export const Lifecycle = z.enum(["on_demand", "idle_cached"])
export const PermissionMode = z.enum(["read_only", "workspace_write", "full_access"])
export const State = z.enum([
  "queued",
  "starting",
  "running",
  "interrupting",
  "awaiting_recovery",
  "completed",
  "failed",
  "stopped",
])
export const InternalMessagePriority = z.enum(["steer", "follow_up"])

export const Info = z.object({
  id: z.string(),
  agentID: z.string(),
  runtime: Runtime,
  runtimeVersion: z.string().optional(),
  workflowVersion: z.string().optional(),
  capabilityChecksum: z.string().optional(),
  lifecycle: Lifecycle,
  permissionMode: PermissionMode,
  state: State,
  sessionID: z.string().optional(),
  groupSessionID: z.string().optional(),
  workflowRunID: z.string().optional(),
  conversationThreadID: z.string().optional(),
  companyProjectID: z.string().optional(),
  workItemID: z.string().optional(),
  worktreeRunID: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  cwd: z.string(),
  runtimeHomePath: z.string(),
  resumeSessionID: z.string().optional(),
  exitCode: z.number().optional(),
  safeErrorSummary: z.string().optional(),
  time: z.object({
    created: z.number(),
    updated: z.number(),
    started: z.number().optional(),
    finished: z.number().optional(),
  }),
})
export type Info = z.infer<typeof Info>

export const EventInfo = z.object({
  id: z.string(),
  runID: z.string(),
  sequence: z.number(),
  type: z.string(),
  payloadJSON: z.string(),
  timeCreated: z.number(),
})
export type EventInfo = z.infer<typeof EventInfo>

export const CreateInput = z.object({
  id: z.string().optional(),
  agentID: z.string().min(1),
  runtime: Runtime,
  runtimeVersion: z.string().optional(),
  workflowVersion: z.string().optional(),
  capabilityChecksum: z.string().optional(),
  lifecycle: Lifecycle.default("on_demand"),
  permissionMode: PermissionMode.default("workspace_write"),
  sessionID: z.string().optional(),
  groupSessionID: z.string().optional(),
  workflowRunID: z.string().optional(),
  conversationThreadID: z.string().optional(),
  companyProjectID: z.string().optional(),
  workItemID: z.string().optional(),
  worktreeRunID: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  cwd: z.string().min(1),
  runtimeHomePath: z.string().min(1),
  resumeSessionID: z.string().optional(),
})
export type CreateInput = z.infer<typeof CreateInput>

export const TransitionInput = z.object({
  id: z.string(),
  state: State,
  sessionID: z.string().optional(),
  exitCode: z.number().int().optional(),
  safeErrorSummary: z.string().optional(),
})
export type TransitionInput = z.infer<typeof TransitionInput>

export const EnqueueInput = z.object({
  fromAgentID: z.string().min(1),
  toAgentID: z.string().min(1),
  targetRunID: z.string().optional(),
  priority: InternalMessagePriority,
  body: z.string().min(1),
  idempotencyKey: z.string().min(1).optional(),
})
export type EnqueueInput = z.infer<typeof EnqueueInput>

function fromRow(row: typeof AgentRunTable.$inferSelect): Info {
  return Info.parse({
    id: row.id,
    agentID: row.agent_id,
    runtime: row.runtime,
    runtimeVersion: row.runtime_version ?? undefined,
    workflowVersion: row.workflow_version ?? undefined,
    capabilityChecksum: row.capability_checksum ?? undefined,
    lifecycle: row.lifecycle,
    permissionMode: row.permission_mode,
    state: row.state,
    sessionID: row.session_id ?? undefined,
    groupSessionID: row.group_session_id ?? undefined,
    workflowRunID: row.workflow_run_id ?? undefined,
    conversationThreadID: row.conversation_thread_id ?? undefined,
    companyProjectID: row.company_project_id ?? undefined,
    workItemID: row.work_item_id ?? undefined,
    worktreeRunID: row.worktree_run_id ?? undefined,
    model: row.model ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
    cwd: row.cwd,
    runtimeHomePath: row.runtime_home_path,
    resumeSessionID: row.resume_session_id ?? undefined,
    exitCode: row.exit_code ?? undefined,
    safeErrorSummary: row.safe_error_summary ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      started: row.time_started ?? undefined,
      finished: row.time_finished ?? undefined,
    },
  })
}

function eventFromRow(row: typeof AgentRunEventTable.$inferSelect): EventInfo {
  return EventInfo.parse({
    id: row.id,
    runID: row.agent_run_id,
    sequence: row.sequence,
    type: row.type,
    payloadJSON: row.payload_json,
    timeCreated: row.time_created,
  })
}

export const Event = {
  Created: BusEvent.define("agent_run.created", Info),
  Updated: BusEvent.define("agent_run.updated", Info),
  RuntimeEvent: BusEvent.define("agent_run.event", EventInfo),
}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly list: (input?: { agentID?: string; workflowRunID?: string; groupSessionID?: string; companyProjectID?: string; limit?: number }) => Effect.Effect<Info[]>
  readonly events: (runID: string) => Effect.Effect<EventInfo[]>
  readonly listRecoverable: () => Effect.Effect<Info[]>
  readonly transition: (input: TransitionInput) => Effect.Effect<Info | undefined>
  readonly recordEvent: (input: { runID: string; type: string; payload: Record<string, unknown> }) => Effect.Effect<EventInfo>
  readonly enqueue: (input: EnqueueInput) => Effect.Effect<string>
  readonly claim: (input: { agentID: string; limit?: number }) => Effect.Effect<Array<{ id: string; priority: z.infer<typeof InternalMessagePriority>; body: string }>>
  readonly recordRuntimeHome: (input: { runID: string; path: string; credentialMode: "keychain" | "ephemeral"; state: "active" | "orphaned" | "destroyed" }) => Effect.Effect<void>
  readonly recordSkillSnapshot: (input: { runID: string; skillID: string; version: string; checksum: string; sourcePath: string; snapshotPath: string; activationReason: string }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/AgentRun") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const create = Effect.fn("AgentRun.create")(function* (input: CreateInput) {
      const now = Date.now()
      const id = input.id ?? Identifier.ascending("agentRun")
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(AgentRunTable)
            .values({
              id,
              agent_id: input.agentID,
              runtime: input.runtime,
              runtime_version: input.runtimeVersion ?? null,
              workflow_version: input.workflowVersion ?? null,
              capability_checksum: input.capabilityChecksum ?? null,
              lifecycle: input.lifecycle,
              permission_mode: input.permissionMode,
              state: "queued",
              session_id: input.sessionID ?? null,
              group_session_id: input.groupSessionID ?? null,
              workflow_run_id: input.workflowRunID ?? null,
              conversation_thread_id: input.conversationThreadID ?? null,
              company_project_id: input.companyProjectID ?? null,
              work_item_id: input.workItemID ?? null,
              worktree_run_id: input.worktreeRunID ?? null,
              model: input.model ?? null,
              reasoning_effort: input.reasoningEffort ?? null,
              cwd: input.cwd,
              runtime_home_path: input.runtimeHomePath,
              resume_session_id: input.resumeSessionID ?? null,
              time_created: now,
              time_updated: now,
            })
            .run(),
        ),
      )
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(AgentRunTable).where(eq(AgentRunTable.id, id)).get()),
      )
      if (!row) return yield* Effect.die(new Error(`AgentRun.create: insert failed for id="${id}"`))
      const info = fromRow(row)
      yield* Effect.sync(() =>
        GlobalBus.emit("event", { directory: "global", payload: { type: Event.Created.type, properties: info } }),
      )
      return info
    })

    const get = Effect.fn("AgentRun.get")(function* (id: string) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(AgentRunTable).where(eq(AgentRunTable.id, id)).get()),
      )
      return row ? fromRow(row) : undefined
    })

    const list = Effect.fn("AgentRun.list")(function* (input: {
      agentID?: string
      workflowRunID?: string
      groupSessionID?: string
      companyProjectID?: string
      limit?: number
    } = {}) {
      const conditions = [
        input.agentID ? eq(AgentRunTable.agent_id, input.agentID) : undefined,
        input.workflowRunID ? eq(AgentRunTable.workflow_run_id, input.workflowRunID) : undefined,
        input.groupSessionID ? eq(AgentRunTable.group_session_id, input.groupSessionID) : undefined,
        input.companyProjectID ? eq(AgentRunTable.company_project_id, input.companyProjectID) : undefined,
      ].filter((condition) => condition !== undefined)
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(AgentRunTable)
            .where(conditions.length ? and(...conditions) : undefined)
            .orderBy(desc(AgentRunTable.time_created))
            .limit(Math.min(input.limit ?? 100, 500))
            .all(),
        ),
      )
      return rows.map(fromRow)
    })

    const events = Effect.fn("AgentRun.events")(function* (runID: string) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(AgentRunEventTable)
            .where(eq(AgentRunEventTable.agent_run_id, runID))
            .orderBy(asc(AgentRunEventTable.sequence))
            .all(),
        ),
      )
      return rows.map(eventFromRow)
    })

    const listRecoverable = Effect.fn("AgentRun.listRecoverable")(function* () {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(AgentRunTable)
            .where(or(eq(AgentRunTable.state, "starting"), eq(AgentRunTable.state, "running"), eq(AgentRunTable.state, "interrupting"), eq(AgentRunTable.state, "awaiting_recovery")))
            .orderBy(asc(AgentRunTable.time_created))
            .all(),
        ),
      )
      return rows.map(fromRow)
    })

    const transition = Effect.fn("AgentRun.transition")(function* (input: TransitionInput) {
      const now = Date.now()
      const terminal = input.state === "completed" || input.state === "failed" || input.state === "stopped"
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(AgentRunTable)
            .set({
              state: input.state,
              session_id: input.sessionID ?? undefined,
              exit_code: input.exitCode ?? undefined,
              safe_error_summary: input.safeErrorSummary ?? undefined,
              time_started: input.state === "starting" || input.state === "running" ? now : undefined,
              time_finished: terminal ? now : undefined,
              time_updated: now,
            })
            .where(eq(AgentRunTable.id, input.id))
            .returning()
            .get(),
        ),
      )
      if (!row) return undefined
      const info = fromRow(row)
      yield* Effect.sync(() =>
        GlobalBus.emit("event", { directory: "global", payload: { type: Event.Updated.type, properties: info } }),
      )
      return info
    })

    const recordEvent = Effect.fn("AgentRun.recordEvent")(function* (input: { runID: string; type: string; payload: Record<string, unknown> }) {
      const info = yield* Effect.sync(() =>
        Database.transaction((db) => {
          const sequence = (db
            .select({ sequence: AgentRunEventTable.sequence })
            .from(AgentRunEventTable)
            .where(eq(AgentRunEventTable.agent_run_id, input.runID))
            .orderBy(AgentRunEventTable.sequence)
            .all()
            .at(-1)?.sequence ?? -1) + 1
          const row = db
            .insert(AgentRunEventTable)
            .values({
              id: Identifier.ascending("agentRunEvent"),
              agent_run_id: input.runID,
              sequence,
              type: input.type,
              payload_json: JSON.stringify(input.payload),
              time_created: Date.now(),
            })
            .returning()
            .get()
          if (!row) throw new Error(`AgentRun.recordEvent: insert failed for run="${input.runID}"`)
          return eventFromRow(row)
        }, { behavior: "immediate" }),
      )
      yield* Effect.sync(() =>
        GlobalBus.emit("event", { directory: "global", payload: { type: Event.RuntimeEvent.type, properties: info } }),
      )
      return info
    })

    const enqueue = Effect.fn("AgentRun.enqueue")(function* (input: EnqueueInput) {
      const id = yield* Effect.sync(() => {
        const existing = input.idempotencyKey
          ? Database.use((db) =>
              db
                .select({ id: InternalExecutionMessageTable.id })
                .from(InternalExecutionMessageTable)
                .where(eq(InternalExecutionMessageTable.idempotency_key, input.idempotencyKey!))
                .get(),
            )
          : undefined
        if (existing) return existing.id
        const id = Identifier.ascending("executionMessage")
        const now = Date.now()
        Database.use((db) =>
          db
            .insert(InternalExecutionMessageTable)
            .values({
              id,
              from_agent_id: input.fromAgentID,
              to_agent_id: input.toAgentID,
              target_run_id: input.targetRunID ?? null,
              priority: input.priority,
              body: input.body,
              idempotency_key: input.idempotencyKey ?? null,
              time_created: now,
              time_updated: now,
            })
            .run(),
        )
        return id
      })
      return id
    })

    const claim = Effect.fn("AgentRun.claim")(function* (input: { agentID: string; limit?: number }) {
      return yield* Effect.sync(() =>
        Database.transaction((db) => {
          const rows = db
            .select()
            .from(InternalExecutionMessageTable)
            .where(and(eq(InternalExecutionMessageTable.to_agent_id, input.agentID), isNull(InternalExecutionMessageTable.delivered_at)))
            .orderBy(sql`case ${InternalExecutionMessageTable.priority} when 'steer' then 0 else 1 end`, asc(InternalExecutionMessageTable.time_created))
            .limit(input.limit ?? 10)
            .all()
          const now = Date.now()
          rows.forEach((row) =>
            db
              .update(InternalExecutionMessageTable)
              .set({ delivered_at: now, time_updated: now })
              .where(and(eq(InternalExecutionMessageTable.id, row.id), isNull(InternalExecutionMessageTable.delivered_at)))
              .run(),
          )
          return rows.map((row) => ({ id: row.id, priority: InternalMessagePriority.parse(row.priority), body: row.body }))
        }, { behavior: "immediate" }),
      )
    })

    const recordRuntimeHome = Effect.fn("AgentRun.recordRuntimeHome")(function* (input: { runID: string; path: string; credentialMode: "keychain" | "ephemeral"; state: "active" | "orphaned" | "destroyed" }) {
      const now = Date.now()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(RuntimeHomeTable)
            .values({
              id: Identifier.ascending("runtimeHome"),
              agent_run_id: input.runID,
              path: input.path,
              state: input.state,
              credential_mode: input.credentialMode,
              time_created: now,
              time_updated: now,
            })
            .onConflictDoUpdate({ target: RuntimeHomeTable.agent_run_id, set: { path: input.path, state: input.state, credential_mode: input.credentialMode, time_updated: now } })
            .run(),
        ),
      )
    })

    const recordSkillSnapshot = Effect.fn("AgentRun.recordSkillSnapshot")(function* (input: { runID: string; skillID: string; version: string; checksum: string; sourcePath: string; snapshotPath: string; activationReason: string }) {
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(SkillSnapshotTable)
            .values({
              id: Identifier.ascending("skillSnapshot"),
              agent_run_id: input.runID,
              skill_id: input.skillID,
              version: input.version,
              checksum: input.checksum,
              source_path: input.sourcePath,
              snapshot_path: input.snapshotPath,
              activation_reason: input.activationReason,
              time_created: Date.now(),
            })
            .onConflictDoNothing()
            .run(),
        ),
      )
    })

    return { create, get, list, events, listRecoverable, transition, recordEvent, enqueue, claim, recordRuntimeHome, recordSkillSnapshot }
  }),
)

export const defaultLayer = layer

export * as AgentRun from "./agent-run"
