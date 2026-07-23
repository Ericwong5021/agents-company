import { sqliteTable, text, integer, index, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import { ChannelMessageTable } from "../conversation/conversation.sql"
import { MessageTable, SessionTable } from "../session/session.sql"
import { CompanyAgentTable } from "../company-agent/company-agent.sql"
import { AgentRunTable } from "../agent-run/agent-run.sql"
import { Timestamps } from "../storage/schema.sql"
import type { ChannelMessageID } from "../conversation/schema"
import type { GroupContextPolicy, GroupSessionID } from "./schema"
import type { MessageID, SessionID } from "../session/schema"
import type { ProjectID } from "../project/schema"
import type { CompanyAgentID } from "../company-agent/schema"

export const GroupSessionTable = sqliteTable(
  "group_session",
  {
    id: text().$type<GroupSessionID>().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    context_policy: text().$type<GroupContextPolicy>(),
    ...Timestamps,
    time_archived: integer(),
  },
  (table) => [
    index("group_session_project_idx").on(table.project_id),
  ],
)

export const GroupSessionMemberTable = sqliteTable(
  "group_session_member",
  {
    group_session_id: text()
      .$type<GroupSessionID>()
      .notNull()
      .references(() => GroupSessionTable.id, { onDelete: "cascade" }),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    company_agent_id: text()
      .$type<CompanyAgentID>()
      .notNull()
      .references(() => CompanyAgentTable.id),
    position: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.group_session_id, table.session_id] }),
    index("group_session_member_group_idx").on(table.group_session_id),
    index("group_session_member_session_idx").on(table.session_id),
  ],
)

// Stores the group-level visible conversation: user messages + per-agent
// visible responses (chat text + status summary). Used for context injection
// into each agent's prompt on subsequent rounds.
export const GroupMessageTable = sqliteTable(
  "group_message",
  {
    id: text().primaryKey(),
    group_session_id: text()
      .$type<GroupSessionID>()
      .notNull()
      .references(() => GroupSessionTable.id, { onDelete: "cascade" }),
    round_num: integer().notNull(),
    role: text().$type<"user" | "agent">().notNull(),
    // null for user messages
    company_agent_id: text().$type<CompanyAgentID>(),
    // null for user messages
    session_id: text().$type<SessionID>(),
    content: text().notNull(),
    // e.g. "done", "thinking", "tool_calling", "error", "cancelled"
    status_summary: text(),
    external_message_id: text()
      .$type<ChannelMessageID>()
      .references(() => ChannelMessageTable.id, { onDelete: "set null" }),
    runtime_message_id: text()
      .$type<MessageID>()
      .references(() => MessageTable.id, { onDelete: "set null" }),
    agent_run_id: text().references(() => AgentRunTable.id, { onDelete: "set null" }),
    ...Timestamps,
  },
  (table) => [
    index("group_message_group_round_idx").on(table.group_session_id, table.round_num),
    uniqueIndex("group_message_group_external_message_idx").on(table.group_session_id, table.external_message_id),
    uniqueIndex("group_message_runtime_message_idx").on(table.runtime_message_id),
    uniqueIndex("group_message_agent_run_idx").on(table.agent_run_id),
  ],
)

// Stores the auditable outcome of each speaking round. The brief bid reason is
// intentionally separate from private model reasoning, so it can be shown in
// the conversation as a transparent coordination record.
export const GroupSessionBiddingTable = sqliteTable(
  "group_session_bidding",
  {
    id: text().primaryKey(),
    group_session_id: text()
      .$type<GroupSessionID>()
      .notNull()
      .references(() => GroupSessionTable.id, { onDelete: "cascade" }),
    round_num: integer().notNull(),
    state: text().$type<"bidding" | "decided">().notNull().default("bidding"),
    winner_agent_id: text(),
    bids_json: text({ mode: "json" }).$type<unknown>().notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("group_session_bidding_group_round_idx").on(table.group_session_id, table.round_num),
    index("group_session_bidding_group_created_idx").on(table.group_session_id, table.time_created),
  ],
)
