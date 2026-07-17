import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export const AgentMessageTable = sqliteTable(
  "agent_message",
  {
    id: text().primaryKey(),
    from_agent_id: text().notNull(),
    to_agent_id: text().notNull(),
    thread_id: text(),
    root_need_id: text(),
    in_reply_to: text(),
    kind: text().$type<"fyi" | "request" | "reply" | "proposal">().notNull(),
    depth: integer().notNull().default(0),
    spawned_issue_id: text(),
    body: text().notNull(),
    task_summary: text(),
    outcome: text(),
    read: integer({ mode: "boolean" }).notNull().default(false),
    ...Timestamps,
  },
  (table) => [
    index("agent_message_from_idx").on(table.from_agent_id),
    index("agent_message_to_idx").on(table.to_agent_id),
    index("agent_message_thread_idx").on(table.thread_id),
    index("agent_message_root_need_idx").on(table.root_need_id),
    index("agent_message_kind_idx").on(table.kind),
    index("agent_message_to_read_idx").on(table.to_agent_id, table.read),
    index("agent_message_depth_idx").on(table.depth),
  ],
)

export type AgentMessageRow = typeof AgentMessageTable.$inferSelect
