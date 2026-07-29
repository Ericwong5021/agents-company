import { Context, Effect, Layer } from "effect"
import z from "zod"
import { CompanyTable } from "@/company/company.sql"
import { CompanyID } from "@/company/schema"
import { Identifier } from "@/id/id"
import { and, desc, eq, exists, inArray, isNotNull, isNull, lt, or } from "@/storage"
import * as Database from "@/storage/db"
import { GroupMessageTable, GroupSessionBiddingTable, GroupSessionMemberTable } from "@/group-session/group-session.sql"
import { GroupSessionID } from "@/group-session/schema"
import { AgentRunEventTable, AgentRunTable, AgentRunUsageTable } from "@/agent-run/agent-run.sql"
import { MessageTable, PartTable } from "@/session/session.sql"
import { MessageID, PartID } from "@/session/schema"
import {
  ChannelMemberTable,
  ChannelMessageTable,
  ChannelTable,
  ConversationRunTable,
  ConversationThreadMemberTable,
  ConversationThreadTable,
  RootNeedTable,
  SignalProjectionSourceTable,
  SignalProjectionTable,
  ensureCompanyChannels as ensureCompanyChannelRows,
} from "./conversation.sql"
import {
  ChannelID,
  ChannelKind,
  ChannelMessageCursor,
  ChannelMessageID,
  ChannelNotVisible,
  CompanyNotFound,
  ConversationMention,
  ConversationPrincipal,
  ConversationThreadID,
  ConversationThreadStatus,
  ConversationRunState,
  InvalidCursor,
  MessageAuthor,
  MessageVisibility,
  RequestConflict,
  RootNeedID,
  SignalProjectionID,
  SignalProjectionSourceKind,
  SignalType,
  SourceNotFound,
  ThreadNotVisible,
} from "./schema"
import * as Intake from "./intake"

export { MessageAccepted, SendMessageInput } from "./intake"

const PageLimit = z.number().int().min(1).max(100)

export const ChannelSummary = z
  .object({
    id: ChannelID,
    kind: ChannelKind,
    scopeID: z.string().optional(),
    title: z.string(),
    retentionDays: z.number().int().nonnegative(),
    time: z.object({
      created: z.number().int(),
      updated: z.number().int(),
      archived: z.number().int().optional(),
    }),
  })
  .strict()
export type ChannelSummary = z.infer<typeof ChannelSummary>

export const ChannelMessage = z
  .object({
    id: ChannelMessageID,
    channelID: ChannelID,
    rootNeedID: RootNeedID.optional(),
    sourceThreadID: ConversationThreadID.optional(),
    replyToID: ChannelMessageID.optional(),
    requestID: z.string().optional(),
    author: MessageAuthor,
    body: z.string(),
    signalType: SignalType.optional(),
    dri: ConversationPrincipal.optional(),
    visibility: MessageVisibility,
    mentions: z.array(ConversationMention),
    time: z.object({ created: z.number().int(), updated: z.number().int() }),
  })
  .strict()
export type ChannelMessage = z.infer<typeof ChannelMessage>

export const ConversationThreadMember = z
  .object({
    principal: ConversationPrincipal,
    time: z.object({
      joined: z.number().int(),
      left: z.number().int().optional(),
    }),
  })
  .strict()
export type ConversationThreadMember = z.infer<typeof ConversationThreadMember>

export const ConversationRunSnapshot = z
  .object({
    id: z.string(),
    state: ConversationRunState,
    attempt: z.number().int().nonnegative(),
    retryable: z.boolean(),
    safeErrorSummary: z.string().optional(),
    time: z.object({
      created: z.number().int(),
      updated: z.number().int(),
      started: z.number().int().optional(),
      finished: z.number().int().optional(),
    }),
  })
  .strict()
export type ConversationRunSnapshot = z.infer<typeof ConversationRunSnapshot>

export const ConversationThreadDetail = z
  .object({
    id: ConversationThreadID,
    channelID: ChannelID,
    rootNeedID: RootNeedID.optional(),
    projectScopeID: z.string().optional(),
    title: z.string(),
    status: ConversationThreadStatus,
    run: ConversationRunSnapshot.optional(),
    members: z.array(ConversationThreadMember),
    time: z.object({
      created: z.number().int(),
      updated: z.number().int(),
      archived: z.number().int().optional(),
    }),
  })
  .strict()
export type ConversationThreadDetail = z.infer<typeof ConversationThreadDetail>

export const ThreadSourceReference = z
  .object({
    ordinal: z.number().int().nonnegative(),
    kind: SignalProjectionSourceKind,
    sourceID: z.string().min(1),
  })
  .strict()

export const ThreadAgentMessage = z
  .object({
    id: z.string().min(1),
    roundNum: z.number().int().nonnegative(),
    agentID: z.string().min(1),
    sessionID: z.string().optional(),
    runtimeMessageID: z.string().optional(),
    skills: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    model: z.string().optional(),
    usage: z.object({
      source: z.enum(["runtime", "unavailable"]),
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      reasoningTokens: z.number().int().nonnegative().optional(),
      cacheReadTokens: z.number().int().nonnegative().optional(),
      cacheWriteTokens: z.number().int().nonnegative().optional(),
    }).optional(),
    body: z.string(),
    status: z.string().optional(),
    time: z.object({ created: z.number().int(), updated: z.number().int() }),
  })
  .strict()

