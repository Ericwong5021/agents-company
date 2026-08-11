import { Effect } from "effect"
import z from "zod"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { CompanyTable } from "@/company/company.sql"
import { CompanyID } from "@/company/schema"
import { Identifier } from "@/id/id"
import { and, eq, isNull } from "@/storage"
import * as Database from "@/storage/db"
import {
  ChannelMemberTable,
  ChannelMessageTable,
  ChannelTable,
  ConversationRunTable,
  ConversationThreadMemberTable,
  ConversationThreadTable,
  RootNeedTable,
} from "./conversation.sql"
import { classifyMessageIntent, IntentOverride, MessageIntentKind } from "./intent"
import {
  ChannelID,
  ChannelMessageID,
  ChannelNotVisible,
  ChannelNotWritable,
  CompanyNotFound,
  ConversationMention,
  ConversationPrincipal,
  ConversationResource,
  ConversationRunID,
  ConversationThreadID,
  MentionNotVisible,
  MessageInvalidInput,
  ReplyNotVisible,
  RequestConflict,
  RootNeedID,
  ThreadNotVisible,
  ThreadNotWritable,
} from "./schema"

const ConversationUser = z.object({ kind: z.literal("user"), id: z.string().min(1) }).strict()

export const SendMessageInput = z
  .object({
    companyID: CompanyID,
    channelID: ChannelID,
    principal: ConversationUser,
    requestID: z.string().uuid(),
    body: z.string().trim().min(1).max(20_000),
    replyToID: ChannelMessageID.optional(),
    referencedThreadID: ConversationThreadID.optional(),
    mentions: z.array(ConversationMention).max(20).default([]),
    resources: z.array(ConversationResource).max(8).default([]),
    intentOverride: IntentOverride.optional(),
  })
  .strict()
export type SendMessageInput = z.input<typeof SendMessageInput>
type ParsedSendMessageInput = z.output<typeof SendMessageInput>

export const MessageAccepted = z
  .object({
    messageID: ChannelMessageID,
    rootNeedID: RootNeedID.optional(),
    threadID: ConversationThreadID.optional(),
    runID: ConversationRunID.optional(),
    replayed: z.boolean(),
    // GOAL-01：分类结果投影（仅对 Board 新消息有意义）。不暴露模型内部推理。
    intent: MessageIntentKind.optional(),
    intentConfidence: z.number().min(0).max(1).optional(),
    autoProjected: z.boolean().optional(),
    needsIntentConfirmation: z.boolean().optional(),
  })
  .strict()
export type MessageAccepted = z.infer<typeof MessageAccepted>

export type SendMessageError = Error

type TransactionResult =
  | { type: "accepted"; value: MessageAccepted }
  | { type: "company_not_found" }
  | { type: "channel_not_visible" }
  | { type: "channel_not_writable" }
  | { type: "mention_not_visible" }
  | { type: "reply_not_visible" }
  | { type: "thread_not_visible"; threadID: ConversationThreadID }
  | { type: "thread_not_writable"; threadID: ConversationThreadID }
  | { type: "request_conflict" }

function activeChannelMember(input: { channelID: ChannelID; principal: ConversationPrincipal }) {
  return Database.use((db) =>
    db
      .select({ channel_id: ChannelMemberTable.channel_id })
      .from(ChannelMemberTable)
      .where(
        and(
          eq(ChannelMemberTable.channel_id, input.channelID),
          eq(ChannelMemberTable.principal_kind, input.principal.kind),
          eq(ChannelMemberTable.principal_id, input.principal.id),
          isNull(ChannelMemberTable.time_left),
        ),
      )
      .get(),
  )
}

