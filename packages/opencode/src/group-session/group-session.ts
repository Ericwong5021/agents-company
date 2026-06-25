import z from "zod"
import { Context, Effect, Layer } from "effect"
import { Database, eq, and, desc } from "../storage"
import { GroupSessionTable, GroupSessionMemberTable, GroupMessageTable } from "./group-session.sql"
import { GroupSessionID } from "./schema"
import type { SessionID } from "../session/schema"
import type { ProjectID } from "../project/schema"
import type { CompanyAgentID } from "../company-agent/schema"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { InstanceState } from "@/effect"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"

// ---------------------------------------------------------------------------
// Info types
// ---------------------------------------------------------------------------

export const MemberInfo = z.object({
  sessionID: z.string(),
  companyAgentID: z.string(),
  position: z.number(),
})
export type MemberInfo = z.infer<typeof MemberInfo>

export const Info = z.object({
  id: GroupSessionID.zod,
  projectID: z.string(),
  title: z.string(),
  members: MemberInfo.array(),
  time: z.object({
    created: z.number(),
    updated: z.number(),
    archived: z.number().optional(),
  }),
})
export type Info = z.infer<typeof Info>

export const GroupMessage = z.object({
  id: z.string(),
  groupSessionID: GroupSessionID.zod,
  roundNum: z.number(),
  role: z.enum(["user", "agent"]),
  companyAgentID: z.string().optional(),
  sessionID: z.string().optional(),
  content: z.string(),
  statusSummary: z.string().optional(),
  time: z.object({ created: z.number(), updated: z.number() }),
})
export type GroupMessage = z.infer<typeof GroupMessage>

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const CreateInput = z.object({
  title: z.string().min(1),
  agentIDs: z.array(z.string()).min(1).max(10),
})
export type CreateInput = z.infer<typeof CreateInput>

export const ChatInput = z.object({
  groupSessionID: GroupSessionID.zod,
  text: z.string().min(1),
})
export type ChatInput = z.infer<typeof ChatInput>

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const Event = {
  Created: BusEvent.define("group_session.created", Info),
  Updated: BusEvent.define("group_session.updated", Info),
  Deleted: BusEvent.define("group_session.deleted", z.object({ id: GroupSessionID.zod })),
  ChatSent: BusEvent.define(
    "group_session.chat_sent",
    z.object({
      groupSessionID: GroupSessionID.zod,
      roundNum: z.number(),
      memberSessionIDs: z.array(z.string()),
    }),
  ),
  // Fires when ALL member sessions have finished the current round
  RoundComplete: BusEvent.define(
    "group_session.round_complete",
    z.object({
      groupSessionID: GroupSessionID.zod,
      roundNum: z.number(),
    }),
  ),
  // Fires after the user message has been persisted to GroupMessageTable,
  // before agent fan-out starts. TUI uses this to show the user bubble.
  UserMessagePersisted: BusEvent.define(
    "group_session.user_message_persisted",
    z.object({
      groupSessionID: GroupSessionID.zod,
      roundNum: z.number(),
    }),
  ),
  // Fires per-member when an agent's prompt begins. TUI uses this to show
  // the "working" bubble for that specific agent.
  AgentStarted: BusEvent.define(
    "group_session.agent_started",
    z.object({
      groupSessionID: GroupSessionID.zod,
      roundNum: z.number(),
      sessionID: z.string(),
      companyAgentID: z.string(),
    }),
  ),
  // Fires per-member when an agent finishes (success, error, or interrupted).
  // statusSummary distinguishes the outcome for the TUI.
  AgentCompleted: BusEvent.define(
    "group_session.agent_completed",
    z.object({
      groupSessionID: GroupSessionID.zod,
      roundNum: z.number(),
      sessionID: z.string(),
      companyAgentID: z.string(),
      statusSummary: z.enum(["done", "error", "interrupted"]),
    }),
  ),
}

