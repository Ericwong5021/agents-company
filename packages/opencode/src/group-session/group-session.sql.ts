import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import { SessionTable } from "../session/session.sql"
import { CompanyAgentTable } from "../company-agent/company-agent.sql"
import { Timestamps } from "../storage/schema.sql"
import type { GroupSessionID } from "./schema"
import type { SessionID } from "../session/schema"
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
    ...Timestamps,
  },
  (table) => [
    index("group_message_group_round_idx").on(table.group_session_id, table.round_num),
  ],
)