function mentionsAreVisible(input: { companyID: CompanyID; channelID: ChannelID; mentions: ConversationMention[] }) {
  return input.mentions.every((mention) => {
    if (mention.kind === "agent") {
      return Boolean(activeChannelMember({ channelID: input.channelID, principal: { kind: "agent", id: mention.agent_id } }))
    }

    const agent = Database.use((db) =>
      db
        .select({ id: CompanyAgentTable.id })
        .from(CompanyAgentTable)
        .where(
          and(
            eq(CompanyAgentTable.company_id, input.companyID),
            eq(CompanyAgentTable.role_key, mention.role),
            eq(CompanyAgentTable.lifecycle, "employee"),
          ),
        )
        .get(),
    )
    if (!agent) return false
    return Boolean(activeChannelMember({ channelID: input.channelID, principal: { kind: "agent", id: agent.id } }))
  })
}

function acceptedFromMessage(
  message: typeof ChannelMessageTable.$inferSelect,
  replayed: boolean,
  channel: typeof ChannelTable.$inferSelect,
) {
  const run = Database.use((db) =>
    db
      .select({ id: ConversationRunTable.id })
      .from(ConversationRunTable)
      .where(eq(ConversationRunTable.channel_message_id, message.id))
      .get(),
  )
  // 分类器是确定性的，重放时重新推导意图投影而无需额外持久化。
  const projection = channel.kind === "board" ? classifyMessageIntent(message.body) : undefined
  const projectedIntent = message.root_need_id && projection && !projection.createsProject ? "goal" : projection?.kind
  return {
    messageID: message.id,
    rootNeedID: message.root_need_id ?? undefined,
    threadID: message.source_thread_id ?? undefined,
    runID: run?.id,
    replayed,
    intent: projectedIntent,
    intentConfidence: projectedIntent === "goal" && projection?.kind !== "goal" ? 1 : projection?.confidence,
    autoProjected: projection ? Boolean(message.root_need_id) : undefined,
    needsIntentConfirmation: projection ? false : undefined,
  }
}

function sameRequest(
  message: typeof ChannelMessageTable.$inferSelect,
  input: ParsedSendMessageInput,
  channel: typeof ChannelTable.$inferSelect,
  thread: typeof ConversationThreadTable.$inferSelect | undefined,
) {
  if (message.author_kind !== input.principal.kind || message.author_id !== input.principal.id) return false
  if (message.body !== input.body || (message.reply_to_id ?? undefined) !== input.replyToID) return false
  if (JSON.stringify(message.mentions) !== JSON.stringify(input.mentions)) return false
  if (JSON.stringify(message.resources) !== JSON.stringify(input.resources)) return false
  if (thread) return message.source_thread_id === thread.id
  // Board 消息的根需求/线程投影由意图分类确定；作者/正文/提及/回复已匹配即为同一请求。
  if (channel.kind === "board") return true
  return !message.root_need_id && !message.source_thread_id
}

function threadTitle(body: string) {
  return body.replace(/\s+/g, " ").slice(0, 120)
}

function createBoardThread(input: ParsedSendMessageInput, channel: typeof ChannelTable.$inferSelect, now: number) {
  const rootNeedID = RootNeedID.parse(Identifier.ascending("rootNeed"))
  const thread = {
    id: ConversationThreadID.parse(Identifier.ascending("conversationThread")),
    company_id: input.companyID,
    channel_id: channel.id,
    root_need_id: rootNeedID,
    project_scope_id: channel.scope_id,
    title: threadTitle(input.body),
    status: "active" as const,
    time_archived: null,
    time_created: now,
    time_updated: now,
  }
  Database.use((db) => {
    db.insert(RootNeedTable)
      .values({
        id: rootNeedID,
        company_id: input.companyID,
        channel_id: channel.id,
        body: input.body,
        status: "open",
        time_resolved: null,
        time_created: now,
        time_updated: now,
      })
      .run()
    db.insert(ConversationThreadTable).values(thread).run()
    db.insert(ConversationThreadMemberTable)
      .values(
        db
          .select({ principal_kind: ChannelMemberTable.principal_kind, principal_id: ChannelMemberTable.principal_id })
          .from(ChannelMemberTable)
          .where(and(eq(ChannelMemberTable.channel_id, channel.id), isNull(ChannelMemberTable.time_left)))
          .all()
          .map((member) => ({
            conversation_thread_id: thread.id,
            principal_kind: member.principal_kind,
            principal_id: member.principal_id,
            time_joined: now,
            time_created: now,
            time_updated: now,
            time_left: null,
          })),
      )
      .run()
  })
  return { rootNeedID, thread }
}

