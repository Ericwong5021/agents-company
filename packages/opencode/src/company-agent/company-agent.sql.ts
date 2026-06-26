import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export const CompanyAgentTable = sqliteTable("company_agent", {
  id: text().primaryKey(),
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
})