export const ThreadBidding = z
  .object({
    id: z.string().min(1),
    roundNum: z.number().int().nonnegative(),
    state: z.enum(["bidding", "decided"]).default("decided"),
    winnerAgentID: z.string().optional(),
    bids: z.array(
      z.object({
        agentId: z.string().min(1),
        state: z.enum(["queued", "analyzing", "completed"]).default("completed"),
        level: z.enum(["must", "want", "could", "pass"]).optional(),
        type: z.enum(["objection", "answer", "question", "claim", "info", "support"]).optional(),
        addressedAs: z.enum(["direct", "mention", "none"]).optional(),
        reason: z.string().optional(),
        score: z.number().optional(),
        eligible: z.boolean().optional(),
      }),
    ),
    time: z.object({ created: z.number().int(), updated: z.number().int() }),
  })
  .strict()

export const ThreadEntry = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message"),
      message: ChannelMessage,
      sources: z.array(ThreadSourceReference).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("agent_message"),
      message: ThreadAgentMessage,
    })
    .strict(),
  z
    .object({
      type: z.literal("bidding"),
      bidding: ThreadBidding,
    })
    .strict(),
])
export type ThreadEntry = z.infer<typeof ThreadEntry>

export const ThreadSourceDetail = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("group_message"),
      roundNum: z.number().int().nonnegative(),
      role: z.enum(["user", "agent"]),
      agentID: z.string().optional(),
      sessionID: z.string().optional(),
      runtimeMessageID: z.string().optional(),
      body: z.string(),
      status: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("message"),
      role: z.enum(["user", "assistant"]),
      agentID: z.string(),
      sessionID: z.string(),
      body: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("part"),
      partType: z.string(),
      sessionID: z.string(),
      body: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("unavailable"),
      reason: z.string(),
    })
    .strict(),
])

export const ThreadSource = z
  .object({
    projectionID: SignalProjectionID,
    ordinal: z.number().int().nonnegative(),
    kind: SignalProjectionSourceKind,
    sourceID: z.string().min(1),
    detail: ThreadSourceDetail,
    time: z.object({ created: z.number().int(), updated: z.number().int() }),
  })
  .strict()
export type ThreadSource = z.infer<typeof ThreadSource>

export const ChannelMessagePage = z
  .object({
    items: z.array(ChannelMessage),
    nextCursor: z.string().optional(),
  })
  .strict()
export type ChannelMessagePage = z.infer<typeof ChannelMessagePage>

export const ThreadEntryPage = z
  .object({
    items: z.array(ThreadEntry),
    nextCursor: z.string().optional(),
  })
  .strict()
export type ThreadEntryPage = z.infer<typeof ThreadEntryPage>

export const ListChannelsInput = z
  .object({
    companyID: CompanyID,
    principal: ConversationPrincipal,
  })
  .strict()
export type ListChannelsInput = z.infer<typeof ListChannelsInput>

export const PageMessagesInput = z
  .object({
    companyID: CompanyID,
    channelID: ChannelID,
    principal: ConversationPrincipal,
    before: z.string().min(1).optional(),
    limit: PageLimit.optional(),
  })
  .strict()
export type PageMessagesInput = z.infer<typeof PageMessagesInput>

export const GetThreadInput = z
  .object({
    companyID: CompanyID,
    threadID: ConversationThreadID,
    principal: ConversationPrincipal,
  })
  .strict()
export type GetThreadInput = z.infer<typeof GetThreadInput>

export const PageEntriesInput = z
  .object({
    companyID: CompanyID,
    threadID: ConversationThreadID,
    principal: ConversationPrincipal,
    before: z.string().min(1).optional(),
    limit: PageLimit.optional(),
  })
  .strict()
export type PageEntriesInput = z.infer<typeof PageEntriesInput>

export const GetSourceInput = z
  .object({
    companyID: CompanyID,
    threadID: ConversationThreadID,
    sourceID: z.string().min(1),
    principal: ConversationPrincipal,
  })
  .strict()
export type GetSourceInput = z.infer<typeof GetSourceInput>

export const EnsureCompanyChannelsInput = z
  .object({
    companyID: CompanyID,
    boardAgentIDs: z.array(z.string().min(1)),
    now: z.number().int().nonnegative().optional(),
  })
  .strict()
export type EnsureCompanyChannelsInput = z.infer<typeof EnsureCompanyChannelsInput>

export const EnsureProjectChannelInput = z
  .object({
    companyID: CompanyID,
    projectScopeID: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    members: z.array(ConversationPrincipal).min(1),
  })
  .strict()
export type EnsureProjectChannelInput = z.infer<typeof EnsureProjectChannelInput>

export const RecordBoardDecisionInput = z
  .object({
    companyID: CompanyID,
    threadID: ConversationThreadID,
    principal: ConversationPrincipal,
    requestID: z.string().uuid(),
    projectScopeID: z.string().min(1),
    driAgentID: z.string().min(1),
    body: z.string().trim().min(1).max(20_000),
  })
  .strict()
export type RecordBoardDecisionInput = z.infer<typeof RecordBoardDecisionInput>

// TEAM-05：DRI 可由满足能力与权限的非 Board 角色承担；该输入用于按需授予其源 Thread 的成员资格。
export const EnsureThreadAccessInput = z
  .object({
    companyID: CompanyID,
    threadID: ConversationThreadID,
    principal: ConversationPrincipal,
  })
  .strict()
export type EnsureThreadAccessInput = z.infer<typeof EnsureThreadAccessInput>