export class BusyError extends Error {
  constructor(public readonly groupSessionID: string) {
    super(`Group session ${groupSessionID} is busy`)
  }
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly get: (id: GroupSessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly chat: (input: ChatInput) => Effect.Effect<void>
  readonly interrupt: (id: GroupSessionID) => Effect.Effect<void>
  readonly isBusy: (id: GroupSessionID) => Effect.Effect<boolean>
  readonly messages: (id: GroupSessionID) => Effect.Effect<GroupMessage[]>
  readonly remove: (id: GroupSessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GroupSession") {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadMembers(groupID: GroupSessionID): MemberInfo[] {
  return Database.use((db) =>
    db
      .select()
      .from(GroupSessionMemberTable)
      .where(eq(GroupSessionMemberTable.group_session_id, groupID))
      .orderBy(GroupSessionMemberTable.position)
      .all(),
  ).map((row) => ({
    sessionID: row.session_id as string,
    companyAgentID: row.company_agent_id as string,
    position: row.position,
  }))
}

function loadGroupInfo(groupID: GroupSessionID): Info | undefined {
  const row = Database.use((db) =>
    db.select().from(GroupSessionTable).where(eq(GroupSessionTable.id, groupID)).get(),
  )
  if (!row) return undefined
  const members = loadMembers(groupID)
  return {
    id: row.id,
    projectID: row.project_id,
    title: row.title,
    members,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      archived: row.time_archived ?? undefined,
    },
  }
}

// Build the group context block injected into each member's prompt.
// Contains all previous rounds' visible messages.
function buildGroupContext(groupID: GroupSessionID, currentRound: number): string {
  if (currentRound === 0) return ""

  const rows = Database.use((db) =>
    db
      .select()
      .from(GroupMessageTable)
      .where(eq(GroupMessageTable.group_session_id, groupID))
      .orderBy(GroupMessageTable.round_num, GroupMessageTable.time_created)
      .all(),
  )

  if (rows.length === 0) return ""

  // Group rows by round
  const rounds = new Map<number, typeof rows>()
  for (const row of rows) {
    const list = rounds.get(row.round_num) ?? []
    list.push(row)
    rounds.set(row.round_num, list)
  }

  const lines: string[] = [
    "<group_session_context>",
    "This is a multi-agent group session. The following is the shared conversation history",
    "visible to all agents. Use it as context — do not repeat what others have already said.\n",
  ]

  for (const [round, msgs] of [...rounds.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`[Round ${round + 1}]`)
    for (const msg of msgs) {
      if (msg.role === "user") {
        lines.push(`User: ${msg.content}`)
      } else {
        const agentLabel = msg.company_agent_id ?? "Agent"
        const status = msg.status_summary ? ` (${msg.status_summary})` : ""
        lines.push(`${agentLabel}${status}: ${msg.content}`)
      }
    }
    lines.push("")
  }

  lines.push("</group_session_context>")
  return lines.join("\n")
}

function currentRoundNum(groupID: GroupSessionID): number {
  const row = Database.use((db) =>
    db
      .select({ round_num: GroupMessageTable.round_num })
      .from(GroupMessageTable)
      .where(eq(GroupMessageTable.group_session_id, groupID))
      .orderBy(desc(GroupMessageTable.round_num))
      .limit(1)
      .get(),
  )
  return row ? row.round_num + 1 : 0
}

function insertGroupMessage(input: {
  groupSessionID: GroupSessionID
  roundNum: number
  role: "user" | "agent"
  companyAgentID?: CompanyAgentID
  sessionID?: SessionID
  content: string
  statusSummary?: string
}) {
  const now = Date.now()
  const id = Identifier.ascending("message")
  Database.use((db) =>
    db
      .insert(GroupMessageTable)
      .values({
        id,
        group_session_id: input.groupSessionID,
        round_num: input.roundNum,
        role: input.role,
        company_agent_id: input.companyAgentID ?? null,
        session_id: input.sessionID ?? null,
        content: input.content,
        status_summary: input.statusSummary ?? null,
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer: Layer.Layer<Service, never, Session.Service | SessionPrompt.Service | SessionStatus.Service | SessionRunState.Service | Bus.Service> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const sessionSvc = yield* Session.Service
      const promptSvc = yield* SessionPrompt.Service
      const statusSvc = yield* SessionStatus.Service
      const runState = yield* SessionRunState.Service
      const bus = yield* Bus.Service

      // --- create ---

      const create = Effect.fn("GroupSession.create")(function* (input: CreateInput) {
        const directory = yield* InstanceState.directory
        const project = Instance.project

        const now = Date.now()
        const groupID = GroupSessionID.ascending()

        // Create the group row
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .insert(GroupSessionTable)
              .values({
                id: groupID,
                project_id: project.id as ProjectID,
                title: input.title,
                time_created: now,
                time_updated: now,
              })
              .run(),
          ),
        )

        // Create one member session per agentID, register membership
        for (const [i, agentID] of input.agentIDs.entries()) {
          const session = yield* sessionSvc.create({
            title: `${input.title} — ${agentID}`,
            companyAgentID: agentID as CompanyAgentID,
          })

          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .insert(GroupSessionMemberTable)
                .values({
                  group_session_id: groupID,
                  session_id: session.id,
                  company_agent_id: agentID as CompanyAgentID,
                  position: i,
                  time_created: now,
                  time_updated: now,
                })
                .run(),
            ),
          )
        }

        const info = yield* Effect.sync(() => loadGroupInfo(groupID)!)
        yield* bus.publish(Event.Created, info)
        return info
      })

