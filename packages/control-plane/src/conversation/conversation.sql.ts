import { sql } from "drizzle-orm"
import { type AnySQLiteColumn, check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CompanyTable } from "@/company/company.sql"
import type { CompanyID } from "@/company/schema"
import * as Database from "@/storage/db"
import { Timestamps } from "@/storage/schema.sql"
import type {
  ChannelID,
  ChannelKind,
  ChannelMemberRole,
  ChannelMessageID,
  ConversationMention,
  ChannelMessageKind,
  ChannelPoll,
  ConversationResource,
  ConversationRunID,
  ConversationRunState,
  ConversationThreadID,
  ConversationThreadStatus,
  MessageVisibility,
  RootNeedID,
  RootNeedStatus,
  SignalProjectionID,
  SignalProjectionSourceKind,
  SignalType,
} from "./schema"
import { ChannelID as ChannelIDSchema } from "./schema"

export const COMPANY_CHANNEL_ID = ChannelIDSchema.parse("chn_company")
export const BOARD_CHANNEL_ID = ChannelIDSchema.parse("chn_board")
export const LOCAL_USER_ID = "usr_local"

export const ChannelTable = sqliteTable(
  "channel",
  {
    id: text().$type<ChannelID>().primaryKey(),
    company_id: text()
      .$type<CompanyID>()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    kind: text().$type<ChannelKind>().notNull(),
    scope_id: text(),
    title: text().notNull(),
    retention_days: integer().notNull().default(0),
    ...Timestamps,
    time_archived: integer(),
  },
  (table) => [
    check("channel_kind_check", sql.raw("kind in ('company', 'board', 'department', 'project', 'direct')")),
    check("channel_project_scope_check", sql.raw("kind != 'project' or scope_id is not null")),
    check("channel_retention_days_check", sql.raw("retention_days >= 0")),
    uniqueIndex("channel_company_singleton_idx")
      .on(table.company_id, table.kind)
      .where(sql.raw("kind in ('company', 'board')")),
    uniqueIndex("channel_project_scope_idx").on(table.company_id, table.scope_id).where(sql.raw("kind = 'project'")),
    index("channel_company_idx").on(table.company_id, table.time_created),
  ],
)

export const ChannelMemberTable = sqliteTable(
  "channel_member",
  {
    channel_id: text()
      .$type<ChannelID>()
      .notNull()
      .references(() => ChannelTable.id, { onDelete: "cascade" }),
    principal_kind: text().$type<"user" | "agent">().notNull(),
    principal_id: text().notNull(),
    role: text().$type<ChannelMemberRole>().notNull().default("member"),
    time_joined: integer().notNull(),
    time_left: integer(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.channel_id, table.principal_kind, table.principal_id] }),
    check("channel_member_principal_kind_check", sql.raw("principal_kind in ('user', 'agent')")),
    check("channel_member_role_check", sql.raw("role in ('member', 'owner')")),
    index("channel_member_principal_idx").on(table.principal_kind, table.principal_id, table.channel_id),
  ],
)

export const RootNeedTable = sqliteTable(
  "root_need",
  {
    id: text().$type<RootNeedID>().primaryKey(),
    company_id: text()
      .$type<CompanyID>()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    channel_id: text()
      .$type<ChannelID>()
      .notNull()
      .references(() => ChannelTable.id, { onDelete: "cascade" }),
    body: text().notNull(),
    status: text().$type<RootNeedStatus>().notNull().default("open"),
    time_resolved: integer(),
    ...Timestamps,
  },
  (table) => [
    check("root_need_status_check", sql.raw("status in ('open', 'in_progress', 'resolved', 'cancelled')")),
    index("root_need_company_status_idx").on(table.company_id, table.status, table.time_created),
    index("root_need_channel_idx").on(table.channel_id, table.time_created),
  ],
)

export const ConversationThreadTable = sqliteTable(
  "conversation_thread",
  {
    id: text().$type<ConversationThreadID>().primaryKey(),
    company_id: text()
      .$type<CompanyID>()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    channel_id: text()
      .$type<ChannelID>()
      .notNull()
      .references(() => ChannelTable.id, { onDelete: "cascade" }),
    root_need_id: text()
      .$type<RootNeedID>()
      .references(() => RootNeedTable.id, { onDelete: "set null" }),
    project_scope_id: text(),
    title: text().notNull(),
    status: text().$type<ConversationThreadStatus>().notNull().default("active"),
    time_archived: integer(),
    ...Timestamps,
  },
  (table) => [
    check("conversation_thread_status_check", sql.raw("status in ('active', 'completed', 'interrupted')")),
    uniqueIndex("conversation_thread_root_need_idx").on(table.root_need_id),
    index("conversation_thread_channel_updated_idx").on(table.channel_id, table.time_updated, table.id),
    index("conversation_thread_project_scope_idx").on(table.company_id, table.project_scope_id),
  ],
)