type ChannelAccess = Pick<PageMessagesInput, "companyID" | "channelID" | "principal">
type ThreadAccess = Pick<GetThreadInput, "companyID" | "threadID" | "principal">

function channelFromRow(row: typeof ChannelTable.$inferSelect): ChannelSummary {
  return {
    id: row.id,
    kind: row.kind,
    scopeID: row.scope_id ?? undefined,
    title: row.title,
    retentionDays: row.retention_days,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      archived: row.time_archived ?? undefined,
    },
  }
}

function messageFromRow(row: typeof ChannelMessageTable.$inferSelect): ChannelMessage {
  return {
    id: row.id,
    channelID: row.channel_id,
    rootNeedID: row.root_need_id ?? undefined,
    sourceThreadID: row.source_thread_id ?? undefined,
    replyToID: row.reply_to_id ?? undefined,
    requestID: row.request_id ?? undefined,
    author: { kind: row.author_kind, id: row.author_id },
    body: row.body,
    signalType: row.signal_type ?? undefined,
    dri:
      row.dri_principal_kind && row.dri_principal_id
        ? { kind: row.dri_principal_kind, id: row.dri_principal_id }
        : undefined,
    visibility: row.visibility,
    mentions: row.mentions,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  }
}

function findVisibleChannel(input: ChannelAccess) {
  return Database.use((db) => {
    const channel = db
      .select()
      .from(ChannelTable)
      .where(
        and(
          eq(ChannelTable.company_id, input.companyID),
          eq(ChannelTable.id, input.channelID),
          isNull(ChannelTable.time_archived),
        ),
      )
      .get()
    if (!channel) return

    const membership = db
      .select({ channel_id: ChannelMemberTable.channel_id })
      .from(ChannelMemberTable)
      .where(
        and(
          eq(ChannelMemberTable.channel_id, channel.id),
          eq(ChannelMemberTable.principal_kind, input.principal.kind),
          eq(ChannelMemberTable.principal_id, input.principal.id),
          isNull(ChannelMemberTable.time_left),
        ),
      )
      .get()
    if (!membership) return
    return channel
  })
}

function findVisibleThread(input: ThreadAccess) {
  return Database.use((db) => {
    const thread = db
      .select()
      .from(ConversationThreadTable)
      .where(and(eq(ConversationThreadTable.company_id, input.companyID), eq(ConversationThreadTable.id, input.threadID)))
      .get()
    if (!thread) return

    const channel = db
      .select({ id: ChannelTable.id })
      .from(ChannelTable)
      .where(
        and(
          eq(ChannelTable.company_id, input.companyID),
          eq(ChannelTable.id, thread.channel_id),
          isNull(ChannelTable.time_archived),
        ),
      )
      .get()
    if (!channel) return

    const channelMember = db
      .select({ channel_id: ChannelMemberTable.channel_id })
      .from(ChannelMemberTable)
      .where(
        and(
          eq(ChannelMemberTable.channel_id, channel.id),
          eq(ChannelMemberTable.principal_kind, input.principal.kind),
          eq(ChannelMemberTable.principal_id, input.principal.id),
          isNull(ChannelMemberTable.time_left),
        ),
      )
      .get()
    if (!channelMember) return

    const threadMember = db
      .select({ conversation_thread_id: ConversationThreadMemberTable.conversation_thread_id })
      .from(ConversationThreadMemberTable)
      .where(
        and(
          eq(ConversationThreadMemberTable.conversation_thread_id, thread.id),
          eq(ConversationThreadMemberTable.principal_kind, input.principal.kind),
          eq(ConversationThreadMemberTable.principal_id, input.principal.id),
          isNull(ConversationThreadMemberTable.time_left),
        ),
      )
      .get()
    if (!threadMember) return
    return thread
  })
}

function decodeCursor(before?: string) {
  return Effect.try({
    try: () => {
      if (!before) return
      return ChannelMessageCursor.parse(JSON.parse(Buffer.from(before, "base64url").toString("utf8")))
    },
    catch: () => new InvalidCursor({}),
  })
}

function encodeCursor(row: typeof ChannelMessageTable.$inferSelect) {
  return Buffer.from(JSON.stringify({ id: row.id, time_created: row.time_created })).toString("base64url")
}

const ThreadEntryCursor = z.object({
  id: z.string().min(1),
  time_created: z.number().int().nonnegative(),
})
type ThreadEntryCursor = z.infer<typeof ThreadEntryCursor>

function decodeThreadCursor(before?: string) {
  return Effect.try({
    try: () => {
      if (!before) return
      return ThreadEntryCursor.parse(JSON.parse(Buffer.from(before, "base64url").toString("utf8")))
    },
    catch: () => new InvalidCursor({}),
  })
}

function encodeThreadCursor(row: { id: string; time_created: number }) {
  return Buffer.from(JSON.stringify(row)).toString("base64url")
}

function listVisibleChannels(input: ListChannelsInput) {
  return Database.use((db) => {
    const membershipIDs = new Set(
      db
        .select({ channel_id: ChannelMemberTable.channel_id })
        .from(ChannelMemberTable)
        .where(
          and(
            eq(ChannelMemberTable.principal_kind, input.principal.kind),
            eq(ChannelMemberTable.principal_id, input.principal.id),
            isNull(ChannelMemberTable.time_left),
          ),
        )
        .all()
        .map((row) => row.channel_id),
    )

    return db
      .select()
      .from(ChannelTable)
      .where(and(eq(ChannelTable.company_id, input.companyID), isNull(ChannelTable.time_archived)))
      .orderBy(ChannelTable.time_created, ChannelTable.id)
      .all()
      .filter((channel) => membershipIDs.has(channel.id))
  })
}

