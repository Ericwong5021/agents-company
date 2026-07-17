import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export const AuditEventTable = sqliteTable(
  "audit_event",
  {
    id: text().primaryKey(),
    root_need_id: text(),
    kind: text().notNull(),
    action: text().notNull(),
    actor_agent_id: text(),
    target_agent_id: text(),
    subject_id: text(),
    subject_type: text(),
    granted: integer({ mode: "boolean" }),
    metadata: text(),
    ...Timestamps,
  },
  (table) => [
    index("audit_event_root_need_idx").on(table.root_need_id),
    index("audit_event_kind_idx").on(table.kind),
    index("audit_event_actor_idx").on(table.actor_agent_id),
    index("audit_event_target_idx").on(table.target_agent_id),
    index("audit_event_subject_idx").on(table.subject_type, table.subject_id),
  ],
)

export type AuditEventRow = typeof AuditEventTable.$inferSelect
