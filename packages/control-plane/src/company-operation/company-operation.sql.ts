import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { CompanyTable } from "@/company/company.sql"
import type { CompanyID } from "@/company/schema"

export const CompanyOperationTable = sqliteTable(
  "company_operation_log",
  {
    id: text().primaryKey(),
    company_id: text()
      .$type<CompanyID>()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    category: text().notNull(),
    severity: text().notNull(),
    importance: text().notNull(),
    event_type: text().notNull(),
    source_kind: text().notNull(),
    source_id: text().notNull(),
    root_need_id: text(),
    project_id: text(),
    thread_id: text(),
    agent_id: text(),
    run_id: text(),
    work_item_id: text(),
    occurred_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("company_operation_source_idx").on(table.company_id, table.source_kind, table.source_id),
    index("company_operation_company_time_idx").on(table.company_id, table.occurred_at, table.id),
    index("company_operation_company_category_time_idx").on(table.company_id, table.category, table.occurred_at),
    index("company_operation_company_severity_time_idx").on(table.company_id, table.severity, table.occurred_at),
    index("company_operation_company_importance_time_idx").on(table.company_id, table.importance, table.occurred_at),
    index("company_operation_company_project_time_idx").on(table.company_id, table.project_id, table.occurred_at),
    index("company_operation_company_agent_time_idx").on(table.company_id, table.agent_id, table.occurred_at),
    check(
      "company_operation_category_check",
      sql`${table.category} IN ('governance', 'work', 'runtime', 'quality', 'delivery', 'organization', 'system')`,
    ),
    check("company_operation_severity_check", sql`${table.severity} IN ('info', 'warning', 'error')`),
    check("company_operation_importance_check", sql`${table.importance} IN ('primary', 'normal', 'diagnostic')`),
  ],
)