function readChannelMessages(input: {
  companyID: CompanyID
  channel: typeof ChannelTable.$inferSelect
  before?: ChannelMessageCursor
  limit: number
}) {
  return Database.use((db) => {
    const mainFeedMessage = or(
      eq(ChannelMessageTable.author_kind, "user"),
      and(
        isNotNull(ChannelMessageTable.signal_type),
        exists(
          db
            .select({ id: SignalProjectionTable.id })
            .from(SignalProjectionTable)
            .where(eq(SignalProjectionTable.channel_message_id, ChannelMessageTable.id)),
        ),
      ),
    )
    const channelScope =
      input.channel.kind === "company"
        ? or(
            eq(ChannelMessageTable.channel_id, input.channel.id),
            and(
              eq(ChannelMessageTable.visibility, "company"),
              exists(
                db
                  .select({ id: ConversationThreadTable.id })
                  .from(ConversationThreadTable)
                  .where(
                    and(
                      eq(ConversationThreadTable.id, ChannelMessageTable.source_thread_id),
                      eq(ConversationThreadTable.company_id, input.companyID),
                    ),
                  ),
              ),
            ),
          )
        : eq(ChannelMessageTable.channel_id, input.channel.id)
    return db
      .select()
      .from(ChannelMessageTable)
      .where(
        input.before
          ? and(
              channelScope,
              mainFeedMessage,
              or(
                lt(ChannelMessageTable.time_created, input.before.time_created),
                and(
                  eq(ChannelMessageTable.time_created, input.before.time_created),
                  lt(ChannelMessageTable.id, input.before.id),
                ),
              ),
            )
          : and(
              channelScope,
              mainFeedMessage,
            ),
      )
      .orderBy(desc(ChannelMessageTable.time_created), desc(ChannelMessageTable.id))
      .limit(input.limit + 1)
      .all()
  })
}

function projectionSources(channelMessageID: ChannelMessageID): z.infer<typeof ThreadSourceReference>[] {
  return Database.use((db) => {
    const projection = db
      .select({ id: SignalProjectionTable.id })
      .from(SignalProjectionTable)
      .where(eq(SignalProjectionTable.channel_message_id, channelMessageID))
      .get()
    if (!projection) return []
    return db
      .select()
      .from(SignalProjectionSourceTable)
      .where(eq(SignalProjectionSourceTable.signal_projection_id, projection.id))
      .orderBy(SignalProjectionSourceTable.ordinal)
      .all()
      .map((source) => ({ ordinal: source.ordinal, kind: source.source_kind, sourceID: source.source_id }))
  })
}

