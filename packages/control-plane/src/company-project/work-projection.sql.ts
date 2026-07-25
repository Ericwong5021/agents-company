import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { CompanyProjectTable } from "./company-project.sql"

export const CompanyWorkProjectionTable = sqliteTable("company_work_projection", {
  project_id: text()
    .primaryKey()
    .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
  projector_version: integer().notNull(),
  source_watermark: text().notNull(),
  projection_json: text().notNull(),
  updated_at: integer().notNull(),
})