      // --- get ---

      const get = Effect.fn("GroupSession.get")(function* (id: GroupSessionID) {
        const info = yield* Effect.sync(() => loadGroupInfo(id))
        if (!info) return yield* Effect.die(new Error(`GroupSession not found: ${id}`))
        return info!
      })

      // --- list ---

      const list = Effect.fn("GroupSession.list")(function* () {
        const project = Instance.project
        const rows = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(GroupSessionTable)
              .where(eq(GroupSessionTable.project_id, project.id as ProjectID))
              .orderBy(desc(GroupSessionTable.time_updated))
              .all(),
          ),
        )
        return rows.map((row) => {
          const members = loadMembers(row.id)
          return {
            id: row.id,
            projectID: row.project_id,
            title: row.title,
            members,
            time: {
              created: row.time_created,
              updated: row.time_updated,
              archived: row.time_archived ?? undefined,
            },
          } satisfies Info
        })
      })

      // --- isBusy ---

      const isBusy = Effect.fn("GroupSession.isBusy")(function* (id: GroupSessionID) {
        const info = yield* get(id)
        const statuses = yield* Effect.forEach(
          info.members,
          (m) => statusSvc.get(m.sessionID as SessionID),
          { concurrency: "unbounded" },
        )
        return statuses.some((s) => s.type === "busy")
      })

      // --- chat ---

      const chat = Effect.fn("GroupSession.chat")(function* (input: ChatInput) {
        const busy = yield* isBusy(input.groupSessionID)
        if (busy) return yield* Effect.die(new BusyError(input.groupSessionID))

        const info = yield* get(input.groupSessionID)
        const roundNum = yield* Effect.sync(() => currentRoundNum(input.groupSessionID))

        // Save the user message to the group message store
        yield* Effect.sync(() =>
          insertGroupMessage({
            groupSessionID: input.groupSessionID,
            roundNum,
            role: "user",
            content: input.text,
          }),
        )

        // Build context from previous rounds (not this round — agents are blind to each other)
        const groupContext = yield* Effect.sync(() => buildGroupContext(input.groupSessionID, roundNum))

        const promptText = groupContext
          ? `${groupContext}\n\n${input.text}`
          : input.text

        const memberSessionIDs = info.members.map((m) => m.sessionID)

        yield* bus.publish(Event.ChatSent, {
          groupSessionID: input.groupSessionID,
          roundNum,
          memberSessionIDs,
        })

        // Emit user message persisted — TUI uses this to show the user bubble
        yield* bus.publish(Event.UserMessagePersisted, {
          groupSessionID: input.groupSessionID,
          roundNum,
        })

        // Fan-out: fire each member session concurrently in the background.
        // Each member's lifecycle publishes AgentStarted/AgentCompleted events
        // so the TUI can show working → content bubble transitions per-agent.
        // The fan-out is fork-detached so chat() returns immediately after
        // publishing UserMessagePersisted, letting the TUI show the user bubble
        // without waiting for agents to finish.
        yield* Effect.forEach(
          info.members,
          (member) =>
            Effect.gen(function* () {
              // Signal that this agent is starting
              yield* bus.publish(Event.AgentStarted, {
                groupSessionID: input.groupSessionID,
                roundNum,
                sessionID: member.sessionID,
                companyAgentID: member.companyAgentID,
              })

              // Run the agent prompt
              yield* promptSvc.prompt({
                sessionID: member.sessionID as SessionID,
                agentID: "main",
                source: "user",
                parts: [{ type: "text", text: promptText }],
              }).pipe(
                Effect.matchEffect({
                  onSuccess: (msg) => {
                    const chatText =
                      msg.parts
                        .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
                        .map((p) => p.text)
                        .join("") || "(no output)"
                    return Effect.gen(function* () {
                      yield* Effect.sync(() =>
                        insertGroupMessage({
                          groupSessionID: input.groupSessionID,
                          roundNum,
                          role: "agent",
                          companyAgentID: member.companyAgentID as CompanyAgentID,
                          sessionID: member.sessionID as SessionID,
                          content: chatText,
                          statusSummary: "done",
                        }),
                      )
                      yield* bus.publish(Event.AgentCompleted, {
                        groupSessionID: input.groupSessionID,
                        roundNum,
                        sessionID: member.sessionID,
                        companyAgentID: member.companyAgentID,
                        statusSummary: "done",
                      })
                    })
                  },
                  onFailure: () =>
                    Effect.gen(function* () {
                      yield* Effect.sync(() =>
                        insertGroupMessage({
                          groupSessionID: input.groupSessionID,
                          roundNum,
                          role: "agent",
                          companyAgentID: member.companyAgentID as CompanyAgentID,
                          sessionID: member.sessionID as SessionID,
                          content: "",
                          statusSummary: "error",
                        }),
                      )
                      yield* bus.publish(Event.AgentCompleted, {
                        groupSessionID: input.groupSessionID,
                        roundNum,
                        sessionID: member.sessionID,
                        companyAgentID: member.companyAgentID,
                        statusSummary: "error",
                      })
                    }),
                }),
              )
            }),
          { concurrency: "unbounded", discard: true },
        ).pipe(
          // After all agents finish: re-assert idle + emit RoundComplete
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Effect.forEach(
                info.members,
                (m) => statusSvc.set(m.sessionID as SessionID, { type: "idle" }),
                { concurrency: "unbounded", discard: true },
              )
              const completedAt = Date.now()
              yield* Effect.sync(() =>
                Database.use((db) =>
                  db
                    .update(GroupSessionTable)
                    .set({ time_updated: completedAt })
                    .where(eq(GroupSessionTable.id, input.groupSessionID))
                    .run(),
                ),
              )
              yield* bus.publish(Event.RoundComplete, {
                groupSessionID: input.groupSessionID,
                roundNum,
              })
            }),
          ),
          Effect.forkDetach,
        )
      })

      // --- interrupt ---

      const interrupt = Effect.fn("GroupSession.interrupt")(function* (id: GroupSessionID) {
        const info = yield* get(id)
        yield* Effect.forEach(
          info.members,
          (m) => runState.cancel(m.sessionID as SessionID).pipe(Effect.ignore),
          { concurrency: "unbounded", discard: true },
        )
      })

      // --- messages ---

      const messages = Effect.fn("GroupSession.messages")(function* (id: GroupSessionID) {
        const rows = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(GroupMessageTable)
              .where(eq(GroupMessageTable.group_session_id, id))
              .orderBy(GroupMessageTable.round_num, GroupMessageTable.time_created)
              .all(),
          ),
        )
        return rows.map(
          (row): GroupMessage => ({
            id: row.id,
            groupSessionID: row.group_session_id,
            roundNum: row.round_num,
            role: row.role,
            companyAgentID: row.company_agent_id ?? undefined,
            sessionID: row.session_id ?? undefined,
            content: row.content,
            statusSummary: row.status_summary ?? undefined,
            time: { created: row.time_created, updated: row.time_updated },
          }),
        )
      })

      // --- remove ---

      const remove = Effect.fn("GroupSession.remove")(function* (id: GroupSessionID) {
        const info = yield* get(id)
        // Remove each member session (cascades messages/parts)
        yield* Effect.forEach(
          info.members,
          (m) => sessionSvc.remove(m.sessionID as SessionID).pipe(Effect.ignore),
          { concurrency: "unbounded", discard: true },
        )
        yield* Effect.sync(() =>
          Database.use((db) =>
            db.delete(GroupSessionTable).where(eq(GroupSessionTable.id, id)).run(),
          ),
        )
        yield* bus.publish(Event.Deleted, { id })
      })

      return Service.of({ create, get, list, chat, interrupt, isBusy, messages, remove })
    }),
  )

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionPrompt.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

export * as GroupSession from "./group-session"