function readThreadEntries(input: {
  threadID: ConversationThreadID
  channelID: ChannelID
  before?: ThreadEntryCursor
  limit: number
}) {
  return Database.use((db) => {
    const channelMessages = db
      .select()
      .from(ChannelMessageTable)
      .where(
        and(
          eq(ChannelMessageTable.channel_id, input.channelID),
          eq(ChannelMessageTable.source_thread_id, input.threadID),
        ),
      )
      .all()
    const runtimeIDs = db
      .select({ runtime_id: ConversationRunTable.runtime_id })
      .from(ConversationRunTable)
      .where(and(eq(ConversationRunTable.conversation_thread_id, input.threadID), isNotNull(ConversationRunTable.runtime_id)))
      .all()
      .map((run) => GroupSessionID.zod.safeParse(run.runtime_id).data)
      .filter((runtimeID): runtimeID is GroupSessionID => Boolean(runtimeID))
    const agentMessages = runtimeIDs.length
      ? db
          .select()
          .from(GroupMessageTable)
          .where(and(inArray(GroupMessageTable.group_session_id, runtimeIDs), eq(GroupMessageTable.role, "agent")))
          .all()
      : []
    const biddings = runtimeIDs.length
      ? db
          .select()
          .from(GroupSessionBiddingTable)
          .where(inArray(GroupSessionBiddingTable.group_session_id, runtimeIDs))
          .all()
      : []
    const evidenceByRun = new Map(
      agentMessages
        .flatMap((message) => (message.agent_run_id ? [message.agent_run_id] : []))
        .map((runID) => [
          runID,
          (() => {
            const events = db
              .select({ type: AgentRunEventTable.type, payload_json: AgentRunEventTable.payload_json })
              .from(AgentRunEventTable)
              .where(eq(AgentRunEventTable.agent_run_id, runID))
              .all()
            const skills = events
              .filter((event) => event.type === "agent_run.skill_loaded")
              .flatMap((event) => {
                const payload = z
                  .object({ skillID: z.string() })
                  .safeParse(z.json().safeParse(event.payload_json).success ? JSON.parse(event.payload_json) : undefined)
                return payload.success ? [payload.data.skillID] : []
              })
            const tools = events
              .filter((event) => event.type === "runtime.tool")
              .flatMap((event) => {
                const payload = z
                  .object({ toolName: z.string() })
                  .safeParse(z.json().safeParse(event.payload_json).success ? JSON.parse(event.payload_json) : undefined)
                return payload.success ? [payload.data.toolName] : []
              })
            return {
              skills: [...new Set(skills)],
              tools: [...new Set(tools)],
              model: db.select({ model: AgentRunTable.model }).from(AgentRunTable).where(eq(AgentRunTable.id, runID)).get()?.model ?? undefined,
              usage: (() => {
                const usage = db.select().from(AgentRunUsageTable).where(eq(AgentRunUsageTable.agent_run_id, runID)).get()
                if (!usage) return
                return {
                  source: usage.source as "runtime" | "unavailable",
                  inputTokens: usage.input_tokens ?? undefined,
                  outputTokens: usage.output_tokens ?? undefined,
                  reasoningTokens: usage.reasoning_tokens ?? undefined,
                  cacheReadTokens: usage.cache_read_tokens ?? undefined,
                  cacheWriteTokens: usage.cache_write_tokens ?? undefined,
                }
              })(),
            }
          })(),
        ] as const),
    )
    return [
      ...channelMessages.map((row) => ({
        id: `message:${row.id}`,
        time_created: row.time_created,
        entry: {
          type: "message" as const,
          message: messageFromRow(row),
          ...(projectionSources(row.id).length ? { sources: projectionSources(row.id) } : {}),
        },
      })),
      ...agentMessages.map((row) => ({
        id: `agent_message:${row.id}`,
        time_created: row.time_created,
        entry: {
          type: "agent_message" as const,
          message: {
            id: row.id,
            roundNum: row.round_num,
            agentID: row.company_agent_id ?? "unknown-agent",
            sessionID: row.session_id ?? undefined,
            runtimeMessageID: row.runtime_message_id ?? undefined,
            skills: row.agent_run_id ? evidenceByRun.get(row.agent_run_id)?.skills : undefined,
            tools: row.agent_run_id ? evidenceByRun.get(row.agent_run_id)?.tools : undefined,
            model: row.agent_run_id ? evidenceByRun.get(row.agent_run_id)?.model : undefined,
            usage: row.agent_run_id ? evidenceByRun.get(row.agent_run_id)?.usage : undefined,
            body: row.content,
            status: row.status_summary ?? undefined,
            time: { created: row.time_created, updated: row.time_updated },
          },
        },
      })),
      ...biddings.flatMap((row) => {
        const bids = ThreadBidding.shape.bids.safeParse(row.bids_json)
        if (!bids.success) return []
        return [{
          id: `bidding:${row.id}`,
          time_created: row.time_created,
          entry: {
            type: "bidding" as const,
            bidding: {
              id: row.id,
              roundNum: row.round_num,
              state: row.state,
              winnerAgentID: row.winner_agent_id ?? undefined,
              bids: bids.data,
              time: { created: row.time_created, updated: row.time_updated },
            },
          },
        }]
      }),
    ]
      .filter(
        (row) =>
          !input.before ||
          row.time_created < input.before.time_created ||
          (row.time_created === input.before.time_created && row.id < input.before.id),
      )
      .sort((a, b) => b.time_created - a.time_created || b.id.localeCompare(a.id))
      .slice(0, input.limit + 1)
  })
}

function safePartBody(data: (typeof PartTable.$inferSelect)["data"]) {
  if (data.type === "text" && "text" in data && typeof data.text === "string") return data.text.slice(0, 20_000)
  if (data.type === "tool" && "tool" in data) return `${String(data.tool)} (tool result hidden)`
  return data.type
}

function hydrateThreadSource(input: {
  kind: SignalProjectionSourceKind
  sourceID: string
  conversationRunID: (typeof ConversationRunTable.$inferSelect)["id"] | null
}): z.infer<typeof ThreadSourceDetail> | undefined {
  return Database.use((db) => {
    const runtimeID = input.conversationRunID
      ? db
          .select({ runtime_id: ConversationRunTable.runtime_id })
          .from(ConversationRunTable)
          .where(eq(ConversationRunTable.id, input.conversationRunID))
          .get()?.runtime_id
      : undefined
    if (input.kind === "group_message") {
      const message = db.select().from(GroupMessageTable).where(eq(GroupMessageTable.id, input.sourceID)).get()
      if (!message || !runtimeID || message.group_session_id !== runtimeID) return
      return {
        type: "group_message",
        roundNum: message.round_num,
        role: message.role,
        agentID: message.company_agent_id ?? undefined,
        sessionID: message.session_id ?? undefined,
        runtimeMessageID: message.runtime_message_id ?? undefined,
        body: message.content,
        status: message.status_summary ?? undefined,
      }
    }

    const groupSessionID = GroupSessionID.zod.safeParse(runtimeID).data
    if (!groupSessionID) return
    const sessionIDs = new Set(
      db
        .select({ session_id: GroupSessionMemberTable.session_id })
        .from(GroupSessionMemberTable)
        .where(eq(GroupSessionMemberTable.group_session_id, groupSessionID))
        .all()
        .map((member) => member.session_id),
    )
    if (input.kind === "message") {
      const messageID = MessageID.zod.safeParse(input.sourceID).data
      if (!messageID) return
      const message = db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).get()
      if (!message || !sessionIDs.has(message.session_id)) return
      return {
        type: "message",
        role: message.data.role,
        agentID: message.agent_id,
        sessionID: message.session_id,
        body: db
          .select({ data: PartTable.data })
          .from(PartTable)
          .where(eq(PartTable.message_id, message.id))
          .all()
          .map((part) => safePartBody(part.data))
          .filter(Boolean)
          .join("\n")
          .slice(0, 20_000),
      }
    }
    if (input.kind === "part") {
      const partID = PartID.zod.safeParse(input.sourceID).data
      if (!partID) return
      const part = db.select().from(PartTable).where(eq(PartTable.id, partID)).get()
      if (!part || !sessionIDs.has(part.session_id)) return
      return {
        type: "part",
        partType: part.data.type,
        sessionID: part.session_id,
        body: safePartBody(part.data),
      }
    }
    return { type: "unavailable", reason: `No M2 hydrator exists for ${input.kind} sources.` }
  })
}

