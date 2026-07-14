import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CompanyTable } from "../company/company.sql"
import type { CompanyID } from "../company/schema"
import { Timestamps } from "../storage/schema.sql"

export const CompanyAgentTable = sqliteTable(
  "company_agent",
  {
    id: text().primaryKey(),
    company_id: text()
      .$type<CompanyID>()
      .references(() => CompanyTable.id, { onDelete: "set null" }),
    role_key: text(),
    lifecycle: text().notNull().default("employee"),
    name: text().notNull(),
    description: text(),
    system_prompt: text(),
    model: text(),
    color: text(),
    icon: text(),
    org_layer: text(),
    department: text(),
    reports_to: text(),
    responsibilities: text(), // JSON-encoded string[]
    ...Timestamps,
  },
  (table) => [uniqueIndex("company_agent_company_role_idx").on(table.company_id, table.role_key)],
)
