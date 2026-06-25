import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import type { SessionID } from "../session/schema"

export const ThreadTable = sqliteTable(
  "thread",
  {
    id: text().primaryKey(),
    agent_id: text().notNull(),
    kind: text().$type<"primary" | "reactive" | "ambient">().notNull(),
    status: text().$type<"active" | "paused" | "completed">().notNull(),
    session_id: text().$type<SessionID>(),
    description: text(),
    budget_tokens: integer(),
    spent_tokens: integer().default(0),
    time_started: integer(),
    time_completed: integer(),
    ...Timestamps,
  },
  (table) => [
    index("thread_agent_idx").on(table.agent_id),
    index("thread_agent_kind_idx").on(table.agent_id, table.kind),
    index("thread_status_idx").on(table.status),
  ],
)
