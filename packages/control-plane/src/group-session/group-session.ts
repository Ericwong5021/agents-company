import z from "zod"
import { Context, Effect, Layer, Ref, Stream } from "effect"
import { Database, eq, and, desc } from "../storage"
import { GroupSessionTable, GroupSessionMemberTable, GroupMessageTable, GroupSessionBiddingTable } from "./group-session.sql"
import { GroupContextPolicy, GroupSessionID } from "./schema"
import { ChannelMessageID } from "@/conversation/schema"
import { MessageID } from "../session/schema"
import type { SessionID } from "../session/schema"
import type { ProjectID } from "../project/schema"
import type { CompanyAgentID } from "../company-agent/schema"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import type { MessageV2 } from "@/session/message-v2"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { BiddingScheduler } from "./scheduler/BiddingScheduler"
import { probeOne } from "./scheduler/probe"
import type { ProbeInput } from "./scheduler/probe"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { Agent, BOARD_DISCUSSION_AGENT_ID } from "@/agent/agent"
import { Provider } from "@/provider"
import type { ModelID, ProviderID } from "@/provider/schema"
import { LLM } from "@/session/llm"
import { AgentRun } from "@/agent-run/agent-run"
import { AgentRunSupervisor } from "@/agent-run/supervisor"
import { CompanyTable, RepositoryBindingTable } from "@/company/company.sql"
import { AgentTurn } from "@/agent-turn"
import { CompanyAgent } from "@/company-agent"
import { Config } from "@/config"

const MEMBER_CONCURRENCY = 3

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
  contextPolicy: GroupContextPolicy.optional(),
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
  externalMessageID: ChannelMessageID.optional(),
  runtimeMessageID: MessageID.zod.optional(),
  agentRunID: z.string().optional(),
  time: z.object({ created: z.number(), updated: z.number() }),
})
export type GroupMessage = z.infer<typeof GroupMessage>

export const GroupBidding = z.object({
  id: z.string(),
  groupSessionID: GroupSessionID.zod,
  roundNum: z.number(),
  state: z.enum(["bidding", "decided"]).default("decided"),
  winnerAgentID: z.string().optional(),
  bids: z.array(
    z.object({
      agentId: z.string(),
      state: z.enum(["queued", "analyzing", "completed"]).default("completed"),
      level: z.enum(["must", "want", "could", "pass"]).optional(),
      type: z.enum(["objection", "answer", "question", "claim", "info", "support"]).optional(),
      addressedAs: z.enum(["direct", "mention", "none"]).optional(),
      reason: z.string().optional(),
      score: z.number().optional(),
      eligible: z.boolean().optional(),
    }),
  ),
  time: z.object({ created: z.number(), updated: z.number() }),
})
export type GroupBidding = z.infer<typeof GroupBidding>

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const CreateInput = z.object({
  id: GroupSessionID.zod.optional(),
  title: z.string().min(1),
  agentIDs: z.array(z.string()).min(1).max(10),
  contextPolicy: GroupContextPolicy.optional(),
})
export type CreateInput = z.infer<typeof CreateInput>

export const ChatInput = z.object({
  groupSessionID: GroupSessionID.zod,
  text: z.string().min(1),
  externalMessageID: ChannelMessageID.optional(),
})
export type ChatInput = z.infer<typeof ChatInput>