function write(input: ParsedSendMessageInput): TransactionResult {
  return Database.transaction(
    (db) => {
      const company = db.select({ id: CompanyTable.id }).from(CompanyTable).where(eq(CompanyTable.id, input.companyID)).get()
      if (!company) return { type: "company_not_found" }

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
      if (!channel) return { type: "channel_not_visible" }
      if (!activeChannelMember({ channelID: channel.id, principal: input.principal })) {
        return { type: "channel_not_visible" }
      }
      if (channel.kind === "department" || channel.kind === "direct") return { type: "channel_not_writable" }
      if (channel.kind === "project" && !channel.scope_id) return { type: "channel_not_writable" }
      if (!mentionsAreVisible({ companyID: input.companyID, channelID: channel.id, mentions: input.mentions })) {
        return { type: "mention_not_visible" }
      }

      const reply = input.replyToID
        ? db.select().from(ChannelMessageTable).where(eq(ChannelMessageTable.id, input.replyToID)).get()
        : undefined
      if (input.replyToID && (!reply || reply.channel_id !== channel.id)) return { type: "reply_not_visible" }
      if (input.referencedThreadID && reply?.source_thread_id && reply.source_thread_id !== input.referencedThreadID) {
        return { type: "reply_not_visible" }
      }

      const referencedThreadID = input.referencedThreadID ?? reply?.source_thread_id ?? undefined
      const thread = referencedThreadID
        ? db
            .select()
            .from(ConversationThreadTable)
            .where(
              and(
                eq(ConversationThreadTable.company_id, input.companyID),
                eq(ConversationThreadTable.channel_id, channel.id),
                eq(ConversationThreadTable.id, referencedThreadID),
              ),
            )
            .get()
        : undefined
      if (referencedThreadID && !thread) return { type: "thread_not_visible", threadID: referencedThreadID }
      if (thread && (thread.time_archived || thread.status !== "active")) {
        return { type: "thread_not_writable", threadID: thread.id }
      }
      if (thread && !activeThreadMember({ threadID: thread.id, principal: input.principal })) {
        return { type: "thread_not_visible", threadID: thread.id }
      }
      if (thread?.root_need_id) {
        const rootNeed = db.select().from(RootNeedTable).where(eq(RootNeedTable.id, thread.root_need_id)).get()
        if (!rootNeed || rootNeed.company_id !== input.companyID || rootNeed.channel_id !== channel.id) {
          return { type: "thread_not_visible", threadID: thread.id }
        }
      }

      const existing = db
        .select()
        .from(ChannelMessageTable)
        .where(and(eq(ChannelMessageTable.channel_id, channel.id), eq(ChannelMessageTable.request_id, input.requestID)))
        .get()
      if (existing && !sameRequest(existing, input, channel, thread)) return { type: "request_conflict" }
      const now = Date.now()
      // GOAL-01：仅当意图判定为可执行任务/复杂目标（或用户显式要求执行）时才创建项目。
      // 普通消息、知识问题、低置信度或干预/审批回应不静默立项，仅作为讨论保留。
      const classification =
        !thread && channel.kind === "board" ? classifyMessageIntent(input.body, input.intentOverride) : undefined
      const promoteExisting = Boolean(
        existing
        && input.intentOverride === "execute"
        && classification?.createsProject
        && !existing.root_need_id
        && !existing.source_thread_id,
      )
      if (existing && !promoteExisting) return { type: "accepted", value: acceptedFromMessage(existing, true, channel) }
      const created = (!existing && classification?.createsProject) || promoteExisting
        ? createBoardThread(input, channel, now)
        : undefined
      const activeThread = thread ?? created?.thread
      const rootNeedID = thread?.root_need_id ?? created?.rootNeedID
      const messageID = existing?.id ?? ChannelMessageID.parse(Identifier.ascending("channelMessage"))
      if (existing)
        db.update(ChannelMessageTable)
          .set({
            root_need_id: rootNeedID ?? null,
            source_thread_id: activeThread?.id ?? null,
            time_updated: now,
          })
          .where(eq(ChannelMessageTable.id, existing.id))
          .run()
      if (!existing)
        db.insert(ChannelMessageTable).values({
          id: messageID,
          channel_id: channel.id,
          root_need_id: rootNeedID ?? null,
          source_thread_id: activeThread?.id ?? null,
          reply_to_id: input.replyToID ?? null,
          request_id: input.requestID,
          author_kind: input.principal.kind,
          author_id: input.principal.id,
          body: input.body,
          signal_type: null,
          dri_principal_kind: null,
          dri_principal_id: null,
          visibility: "channel",
          mentions: input.mentions,
          resources: input.resources,
          time_created: now,
          time_updated: now,
        }).run()
      const runID = activeThread && channel.kind === "board" ? ConversationRunID.parse(Identifier.ascending("conversationRun")) : undefined
      if (runID && activeThread) {
        db.insert(ConversationRunTable)
          .values({
            id: runID,
            conversation_thread_id: activeThread.id,
            channel_message_id: messageID,
            state: "queued",
            attempt: 0,
            retryable: false,
            time_started: null,
            time_finished: null,
            time_created: now,
            time_updated: now,
          })
          .run()
      }
      return {
        type: "accepted",
        value: {
          messageID,
          rootNeedID: rootNeedID ?? undefined,
          threadID: activeThread?.id,
          runID,
          replayed: Boolean(existing),
          intent: classification?.kind,
          intentConfidence: classification?.confidence,
          autoProjected: classification ? Boolean(created) : undefined,
          needsIntentConfirmation: classification?.needsConfirmation,
        },
      }
    },
    { behavior: "immediate" },
  )
}