export const ConversationThreadMemberTable = sqliteTable(
  "conversation_thread_member",
  {
    conversation_thread_id: text()
      .$type<ConversationThreadID>()
      .notNull()
      .references(() => ConversationThreadTable.id, { onDelete: "cascade" }),
    principal_kind: text().$type<"user" | "agent">().notNull(),
    principal_id: text().notNull(),
    time_joined: integer().notNull(),
    time_left: integer(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.conversation_thread_id, table.principal_kind, table.principal_id] }),
    check("conversation_thread_member_principal_kind_check", sql.raw("principal_kind in ('user', 'agent')")),
    index("conversation_thread_member_principal_idx").on(
      table.principal_kind,
      table.principal_id,
      table.conversation_thread_id,
    ),
  ],
)

export const ChannelMessageTable = sqliteTable(
  "channel_message",
  {
    id: text().$type<ChannelMessageID>().primaryKey(),
    channel_id: text()
      .$type<ChannelID>()
      .notNull()
      .references(() => ChannelTable.id, { onDelete: "cascade" }),
    root_need_id: text()
      .$type<RootNeedID>()
      .references(() => RootNeedTable.id, { onDelete: "set null" }),
    source_thread_id: text()
      .$type<ConversationThreadID>()
      .references(() => ConversationThreadTable.id, { onDelete: "set null" }),
    reply_to_id: text()
      .$type<ChannelMessageID>()
      .references((): AnySQLiteColumn => ChannelMessageTable.id, { onDelete: "set null" }),
    request_id: text(),
    sequence: integer().notNull().default(0),
    kind: text().$type<ChannelMessageKind>().notNull().default("text"),
    poll: text({ mode: "json" }).$type<ChannelPoll>(),
    author_kind: text().$type<"user" | "agent" | "system">().notNull(),
    author_id: text().notNull(),
    body: text().notNull(),
    signal_type: text().$type<SignalType>(),
    dri_principal_kind: text().$type<"user" | "agent">(),
    dri_principal_id: text(),
    visibility: text().$type<MessageVisibility>().notNull().default("channel"),
    mentions: text({ mode: "json" }).$type<ConversationMention[]>().notNull(),
    resources: text({ mode: "json" }).$type<ConversationResource[]>().notNull().default(sql`'[]'`),
    ...Timestamps,
  },
  (table) => [
    check("channel_message_author_kind_check", sql.raw("author_kind in ('user', 'agent', 'system')")),
    check("channel_message_kind_check", sql.raw("kind in ('text', 'poll', 'system')")),
    check("channel_message_signal_type_check", sql.raw("signal_type is null or signal_type in ('conclusion', 'decision', 'plan', 'status', 'risk', 'approval', 'delivery', 'intervention')")),
    check("channel_message_dri_pair_check", sql.raw("(dri_principal_kind is null) = (dri_principal_id is null)")),
    check("channel_message_decision_dri_check", sql.raw("signal_type != 'decision' or dri_principal_id is not null")),
    check("channel_message_visibility_check", sql.raw("visibility in ('channel', 'company')")),
    uniqueIndex("channel_message_request_idx").on(table.channel_id, table.request_id),
    uniqueIndex("channel_message_channel_sequence_idx").on(table.channel_id, table.sequence),
    index("channel_message_channel_time_created_id_idx").on(table.channel_id, table.time_created, table.id),
    index("channel_message_source_thread_idx").on(table.source_thread_id, table.time_created, table.id),
    index("channel_message_root_need_idx").on(table.root_need_id, table.time_created),
  ],
)