export const ChatResult = z.object({
  roundNum: z.number(),
  userGroupMessageID: z.string(),
})
export type ChatResult = z.infer<typeof ChatResult>

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
      userGroupMessageID: z.string(),
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
  // before agent fan-out starts. Clients use this to show the user bubble.
  UserMessagePersisted: BusEvent.define(
    "group_session.user_message_persisted",
    z.object({
      groupSessionID: GroupSessionID.zod,
      roundNum: z.number(),
    }),
  ),
  // Fires per-member when an agent's prompt begins. Clients use this to show
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
  // statusSummary distinguishes the outcome for clients.
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
  TurnYielded: BusEvent.define(
    "group_session.turn_yielded",
    z.object({
      groupSessionID: GroupSessionID.zod,
      consecutiveAgentTurns: z.number(),
      reason: z.enum(["budget_K_reached", "all_pass", "no_bid_over_threshold"]),
    }),
  ),
  // Fires when a bidding round starts probing all members.
  BiddingStarted: BusEvent.define(
    "group_session.bidding_started",
    z.object({
      groupSessionID: GroupSessionID.zod,
      roundNum: z.number(),
    }),
  ),
  // Fires when a bidding round completes (probe + arbitrate) with full details.
  BiddingCompleted: BusEvent.define(
    "group_session.bidding_completed",
    z.object({
      groupSessionID: GroupSessionID.zod,
      roundNum: z.number(),
      winnerId: z.string().nullable(),
      bids: z.array(
        z.object({
          agentId: z.string(),
          level: z.enum(["must", "want", "could", "pass"]),
          type: z.enum(["objection", "answer", "question", "claim", "info", "support"]),
          addressedAs: z.enum(["direct", "mention", "none"]),
          reason: z.string(),
          score: z.number(),
          eligible: z.boolean(),
        }),
      ),
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
  readonly chat: (input: ChatInput) => Effect.Effect<ChatResult>
  readonly resume: (input: { groupSessionID: GroupSessionID; roundNum: number }) => Effect.Effect<void>
  readonly promptMember: (input: {
    groupSessionID: GroupSessionID
    companyAgentID: string
    text: string
    format?: Extract<MessageV2.OutputFormat, { type: "json_schema" }>
  }) => Effect.Effect<MessageV2.WithParts, Error>
  readonly interrupt: (id: GroupSessionID) => Effect.Effect<void>
  readonly isBusy: (id: GroupSessionID) => Effect.Effect<boolean>
  readonly messages: (id: GroupSessionID) => Effect.Effect<GroupMessage[]>
  readonly biddings: (id: GroupSessionID) => Effect.Effect<GroupBidding[]>
  readonly remove: (id: GroupSessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/GroupSession") {}

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
  const row = Database.use((db) => db.select().from(GroupSessionTable).where(eq(GroupSessionTable.id, groupID)).get())
  if (!row) return undefined
  const members = loadMembers(groupID)
  return {
    id: row.id,
    projectID: row.project_id,
    title: row.title,
    contextPolicy: row.context_policy ?? undefined,
    members,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      archived: row.time_archived ?? undefined,
    },
  }
}

function loadCompanyModel(projectID: string, fallback?: { providerID: ProviderID; modelID: ModelID }) {
  const company = Database.use((db) =>
    db
      .select({
        providerID: CompanyTable.default_provider_id,
        modelID: CompanyTable.default_model_id,
      })
      .from(CompanyTable)
      .innerJoin(RepositoryBindingTable, eq(RepositoryBindingTable.company_id, CompanyTable.id))
      .where(eq(RepositoryBindingTable.project_id, projectID as ProjectID))
      .get(),
  )
  if (!company) return fallback
  if (company.providerID === "unconfigured" || company.modelID === "unconfigured") return fallback
  return company
}

// Build the shared transcript injected into each member's prompt. The current
// round is deliberately included so a later speaker can respond to the actual
// conversation, not merely to the immediately preceding completion.
function buildGroupContext(groupID: GroupSessionID): string {
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
  externalMessageID?: z.infer<typeof ChannelMessageID>
  runtimeMessageID?: MessageID
  agentRunID?: string
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
        external_message_id: input.externalMessageID ?? null,
        runtime_message_id: input.runtimeMessageID ?? null,
        agent_run_id: input.agentRunID ?? null,
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  return id
}

function persistBidding(input: Omit<GroupBidding, "id" | "time">) {
  const now = Date.now()
  Database.use((db) =>
    db
      .insert(GroupSessionBiddingTable)
      .values({
        id: `bidding:${input.groupSessionID}:${input.roundNum}`,
        group_session_id: input.groupSessionID,
        round_num: input.roundNum,
        state: input.state,
        winner_agent_id: input.winnerAgentID ?? null,
        bids_json: input.bids,
        time_created: now,
        time_updated: now,
      })
      .onConflictDoUpdate({
        target: [GroupSessionBiddingTable.group_session_id, GroupSessionBiddingTable.round_num],
        set: {
          state: input.state,
          winner_agent_id: input.winnerAgentID ?? null,
          bids_json: input.bids,
          time_updated: now,
        },
      })
      .run(),
  )
}

function extractMessageText(msg: MessageV2.WithParts): string {
  return msg.parts
    .filter((part): part is Extract<MessageV2.Part, { type: "text" }> => part.type === "text" && !!part.text)
    .map((p) => p.text)
    .join("")
}

function findExternalMessage(input: {
  groupSessionID: GroupSessionID
  externalMessageID: z.infer<typeof ChannelMessageID>
}) {
  return Database.use((db) =>
    db
      .select({ id: GroupMessageTable.id, round_num: GroupMessageTable.round_num })
      .from(GroupMessageTable)
      .where(
        and(
          eq(GroupMessageTable.group_session_id, input.groupSessionID),
          eq(GroupMessageTable.external_message_id, input.externalMessageID),
        ),
      )
      .get(),
  )
}

type PublicCompanyAgent = {
  name: string
  description: string
  role: string
  responsibilities: string[]
  model?: string
  runtime: "pi" | "claude-code" | "codex"
}

function loadPublicCompanyAgent(id: CompanyAgentID): PublicCompanyAgent | undefined {
  const row = Database.use((db) =>
    db
      .select({
        name: CompanyAgentTable.name,
        description: CompanyAgentTable.description,
        role: CompanyAgentTable.role_key,
        responsibilities: CompanyAgentTable.responsibilities,
        model: CompanyAgentTable.model,
        runtime: CompanyAgentTable.preferred_runtime,
        lifecycle: CompanyAgentTable.lifecycle,
      })
      .from(CompanyAgentTable)
      .where(eq(CompanyAgentTable.id, id))
      .get(),
  )
  if (!row || row.lifecycle !== "employee") return
  return {
    name: row.name,
    description: row.description ?? "",
    role: row.role ?? id,
    responsibilities: row.responsibilities ? JSON.parse(row.responsibilities) : [],
    model: row.model ?? undefined,
    runtime: row.runtime === "claude-code" || row.runtime === "pi" ? row.runtime : "codex",
  }
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer: Layer.Layer<
  Service,
  never,
  | Session.Service
  | SessionPrompt.Service
  | SessionStatus.Service
  | SessionRunState.Service
  | Bus.Service
  | Agent.Service
  | Provider.Service
  | LLM.Service
  | AgentRunSupervisor.Service
  | CompanyAgent.Service
  | Config.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessionSvc = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const statusSvc = yield* SessionStatus.Service
    const runState = yield* SessionRunState.Service
    const bus = yield* Bus.Service
    const agentSvc = yield* Agent.Service
    const provider = yield* Provider.Service
    const llmSvc = yield* LLM.Service
    const agentRunSupervisor = yield* AgentRunSupervisor.Service
    const companyAgentSvc = yield* CompanyAgent.Service
    const config = yield* Config.Service
    const activeSchedulers = yield* Ref.make(new Set<string>())
    const interruptedSchedulers = yield* Ref.make(new Set<string>())
    const activeAgentRuns = yield* Ref.make(new Map<string, Set<string>>())

    const resolveCompanyModel = Effect.fn("GroupSession.resolveCompanyModel")(function* (projectID: string) {
      const globalModel = yield* provider.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
      return yield* Effect.sync(() => loadCompanyModel(projectID, globalModel))
    })

    // --- create ---

    const create = Effect.fn("GroupSession.create")(function* (input: CreateInput) {
      const project = Instance.project

      const now = Date.now()
      const groupID = input.id ?? GroupSessionID.ascending()
      const existing = yield* Effect.sync(() => loadGroupInfo(groupID))
      if (existing && existing.projectID !== project.id) {
        return yield* Effect.die(new Error(`GroupSession ${groupID} belongs to another project`))
      }

      if (!existing) {
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .insert(GroupSessionTable)
              .values({
                id: groupID,
                project_id: project.id as ProjectID,
                title: input.title,
                context_policy: input.contextPolicy ?? null,
                time_created: now,
                time_updated: now,
              })
              .run(),
          ),
        )
      }

      const existingAgentIDs = new Set(loadMembers(groupID).map((member) => member.companyAgentID))
      for (const [i, agentID] of input.agentIDs.entries()) {
        if (existingAgentIDs.has(agentID)) continue
        const session = yield* sessionSvc.create({
          title: `${input.title} — ${agentID}`,
          ...(input.contextPolicy === "work_scoped"
            ? {
                permission: [
                  { permission: "*", pattern: "*", action: "deny" },
                  { permission: "StructuredOutput", pattern: "*", action: "allow" },
                ],
              }
            : {}),
          ...(input.contextPolicy === "work_scoped" ? {} : { companyAgentID: agentID as CompanyAgentID }),
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
      yield* bus.publish(existing ? Event.Updated : Event.Created, info)
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
          contextPolicy: row.context_policy ?? undefined,
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
      const active = yield* Ref.get(activeSchedulers)
      if (active.has(id)) return true
      const info = yield* get(id)
      const statuses = yield* Effect.forEach(info.members, (m) => statusSvc.get(m.sessionID as SessionID), {
        concurrency: MEMBER_CONCURRENCY,
      })
      return statuses.some((s) => s.type === "busy")
    })

    // --- probe helpers ---

    // --- chat ---

    const chat = Effect.fn("GroupSession.chat")(function* (input: ChatInput) {
      const externalMessageID = input.externalMessageID
      const replay = externalMessageID
        ? yield* Effect.sync(() =>
            findExternalMessage({
              groupSessionID: input.groupSessionID,
              externalMessageID,
            }),
          )
        : undefined
      if (replay) return { roundNum: replay.round_num, userGroupMessageID: replay.id }

      const busy = yield* isBusy(input.groupSessionID)
      if (busy) return yield* Effect.die(new BusyError(input.groupSessionID))

      const info = yield* get(input.groupSessionID)
      const roundNum = yield* Effect.sync(() => currentRoundNum(input.groupSessionID))

      // Save the user message to the group message store
      const userGroupMessageID = yield* Effect.sync(() =>
        insertGroupMessage({
          groupSessionID: input.groupSessionID,
          roundNum,
          role: "user",
          content: input.text,
          externalMessageID: input.externalMessageID,
        }),
      )

      const memberSessionIDs = info.members.map((m) => m.sessionID)

      yield* bus.publish(Event.ChatSent, {
        groupSessionID: input.groupSessionID,
        roundNum,
        userGroupMessageID,
        memberSessionIDs,
      })

      yield* bus.publish(Event.UserMessagePersisted, {
        groupSessionID: input.groupSessionID,
        roundNum,
      })

      yield* startScheduler({
        info,
        roundNum,
        groupSessionID: input.groupSessionID,
        userText: input.text,
      })
      return { roundNum, userGroupMessageID }
    })

    const promptMember = Effect.fn("GroupSession.promptMember")(function* (input: {
      groupSessionID: GroupSessionID
      companyAgentID: string
      text: string
      format?: Extract<MessageV2.OutputFormat, { type: "json_schema" }>
    }) {
      const member = (yield* get(input.groupSessionID)).members.find(
        (item) => item.companyAgentID === input.companyAgentID,
      )
      if (!member) return yield* Effect.fail(new Error(`Group session member ${input.companyAgentID} was not found`))
      const group = yield* get(input.groupSessionID)
      const model = group.contextPolicy === "work_scoped" ? yield* resolveCompanyModel(group.projectID) : undefined
      return yield* promptSvc.prompt({
        sessionID: member.sessionID as SessionID,
        agentID: group.contextPolicy === "work_scoped" ? BOARD_DISCUSSION_AGENT_ID : "main",
        source: "spawn",
        ...(model ? { model } : {}),
        ...(input.format ? { format: input.format } : {}),
        parts: [{ type: "text", text: input.text }],
      })
    })

    function needsHumanFallback(text: string) {
      return (
        /[?？@]/.test(text) ||
        /\b(what|why|how|who|when|where|can|could|would|please|help)\b/i.test(text) ||
        /(?:请|帮我|告诉我|解释|分析|评估|给我|需要|能否|是否|为什么|怎么|如何|谁|什么|哪个)/.test(text)
      )
    }

    /**
     * The core bidding loop:
     * 1. Parallel probe all members
     * 2. Arbitrate to select a speaker
     * 3. If idle: human fallback (if user-msg triggered) or natural stop
     * 4. If yield: publish TurnYielded and stop
     * 5. If winner: prompt the speaker, save response, settle rights, re-bid
     */
    const runBiddingLoop = Effect.fn("GroupSession.runBiddingLoop")(function* (params: {
      info: Info
      roundNum: number
      groupSessionID: GroupSessionID
      userText: string
      priorAgentMessages?: GroupMessage[]
    }) {
      const memberIds = params.info.members.map((m) => m.companyAgentID)
      const scheduler = new BiddingScheduler(params.groupSessionID, memberIds)
      const companyModel =
        params.info.contextPolicy === "work_scoped" ? yield* resolveCompanyModel(params.info.projectID) : undefined

      // Work-scoped sessions deliberately use only public company fields.
      const agentInfos: Record<string, PublicCompanyAgent> = {}
      for (const m of params.info.members) {
        const ag = yield* Effect.sync(() => loadPublicCompanyAgent(m.companyAgentID as CompanyAgentID))
        if (ag) agentInfos[m.companyAgentID] = ag
      }

      const isInterrupted = Effect.fn("GroupSession.isInterrupted")(function* () {
        return (yield* Ref.get(interruptedSchedulers)).has(params.groupSessionID)
      })

      // Resolve probe dependencies (from closure)
      const probeAgent = yield* agentSvc.get("probe").pipe(Effect.orElseSucceed(() => undefined))

      const probeCtx = { agentSvc, provider, llm: llmSvc, probeAgent, model: companyModel }

      // Fairness survives user turns for the lifetime of a Group Session. Historical
      // speakers restore cooldown and staleness without consuming the new turn's K
      // budget; a resumed in-flight round still restores its full turn state.
      const historicalSpeakerIDs = (yield* messages(params.groupSessionID))
        .filter(
          (message) =>
            message.role === "agent" && message.roundNum < params.roundNum && message.statusSummary === "done",
        )
        .map((message) => message.companyAgentID)
        .filter((companyAgentID): companyAgentID is string => Boolean(companyAgentID))
      historicalSpeakerIDs.forEach((companyAgentID) => scheduler.restoreRightsAfterSpeaker(companyAgentID))

      // A resumed process has only persisted group messages, not scheduler state.
      // Replaying completed speakers restores the current round's K budget and
      // prevents the first finished agent from being prompted a second time.
      const priorAgentMessages = (params.priorAgentMessages ?? []).filter((message) => message.statusSummary === "done")
      const priorSpeakerIDs = priorAgentMessages
        .map((message) => message.companyAgentID)
        .filter((companyAgentID): companyAgentID is string => Boolean(companyAgentID))
      priorSpeakerIDs.forEach((companyAgentID) => scheduler.afterSpeak(companyAgentID))

      // Round 1: triggered by user message
      const speakersThisTurn = new Set(priorSpeakerIDs)

      const probeRound = (lastEvent: string) =>
        Effect.gen(function* () {
          const roundNum = scheduler.state.round + 1
          const record = yield* Ref.make<Omit<GroupBidding, "id" | "time">>({
            groupSessionID: params.groupSessionID,
            roundNum,
            state: "bidding",
            bids: params.info.members.map((member) => ({ agentId: member.companyAgentID, state: "queued" })),
          })
          const persist = Effect.flatMap(Ref.get(record), (bidding) => Effect.sync(() => persistBidding(bidding)))
          const update = (agentID: string, bid: Partial<GroupBidding["bids"][number]>) =>
            Effect.gen(function* () {
              yield* Ref.update(record, (bidding) => ({
                ...bidding,
                bids: bidding.bids.map((current) => current.agentId === agentID ? { ...current, ...bid } : current),
              }))
              yield* persist
            })
          yield* persist
          yield* bus.publish(Event.BiddingStarted, { groupSessionID: params.groupSessionID, roundNum })
          return yield* Effect.forEach(
            params.info.members,
            (member) =>
              Effect.gen(function* () {
                yield* update(member.companyAgentID, { state: "analyzing" })
                const agent = agentInfos[member.companyAgentID]
                const transcript = yield* Effect.sync(() => buildGroupContext(params.groupSessionID))
                const bid = yield* probeOne(probeCtx, {
                  persona: {
                    name: agent?.name ?? member.companyAgentID,
                    role: member.companyAgentID,
                    description: agent?.description ?? "",
                  },
                  lastEvent,
                  transcript,
                  members: Object.values(agentInfos).map((a) => ({ name: a.name, role: a.description ?? a.name })),
                  groupSessionID: params.groupSessionID,
                  onPublicRationale: (reason) => update(member.companyAgentID, { state: "analyzing", reason }),
                })
                yield* update(member.companyAgentID, { ...bid, state: "completed" })
                return { agentId: member.companyAgentID, bid }
              }),
            { concurrency: MEMBER_CONCURRENCY },
          )
        })

      let bids = yield* probeRound(`User sent a new message: ${params.userText}`)

      if (yield* isInterrupted()) return

      let selection = scheduler.decide(bids)
      if (selection.type === "idle" && needsHumanFallback(params.userText)) selection = scheduler.decideFallback()

      // Emit BiddingCompleted with full scored-bid data
      {
        const arb = scheduler.lastArbitration
        if (arb) {
          const bidding = {
            groupSessionID: params.groupSessionID,
            roundNum: scheduler.state.round,
            state: "decided" as const,
            winnerAgentID:
              selection.type === "winner" || selection.type === "human_fallback" ? selection.agentId : arb.winnerId ?? undefined,
            bids: arb.scored.map((s) => ({
              agentId: s.agentId,
              state: "completed" as const,
              level: s.bid.level,
              type: s.bid.type,
              addressedAs: s.bid.addressedAs,
              reason: s.bid.reason,
              score: s.score,
              eligible: s.eligible,
            })),
          }
          yield* Effect.sync(() => persistBidding(bidding))
          yield* bus.publish(Event.BiddingCompleted, {
            groupSessionID: bidding.groupSessionID,
            roundNum: bidding.roundNum,
            winnerId: bidding.winnerAgentID ?? null,
            bids: bidding.bids,
          })
        }
      }

      // Re-bid loop
      while (true) {
        if (yield* isInterrupted()) return
        if (selection.type === "yielded") {
          yield* bus.publish(Event.TurnYielded, {
            groupSessionID: params.groupSessionID,
            consecutiveAgentTurns: scheduler.state.consecutiveAgentTurns,
            reason: "budget_K_reached",
          })
          yield* bus.publish(Event.RoundComplete, {
            groupSessionID: params.groupSessionID,
            roundNum: params.roundNum,
          })
          return
        }

        if (selection.type === "idle") {
          yield* bus.publish(Event.TurnYielded, {
            groupSessionID: params.groupSessionID,
            consecutiveAgentTurns: scheduler.state.consecutiveAgentTurns,
            reason: selection.reason === "none_over_threshold" ? "no_bid_over_threshold" : "all_pass",
          })
          yield* bus.publish(Event.RoundComplete, {
            groupSessionID: params.groupSessionID,
            roundNum: params.roundNum,
          })
          return
        }

        if (selection.type === "winner" || selection.type === "human_fallback") {
          const speakerId = selection.agentId

          const member = params.info.members.find((m) => m.companyAgentID === speakerId)
          if (!member) break

          const agentInfo = agentInfos[speakerId]
          const speakerName = agentInfo?.name ?? speakerId

          yield* bus.publish(Event.AgentStarted, {
            groupSessionID: params.groupSessionID,
            roundNum: params.roundNum,
            sessionID: member.sessionID,
            companyAgentID: speakerId,
          })

          const turn = yield* AgentTurn.prepare({
            agentID: speakerId as CompanyAgentID,
            transcript: yield* Effect.sync(() => buildGroupContext(params.groupSessionID)),
            message: params.userText,
            companyAgents: companyAgentSvc,
            config,
          })

          const result = yield* agentInfo
            ? Effect.gen(function* () {
                const started = yield* agentRunSupervisor.start({
                  agentID: speakerId,
                  runtime: turn.runtime,
                  lifecycle: "on_demand",
                  permissionMode: "read_only",
                  model:
                    turn.model ??
                    (turn.runtime === "pi" && companyModel ? `${companyModel.providerID}/${companyModel.modelID}` : undefined),
                  cwd: Instance.worktree,
                  prompt: turn.prompt,
                  capabilityPacks: [],
                  requiredRuntimeCapabilities: ["structuredEvents", "toolCalls", "usageAccounting", "governanceSignals"],
                  allowSignalPublishing: true,
                  systemPrompt: turn.systemPrompt,
                  groupSessionID: params.groupSessionID,
                })
                yield* Ref.update(activeAgentRuns, (runs) => {
                  const next = new Map(runs)
                  const ids = new Set(next.get(params.groupSessionID) ?? [])
                  ids.add(started.runID)
                  next.set(params.groupSessionID, ids)
                  return next
                })
                return yield* Effect.promise(() => started.completion).pipe(
                  Effect.map((run) => ({
                    content: run.content.trim(),
                    runtimeMessageID: undefined,
                    agentRunID: started.runID,
                    statusSummary: run.exitCode === 0 ? ("done" as const) : ("error" as const),
                  })),
                  Effect.catch(() =>
                    Effect.succeed({
                      content: "",
                      runtimeMessageID: undefined,
                      agentRunID: started.runID,
                      statusSummary: "error" as const,
                    }),
                  ),
                  Effect.ensuring(
                    Ref.update(activeAgentRuns, (runs) => {
                      const next = new Map(runs)
                      const ids = new Set(next.get(params.groupSessionID) ?? [])
                      ids.delete(started.runID)
                      if (ids.size === 0) next.delete(params.groupSessionID)
                      if (ids.size > 0) next.set(params.groupSessionID, ids)
                      return next
                    }),
                  ),
                )
              })
            : promptSvc
                .prompt({
                  sessionID: member.sessionID as SessionID,
                  agentID: params.info.contextPolicy === "work_scoped" ? BOARD_DISCUSSION_AGENT_ID : "main",
                  source: "user",
                  ...(companyModel ? { model: companyModel } : {}),
                  parts: [{ type: "text", text: turn.prompt }],
                })
                .pipe(
                  Effect.matchEffect({
                    onSuccess: (msg) =>
                      Effect.succeed({
                        content: extractMessageText(msg),
                        runtimeMessageID: msg.info.id,
                        agentRunID: undefined,
                        statusSummary:
                          msg.info.role === "assistant" && (msg.info.finish === "cancelled" || msg.info.error)
                            ? msg.info.finish === "cancelled"
                              ? ("interrupted" as const)
                              : ("error" as const)
                            : ("done" as const),
                      }),
                    onFailure: () =>
                      Effect.succeed({
                        content: "",
                        runtimeMessageID: undefined,
                        agentRunID: undefined,
                        statusSummary: "error" as const,
                      }),
                  }),
                )

          yield* Effect.sync(() =>
            insertGroupMessage({
              groupSessionID: params.groupSessionID,
              roundNum: params.roundNum,
              role: "agent",
              companyAgentID: speakerId as CompanyAgentID,
              sessionID: member.sessionID as SessionID,
              content: result.content,
              statusSummary: result.statusSummary,
              runtimeMessageID: result.runtimeMessageID,
              agentRunID: result.agentRunID,
            }),
          )

          yield* bus.publish(Event.AgentCompleted, {
            groupSessionID: params.groupSessionID,
            roundNum: params.roundNum,
            sessionID: member.sessionID,
            companyAgentID: speakerId,
            statusSummary: result.statusSummary,
          })

          if (yield* isInterrupted()) return
          if (result.statusSummary !== "done") {
            yield* bus.publish(Event.RoundComplete, {
              groupSessionID: params.groupSessionID,
              roundNum: params.roundNum,
            })
            return
          }
          scheduler.afterSpeak(speakerId)
          speakersThisTurn.add(speakerId)

          bids = yield* probeRound(`Agent ${speakerName} just spoke in the shared discussion.`)
          if (yield* isInterrupted()) return
          selection = scheduler.decide(bids)

          // Emit BiddingCompleted for the re-bid round
          {
            const arb = scheduler.lastArbitration
            if (arb) {
              const bidding = {
                groupSessionID: params.groupSessionID,
                roundNum: scheduler.state.round,
                state: "decided" as const,
                winnerAgentID: arb.winnerId ?? undefined,
                bids: arb.scored.map((s) => ({
                  agentId: s.agentId,
                  state: "completed" as const,
                  level: s.bid.level,
                  type: s.bid.type,
                  addressedAs: s.bid.addressedAs,
                  reason: s.bid.reason,
                  score: s.score,
                  eligible: s.eligible,
                })),
              }
              yield* Effect.sync(() => persistBidding(bidding))
              yield* bus.publish(Event.BiddingCompleted, {
                groupSessionID: bidding.groupSessionID,
                roundNum: bidding.roundNum,
                winnerId: bidding.winnerAgentID ?? null,
                bids: bidding.bids,
              })
            }
          }
        }
      }

      yield* bus.publish(Event.RoundComplete, {
        groupSessionID: params.groupSessionID,
        roundNum: params.roundNum,
      })
    })

    const startScheduler = Effect.fn("GroupSession.startScheduler")(function* (input: {
      info: Info
      roundNum: number
      groupSessionID: GroupSessionID
      userText: string
      priorAgentMessages?: GroupMessage[]
    }) {
      yield* Ref.update(interruptedSchedulers, (s) => {
        const next = new Set(s)
        next.delete(input.groupSessionID)
        return next
      })
      yield* Ref.update(activeSchedulers, (s) => new Set(s).add(input.groupSessionID))
      yield* runBiddingLoop(input).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Ref.update(activeSchedulers, (s) => {
              const next = new Set(s)
              next.delete(input.groupSessionID)
              return next
            })
            yield* Ref.update(interruptedSchedulers, (s) => {
              const next = new Set(s)
              next.delete(input.groupSessionID)
              return next
            })
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
          }),
        ),
        Effect.forkDetach,
      )
    })

    const resume = Effect.fn("GroupSession.resume")(function* (input: {
      groupSessionID: GroupSessionID
      roundNum: number
    }) {
      if (yield* isBusy(input.groupSessionID)) return
      const info = yield* get(input.groupSessionID)
      const roundMessages = (yield* messages(input.groupSessionID)).filter(
        (message) => message.roundNum === input.roundNum,
      )
      const userMessage = roundMessages.find((message) => message.role === "user")
      if (!userMessage) return
      const requiredSpeakers =
        info.contextPolicy === "work_scoped" ? info.members.length : Math.min(2, info.members.length)
      if (new Set(roundMessages.flatMap((message) => (message.companyAgentID ? [message.companyAgentID] : []))).size >= requiredSpeakers) return
      yield* startScheduler({
        info,
        roundNum: input.roundNum,
        groupSessionID: input.groupSessionID,
        userText: userMessage.content,
        priorAgentMessages: roundMessages.filter((message) => message.role === "agent"),
      })
    })

    // --- interrupt ---

    const interrupt = Effect.fn("GroupSession.interrupt")(function* (id: GroupSessionID) {
      const info = yield* get(id)
      yield* Ref.update(interruptedSchedulers, (s) => new Set(s).add(id))
      const cliRuns = [...((yield* Ref.get(activeAgentRuns)).get(id) ?? [])]
      yield* Effect.forEach(cliRuns, (runID) => agentRunSupervisor.interrupt(runID).pipe(Effect.ignore), {
        concurrency: MEMBER_CONCURRENCY,
        discard: true,
      })
      yield* Effect.forEach(
        info.members,
        (m) =>
          Effect.all(
            [
              runState.cancel(m.sessionID as SessionID).pipe(Effect.ignore),
              runState.cancelActor(m.sessionID as SessionID, BOARD_DISCUSSION_AGENT_ID).pipe(Effect.ignore),
            ],
            { discard: true },
          ),
        { concurrency: MEMBER_CONCURRENCY, discard: true },
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
          externalMessageID: row.external_message_id ?? undefined,
          runtimeMessageID: row.runtime_message_id ?? undefined,
          agentRunID: row.agent_run_id ?? undefined,
          time: { created: row.time_created, updated: row.time_updated },
        }),
      )
    })

    const biddings = Effect.fn("GroupSession.biddings")(function* (id: GroupSessionID) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(GroupSessionBiddingTable)
            .where(eq(GroupSessionBiddingTable.group_session_id, id))
            .orderBy(GroupSessionBiddingTable.round_num, GroupSessionBiddingTable.time_created)
            .all(),
        ),
      )
      return rows.flatMap((row) => {
        const bids = GroupBidding.shape.bids.safeParse(row.bids_json)
        if (!bids.success) return []
        return [{
          id: row.id,
          groupSessionID: row.group_session_id,
          roundNum: row.round_num,
          state: row.state,
          winnerAgentID: row.winner_agent_id ?? undefined,
          bids: bids.data,
          time: { created: row.time_created, updated: row.time_updated },
        }]
      })
    })

    // --- remove ---

    const remove = Effect.fn("GroupSession.remove")(function* (id: GroupSessionID) {
      const info = yield* get(id)
      yield* interrupt(id)
      // Remove each member session (cascades messages/parts)
      yield* Effect.forEach(info.members, (m) => sessionSvc.remove(m.sessionID as SessionID).pipe(Effect.ignore), {
        concurrency: MEMBER_CONCURRENCY,
        discard: true,
      })
      yield* Effect.sync(() =>
        Database.use((db) => db.delete(GroupSessionTable).where(eq(GroupSessionTable.id, id)).run()),
      )
      yield* bus.publish(Event.Deleted, { id })
    })

    return Service.of({ create, get, list, chat, resume, promptMember, interrupt, isBusy, messages, biddings, remove })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionPrompt.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(AgentRunSupervisor.defaultLayer),
    Layer.provide(CompanyAgent.defaultLayer),
    Layer.provide(Config.defaultLayer),
  ),
)

export * as GroupSession from "./group-session"
