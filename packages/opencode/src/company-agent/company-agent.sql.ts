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
  ...Timestamps,
})