function uniqueMembers(members: ConversationPrincipal[]) {
  return [...new Map(members.map((member) => [`${member.kind}:${member.id}`, member])).values()]
}

export interface Interface {
  readonly listChannels: (input: ListChannelsInput) => Effect.Effect<ChannelSummary[]>
  readonly pageMessages: (input: PageMessagesInput) => Effect.Effect<ChannelMessagePage, InstanceType<typeof ChannelNotVisible> | InstanceType<typeof InvalidCursor>>
  readonly getThread: (input: GetThreadInput) => Effect.Effect<ConversationThreadDetail, InstanceType<typeof ThreadNotVisible>>
  readonly pageEntries: (input: PageEntriesInput) => Effect.Effect<ThreadEntryPage, InstanceType<typeof ThreadNotVisible> | InstanceType<typeof InvalidCursor>>
  readonly getSource: (input: GetSourceInput) => Effect.Effect<ThreadSource, InstanceType<typeof ThreadNotVisible> | InstanceType<typeof SourceNotFound>>
  readonly sendMessage: (input: Intake.SendMessageInput) => Effect.Effect<Intake.MessageAccepted, Intake.SendMessageError>
  readonly ensureCompanyChannels: (input: EnsureCompanyChannelsInput) => Effect.Effect<void>
  readonly ensureProjectChannel: (input: EnsureProjectChannelInput) => Effect.Effect<ChannelSummary, InstanceType<typeof CompanyNotFound>>
  readonly ensureThreadAccess: (input: EnsureThreadAccessInput) => Effect.Effect<void, InstanceType<typeof ThreadNotVisible>>
  readonly recordBoardDecision: (
    input: RecordBoardDecisionInput,
  ) => Effect.Effect<ChannelMessage, InstanceType<typeof ThreadNotVisible> | InstanceType<typeof RequestConflict>>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/Conversation") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const listChannels = Effect.fn("Conversation.listChannels")(function* (input: ListChannelsInput) {
      return (yield* Effect.sync(() => listVisibleChannels(input))).map(channelFromRow)
    })

    const pageMessages = Effect.fn("Conversation.pageMessages")(function* (input: PageMessagesInput) {
      const channel = yield* Effect.sync(() => findVisibleChannel(input))
      if (!channel) {
        return yield* Effect.fail(
          new ChannelNotVisible({ company_id: input.companyID, channel_id: input.channelID }),
        )
      }
      const before = yield* decodeCursor(input.before)
      const limit = input.limit ?? 50
      const rows = yield* Effect.sync(() => readChannelMessages({ companyID: input.companyID, channel, before, limit }))
      const items = rows.slice(0, limit)
      const tail = items.at(-1)
      return {
        items: items.map(messageFromRow),
        nextCursor: rows.length > limit && tail ? encodeCursor(tail) : undefined,
      }
    })

    const getThread = Effect.fn("Conversation.getThread")(function* (input: GetThreadInput) {
      const thread = yield* Effect.sync(() => findVisibleThread(input))
      if (!thread) {
        return yield* Effect.fail(new ThreadNotVisible({ company_id: input.companyID, thread_id: input.threadID }))
      }
      const members = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(ConversationThreadMemberTable)
            .where(eq(ConversationThreadMemberTable.conversation_thread_id, thread.id))
            .orderBy(ConversationThreadMemberTable.time_joined, ConversationThreadMemberTable.principal_id)
            .all(),
        ),
      )
      const run = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(ConversationRunTable)
            .where(eq(ConversationRunTable.conversation_thread_id, thread.id))
            .orderBy(desc(ConversationRunTable.time_created), desc(ConversationRunTable.id))
            .get(),
        ),
      )
      return {
        id: thread.id,
        channelID: thread.channel_id,
        rootNeedID: thread.root_need_id ?? undefined,
        projectScopeID: thread.project_scope_id ?? undefined,
        title: thread.title,
        status: thread.status,
        run: run
          ? {
              id: run.id,
              state: run.state,
              attempt: run.attempt,
              retryable: run.retryable,
              safeErrorSummary: run.safe_error_summary ?? undefined,
              time: {
                created: run.time_created,
                updated: run.time_updated,
                started: run.time_started ?? undefined,
                finished: run.time_finished ?? undefined,
              },
            }
          : undefined,
        members: members.map((member) => ({
          principal: { kind: member.principal_kind, id: member.principal_id },
          time: { joined: member.time_joined, left: member.time_left ?? undefined },
        })),
        time: {
          created: thread.time_created,
          updated: thread.time_updated,
          archived: thread.time_archived ?? undefined,
        },
      }
    })

    const pageEntries = Effect.fn("Conversation.pageEntries")(function* (input: PageEntriesInput) {
      const thread = yield* Effect.sync(() => findVisibleThread(input))
      if (!thread) {
        return yield* Effect.fail(new ThreadNotVisible({ company_id: input.companyID, thread_id: input.threadID }))
      }
      const before = yield* decodeThreadCursor(input.before)
      const limit = input.limit ?? 50
      const rows = yield* Effect.sync(() =>
        readThreadEntries({ threadID: thread.id, channelID: thread.channel_id, before, limit }),
      )
      const items = rows.slice(0, limit)
      const tail = items.at(-1)
      return {
        items: items.map((row) => row.entry),
        nextCursor: rows.length > limit && tail ? encodeThreadCursor({ id: tail.id, time_created: tail.time_created }) : undefined,
      }
    })

    const getSource = Effect.fn("Conversation.getSource")(function* (input: GetSourceInput) {
      const thread = yield* Effect.sync(() => findVisibleThread(input))
      if (!thread) {
        return yield* Effect.fail(new ThreadNotVisible({ company_id: input.companyID, thread_id: input.threadID }))
      }
      const source = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({
              projection_id: SignalProjectionSourceTable.signal_projection_id,
              ordinal: SignalProjectionSourceTable.ordinal,
              source_kind: SignalProjectionSourceTable.source_kind,
              source_id: SignalProjectionSourceTable.source_id,
              conversation_run_id: SignalProjectionTable.conversation_run_id,
              time_created: SignalProjectionSourceTable.time_created,
              time_updated: SignalProjectionSourceTable.time_updated,
            })
            .from(SignalProjectionSourceTable)
            .innerJoin(
              SignalProjectionTable,
              eq(SignalProjectionTable.id, SignalProjectionSourceTable.signal_projection_id),
            )
            .where(
              and(
                eq(SignalProjectionTable.conversation_thread_id, thread.id),
                eq(SignalProjectionSourceTable.source_id, input.sourceID),
              ),
            )
            .orderBy(SignalProjectionTable.time_created, SignalProjectionSourceTable.ordinal)
            .get(),
        ),
      )
      if (!source) {
        return yield* Effect.fail(new SourceNotFound({ thread_id: input.threadID, source_id: input.sourceID }))
      }
      const detail = yield* Effect.sync(() =>
        hydrateThreadSource({
          kind: source.source_kind,
          sourceID: source.source_id,
          conversationRunID: source.conversation_run_id,
        }),
      )
      if (!detail) {
        return yield* Effect.fail(new SourceNotFound({ thread_id: input.threadID, source_id: input.sourceID }))
      }
      return {
        projectionID: source.projection_id,
        ordinal: source.ordinal,
        kind: source.source_kind,
        sourceID: source.source_id,
        detail,
        time: { created: source.time_created, updated: source.time_updated },
      }
    })

    const ensureCompanyChannels = Effect.fn("Conversation.ensureCompanyChannels")(function* (
      input: EnsureCompanyChannelsInput,
    ) {
      yield* Effect.sync(() =>
        ensureCompanyChannelRows({
          companyID: input.companyID,
          boardAgentIDs: input.boardAgentIDs,
          now: input.now ?? Date.now(),
        }),
      )
    })

    const ensureProjectChannel = Effect.fn("Conversation.ensureProjectChannel")(function* (
      input: EnsureProjectChannelInput,
    ) {
      const channel = yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const company = db.select({ id: CompanyTable.id }).from(CompanyTable).where(eq(CompanyTable.id, input.companyID)).get()
            if (!company) return

            const existing = db
              .select()
              .from(ChannelTable)
              .where(
                and(
                  eq(ChannelTable.company_id, input.companyID),
                  eq(ChannelTable.kind, "project"),
                  eq(ChannelTable.scope_id, input.projectScopeID),
                ),
              )
              .get()
            if (existing) return existing

            const now = Date.now()
            const created = {
              id: ChannelID.parse(Identifier.ascending("channel")),
              company_id: input.companyID,
              kind: "project" as const,
              scope_id: input.projectScopeID,
              title: input.title,
              retention_days: 0,
              time_created: now,
              time_updated: now,
              time_archived: null,
            }
            db.insert(ChannelTable).values(created).run()
            db.insert(ChannelMemberTable)
              .values(
                uniqueMembers(input.members).map((member) => ({
                  channel_id: created.id,
                  principal_kind: member.kind,
                  principal_id: member.id,
                  role: member.kind === "user" ? ("owner" as const) : ("member" as const),
                  time_joined: now,
                  time_created: now,
                  time_updated: now,
                  time_left: null,
                })),
              )
              .run()
            return created
          },
          { behavior: "immediate" },
        ),
      )
      if (!channel) return yield* Effect.fail(new CompanyNotFound({ company_id: input.companyID }))
      return channelFromRow(channel)
    })

    // TEAM-05：非 Board 成员被指派为 DRI 时，授予其源 Thread 的 channel + thread 成员资格（幂等，可重入）。
    const ensureThreadAccess = Effect.fn("Conversation.ensureThreadAccess")(function* (
      input: EnsureThreadAccessInput,
    ) {
      const granted = yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const thread = db
              .select()
              .from(ConversationThreadTable)
              .where(
                and(
                  eq(ConversationThreadTable.company_id, input.companyID),
                  eq(ConversationThreadTable.id, input.threadID),
                ),
              )
              .get()
            if (!thread) return false
            const now = Date.now()
            db.insert(ChannelMemberTable)
              .values({
                channel_id: thread.channel_id,
                principal_kind: input.principal.kind,
                principal_id: input.principal.id,
                role: "member",
                time_joined: now,
                time_created: now,
                time_updated: now,
                time_left: null,
              })
              .onConflictDoUpdate({
                target: [
                  ChannelMemberTable.channel_id,
                  ChannelMemberTable.principal_kind,
                  ChannelMemberTable.principal_id,
                ],
                set: { time_left: null, time_updated: now },
              })
              .run()
            db.insert(ConversationThreadMemberTable)
              .values({
                conversation_thread_id: thread.id,
                principal_kind: input.principal.kind,
                principal_id: input.principal.id,
                time_joined: now,
                time_created: now,
                time_updated: now,
                time_left: null,
              })
              .onConflictDoUpdate({
                target: [
                  ConversationThreadMemberTable.conversation_thread_id,
                  ConversationThreadMemberTable.principal_kind,
                  ConversationThreadMemberTable.principal_id,
                ],
                set: { time_left: null, time_updated: now },
              })
              .run()
            return true
          },
          { behavior: "immediate" },
        ),
      )
      if (!granted) {
        return yield* Effect.fail(new ThreadNotVisible({ company_id: input.companyID, thread_id: input.threadID }))
      }
    })

    const recordBoardDecision = Effect.fn("Conversation.recordBoardDecision")(function* (
      input: RecordBoardDecisionInput,
    ) {
      const visible = yield* Effect.sync(() => findVisibleThread(input))
      if (!visible) {
        return yield* Effect.fail(new ThreadNotVisible({ company_id: input.companyID, thread_id: input.threadID }))
      }
      const result = yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const thread = db
              .select()
              .from(ConversationThreadTable)
              .where(
                and(
                  eq(ConversationThreadTable.company_id, input.companyID),
                  eq(ConversationThreadTable.id, input.threadID),
                ),
              )
              .get()
            if (!thread?.root_need_id) return { type: "not_found" as const }
            const channel = db.select().from(ChannelTable).where(eq(ChannelTable.id, thread.channel_id)).get()
            if (!channel || channel.kind !== "board") return { type: "not_found" as const }
            const existing = db
              .select()
              .from(ChannelMessageTable)
              .where(
                and(
                  eq(ChannelMessageTable.channel_id, channel.id),
                  eq(ChannelMessageTable.request_id, input.requestID),
                ),
              )
              .get()
            if (existing) {
              const same =
                existing.source_thread_id === thread.id &&
                existing.root_need_id === thread.root_need_id &&
                existing.author_kind === "agent" &&
                existing.author_id === input.driAgentID &&
                existing.dri_principal_kind === "agent" &&
                existing.dri_principal_id === input.driAgentID &&
                existing.signal_type === "decision" &&
                existing.body === input.body &&
                thread.project_scope_id === input.projectScopeID
              return same ? { type: "accepted" as const, message: existing } : { type: "conflict" as const }
            }

            const now = Date.now()
            const messageID = ChannelMessageID.parse(Identifier.ascending("channelMessage"))
            const projectionID = SignalProjectionID.parse(Identifier.ascending("signalProjection"))
            const run = db
              .select({ id: ConversationRunTable.id })
              .from(ConversationRunTable)
              .where(eq(ConversationRunTable.conversation_thread_id, thread.id))
              .orderBy(desc(ConversationRunTable.time_created), desc(ConversationRunTable.id))
              .get()
            const message = {
              id: messageID,
              channel_id: channel.id,
              root_need_id: thread.root_need_id,
              source_thread_id: thread.id,
              reply_to_id: null,
              request_id: input.requestID,
              author_kind: "agent" as const,
              author_id: input.driAgentID,
              body: input.body,
              signal_type: "decision" as const,
              dri_principal_kind: "agent" as const,
              dri_principal_id: input.driAgentID,
              visibility: "company" as const,
              mentions: [],
              time_created: now,
              time_updated: now,
            }
            db.update(ConversationThreadTable)
              .set({
                project_scope_id: input.projectScopeID,
                status: "completed",
                time_updated: now,
              })
              .where(eq(ConversationThreadTable.id, thread.id))
              .run()
            db.update(RootNeedTable)
              .set({ status: "in_progress", time_updated: now })
              .where(eq(RootNeedTable.id, thread.root_need_id))
              .run()
            db.insert(ChannelMessageTable).values(message).run()
            db.insert(SignalProjectionTable)
              .values({
                id: projectionID,
                channel_message_id: messageID,
                conversation_thread_id: thread.id,
                conversation_run_id: run?.id ?? null,
                projector_version: 2,
                source_watermark: `decision:${input.projectScopeID}:${input.requestID}`,
                time_created: now,
                time_updated: now,
              })
              .run()
            db.insert(SignalProjectionSourceTable)
              .values({
                signal_projection_id: projectionID,
                ordinal: 0,
                source_kind: "decision",
                source_id: input.projectScopeID,
                time_created: now,
                time_updated: now,
              })
              .run()
            db.update(ChannelTable).set({ time_updated: now }).where(eq(ChannelTable.id, channel.id)).run()
            return { type: "accepted" as const, message }
          },
          { behavior: "immediate" },
        ),
      )
      if (result.type === "accepted") return messageFromRow(result.message)
      if (result.type === "conflict") {
        return yield* Effect.fail(new RequestConflict({ channel_id: visible.channel_id, request_id: input.requestID }))
      }
      return yield* Effect.fail(new ThreadNotVisible({ company_id: input.companyID, thread_id: input.threadID }))
    })

    const sendMessage = Intake.sendMessage

    return Service.of({
      listChannels,
      pageMessages,
      getThread,
      pageEntries,
      getSource,
      sendMessage,
      ensureCompanyChannels,
      ensureProjectChannel,
      ensureThreadAccess,
      recordBoardDecision,
    })
  }),
)

export const defaultLayer = layer

export * as Conversation from "./conversation"
