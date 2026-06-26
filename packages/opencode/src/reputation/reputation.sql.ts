import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export const ReputationTable = sqliteTable(
  "reputation",
  {
    id: text().primaryKey(),
    agentID: text().notNull(),
    score: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [index("reputation_agent_idx").on(table.agentID)],
)

export type ReputationRow = typeof ReputationTable.$inferSelect

export const ReputationHistoryTable = sqliteTable(
  "reputation_history",
  {
    id: text().primaryKey(),
    reputationID: text()
      .notNull()
      .references(() => ReputationTable.id),
    scoreChange: integer().notNull(),
    reason: text().notNull(),
    taskID: text(),
    metadata: text(),
    ...Timestamps,
  },
  (table) => [index("reputation_history_reputation_idx").on(table.reputationID)],
)

export type ReputationHistoryRow = typeof ReputationHistoryTable.$inferSelect