function activeThreadMember(input: { threadID: ConversationThreadID; principal: ConversationPrincipal }) {
  return Database.use((db) =>
    db
      .select({ conversation_thread_id: ConversationThreadMemberTable.conversation_thread_id })
      .from(ConversationThreadMemberTable)
      .where(
        and(
          eq(ConversationThreadMemberTable.conversation_thread_id, input.threadID),
          eq(ConversationThreadMemberTable.principal_kind, input.principal.kind),
          eq(ConversationThreadMemberTable.principal_id, input.principal.id),
          isNull(ConversationThreadMemberTable.time_left),
        ),
      )
      .get(),
  )
}

export function sendMessage(raw: SendMessageInput): Effect.Effect<MessageAccepted, SendMessageError> {
  return Effect.gen(function* () {
    const parsed = SendMessageInput.safeParse(raw)
    if (!parsed.success) return yield* Effect.fail(new MessageInvalidInput({}))

    const result = yield* Effect.sync(() => write(parsed.data))
    if (result.type === "accepted") return result.value
    if (result.type === "company_not_found") return yield* Effect.fail(new CompanyNotFound({ company_id: parsed.data.companyID }))
    if (result.type === "channel_not_visible") {
      return yield* Effect.fail(new ChannelNotVisible({ company_id: parsed.data.companyID, channel_id: parsed.data.channelID }))
    }
    if (result.type === "channel_not_writable") return yield* Effect.fail(new ChannelNotWritable({ channel_id: parsed.data.channelID }))
    if (result.type === "mention_not_visible") return yield* Effect.fail(new MentionNotVisible({ channel_id: parsed.data.channelID }))
    if (result.type === "reply_not_visible") {
      return yield* Effect.fail(new ReplyNotVisible({ channel_id: parsed.data.channelID, message_id: parsed.data.replyToID! }))
    }
    if (result.type === "thread_not_visible") {
      return yield* Effect.fail(new ThreadNotVisible({ company_id: parsed.data.companyID, thread_id: result.threadID }))
    }
    if (result.type === "thread_not_writable") {
      return yield* Effect.fail(new ThreadNotWritable({ thread_id: result.threadID }))
    }
    return yield* Effect.fail(new RequestConflict({ channel_id: parsed.data.channelID, request_id: parsed.data.requestID }))
  })
}