export const ConversationRunTable = sqliteTable(
  "conversation_run",
  {
    id: text().$type<ConversationRunID>().primaryKey(),
    conversation_thread_id: text()
      .$type<ConversationThreadID>()
      .notNull()
      .references(() => ConversationThreadTable.id, { onDelete: "cascade" }),
    channel_message_id: text()
      .$type<ChannelMessageID>()
      .notNull()
      .references(() => ChannelMessageTable.id, { onDelete: "cascade" }),
    state: text().$type<ConversationRunState>().notNull().default("queued"),
    attempt: integer().notNull().default(0),
    runtime_id: text(),
    runtime_round_num: integer(),
    source_watermark: text(),
    safe_error_summary: text(),
    retryable: integer({ mode: "boolean" }).notNull().default(false),
    time_started: integer(),
    time_finished: integer(),
    ...Timestamps,
  },
  (table) => [
    check(
      "conversation_run_state_check",
      sql.raw("state in ('queued', 'running', 'projecting', 'completed', 'failed', 'interrupted')"),
    ),
    uniqueIndex("conversation_run_channel_message_idx").on(table.channel_message_id),
    index("conversation_run_thread_state_idx").on(table.conversation_thread_id, table.state, table.time_updated),
    index("conversation_run_runtime_idx").on(table.runtime_id),
  ],
)

export const SignalProjectionTable = sqliteTable(
  "signal_projection",
  {
    id: text().$type<SignalProjectionID>().primaryKey(),
    channel_message_id: text()
      .$type<ChannelMessageID>()
      .notNull()
      .references(() => ChannelMessageTable.id, { onDelete: "cascade" }),
    conversation_thread_id: text()
      .$type<ConversationThreadID>()
      .notNull()
      .references(() => ConversationThreadTable.id, { onDelete: "cascade" }),
    conversation_run_id: text()
      .$type<ConversationRunID>()
      .references(() => ConversationRunTable.id, { onDelete: "set null" }),
    projector_version: integer().notNull(),
    source_watermark: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("signal_projection_channel_message_idx").on(table.channel_message_id),
    uniqueIndex("signal_projection_thread_version_watermark_idx").on(
      table.conversation_thread_id,
      table.projector_version,
      table.source_watermark,
    ),
    index("signal_projection_run_idx").on(table.conversation_run_id),
  ],
)

export const SignalProjectionSourceTable = sqliteTable(
  "signal_projection_source",
  {
    signal_projection_id: text()
      .$type<SignalProjectionID>()
      .notNull()
      .references(() => SignalProjectionTable.id, { onDelete: "cascade" }),
    ordinal: integer().notNull(),
    source_kind: text().$type<SignalProjectionSourceKind>().notNull(),
    source_id: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.signal_projection_id, table.ordinal] }),
    check(
      "signal_projection_source_kind_check",
      sql.raw("source_kind in ('group_message', 'message', 'part', 'agent_message', 'decision', 'artifact', 'gate')"),
    ),
    uniqueIndex("signal_projection_source_unique_idx").on(table.signal_projection_id, table.source_kind, table.source_id),
  ],
)

export function ensureCompanyChannels(
  input: {
    companyID: CompanyID
    boardAgentIDs: readonly string[]
    now: number
  },
) {
  Database.use((db) => {
    db.insert(ChannelTable)
      .values([
        {
          id: COMPANY_CHANNEL_ID,
          company_id: input.companyID,
          kind: "company",
          title: "Company",
          retention_days: 0,
          time_created: input.now,
          time_updated: input.now,
        },
        {
          id: BOARD_CHANNEL_ID,
          company_id: input.companyID,
          kind: "board",
          title: "Board",
          retention_days: 0,
          time_created: input.now,
          time_updated: input.now,
        },
      ])
      .onConflictDoNothing()
      .run()

    db.insert(ChannelMemberTable)
      .values([
        {
          channel_id: COMPANY_CHANNEL_ID,
          principal_kind: "user" as const,
          principal_id: LOCAL_USER_ID,
          role: "owner" as const,
          time_joined: input.now,
          time_created: input.now,
          time_updated: input.now,
        },
        {
          channel_id: BOARD_CHANNEL_ID,
          principal_kind: "user" as const,
          principal_id: LOCAL_USER_ID,
          role: "owner" as const,
          time_joined: input.now,
          time_created: input.now,
          time_updated: input.now,
        },
        ...input.boardAgentIDs.flatMap((agentID) => [
          {
            channel_id: COMPANY_CHANNEL_ID,
            principal_kind: "agent" as const,
            principal_id: agentID,
            role: "member" as const,
            time_joined: input.now,
            time_created: input.now,
            time_updated: input.now,
          },
          {
            channel_id: BOARD_CHANNEL_ID,
            principal_kind: "agent" as const,
            principal_id: agentID,
            role: "member" as const,
            time_joined: input.now,
            time_created: input.now,
            time_updated: input.now,
          },
        ]),
      ])
      .onConflictDoNothing()
      .run()
  })
}
