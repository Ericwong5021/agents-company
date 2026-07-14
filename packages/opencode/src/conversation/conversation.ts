import { Context, Effect, Layer } from "effect"
import z from "zod"
import { CompanyTable } from "@/company/company.sql"
import { CompanyID } from "@/company/schema"
import { Identifier } from "@/id/id"
import { and, desc, eq, isNull, lt, or } from "@/storage"
import * as Database from "@/storage/db"
import {
  ChannelMemberTable,
  ChannelMessageTable,
  ChannelTable,
  ConversationThreadMemberTable,
  ConversationThreadTable,
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
  InvalidCursor,
  MessageAuthor,
  MessageVisibility,
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

export const ConversationThreadDetail = z
  .object({
    id: ConversationThreadID,
    channelID: ChannelID,
    rootNeedID: RootNeedID.optional(),
    projectScopeID: z.string().optional(),
    title: z.string(),
    status: ConversationThreadStatus,
    members: z.array(ConversationThreadMember),
    time: z.object({
      created: z.number().int(),
      updated: z.number().int(),
      archived: z.number().int().optional(),
    }),
  })
  .strict()
export type ConversationThreadDetail = z.infer<typeof ConversationThreadDetail>

export const ThreadEntry = z
  .object({
    type: z.literal("message"),
    message: ChannelMessage,
  })
  .strict()
export type ThreadEntry = z.infer<typeof ThreadEntry>

export const ThreadSource = z
  .object({
    projectionID: SignalProjectionID,
    ordinal: z.number().int().nonnegative(),
    kind: SignalProjectionSourceKind,
    sourceID: z.string().min(1),
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
  channelID: ChannelID
  before?: ChannelMessageCursor
  limit: number
}) {
  return Database.use((db) =>
    db
      .select()
      .from(ChannelMessageTable)
      .where(
        input.before
          ? and(
              eq(ChannelMessageTable.channel_id, input.channelID),
              or(
                lt(ChannelMessageTable.time_created, input.before.time_created),
                and(
                  eq(ChannelMessageTable.time_created, input.before.time_created),
                  lt(ChannelMessageTable.id, input.before.id),
                ),
              ),
            )
          : eq(ChannelMessageTable.channel_id, input.channelID),
      )
      .orderBy(desc(ChannelMessageTable.time_created), desc(ChannelMessageTable.id))
      .limit(input.limit + 1)
      .all(),
  )
}

function readThreadMessages(input: {
  threadID: ConversationThreadID
  channelID: ChannelID
  before?: ChannelMessageCursor
  limit: number
}) {
  return Database.use((db) =>
    db
      .select()
      .from(ChannelMessageTable)
      .where(
        input.before
          ? and(
              eq(ChannelMessageTable.channel_id, input.channelID),
              eq(ChannelMessageTable.source_thread_id, input.threadID),
              or(
                lt(ChannelMessageTable.time_created, input.before.time_created),
                and(
                  eq(ChannelMessageTable.time_created, input.before.time_created),
                  lt(ChannelMessageTable.id, input.before.id),
                ),
              ),
            )
          : and(
              eq(ChannelMessageTable.channel_id, input.channelID),
              eq(ChannelMessageTable.source_thread_id, input.threadID),
            ),
      )
      .orderBy(desc(ChannelMessageTable.time_created), desc(ChannelMessageTable.id))
      .limit(input.limit + 1)
      .all(),
  )
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
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Conversation") {}

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
      const rows = yield* Effect.sync(() => readChannelMessages({ channelID: channel.id, before, limit }))
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
      return {
        id: thread.id,
        channelID: thread.channel_id,
        rootNeedID: thread.root_need_id ?? undefined,
        projectScopeID: thread.project_scope_id ?? undefined,
        title: thread.title,
        status: thread.status,
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
      const before = yield* decodeCursor(input.before)
      const limit = input.limit ?? 50
      const rows = yield* Effect.sync(() =>
        readThreadMessages({ threadID: thread.id, channelID: thread.channel_id, before, limit }),
      )
      const items = rows.slice(0, limit)
      const tail = items.at(-1)
      return {
        items: items.map((row) => ({ type: "message" as const, message: messageFromRow(row) })),
        nextCursor: rows.length > limit && tail ? encodeCursor(tail) : undefined,
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
      return {
        projectionID: source.projection_id,
        ordinal: source.ordinal,
        kind: source.source_kind,
        sourceID: source.source_id,
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
    })
  }),
)

export const defaultLayer = layer

export * as Conversation from "./conversation"
