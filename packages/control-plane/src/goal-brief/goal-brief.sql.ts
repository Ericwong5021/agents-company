import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CompanyProjectTable } from "@/company-project/company-project.sql"

export const GoalBriefTable = sqliteTable(
  "goal_brief",
  {
    id: text().primaryKey(),
    project_id: text().references(() => CompanyProjectTable.id, { onDelete: "set null" }),
    source_thread_id: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("goal_brief_project_idx").on(table.project_id),
    index("goal_brief_source_thread_idx").on(table.source_thread_id),
  ],
)

export const GoalBriefVersionTable = sqliteTable(
  "goal_brief_version",
  {
    brief_id: text()
      .notNull()
      .references(() => GoalBriefTable.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    goal: text().notNull(),
    deliverables_json: text().notNull(),
    acceptance_criteria_json: text().notNull(),
    constraints_json: text().notNull(),
    non_goals_json: text().notNull(),
    assumptions_json: text().notNull(),
    open_questions_json: text().notNull(),
    risk_level: text().notNull(),
    recommended_plan_json: text().notNull(),
    approval_mode: text().notNull(),
    source: text().notNull(),
    source_refs_json: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.brief_id, table.version] }),
    index("goal_brief_version_created_idx").on(table.brief_id, table.created_at),
  ],
)

export const GoalBriefGenerationRequestTable = sqliteTable(
  "goal_brief_generation_request",
  {
    request_id: text().primaryKey(),
    payload_hash: text().notNull(),
    owner_token: text().notNull(),
    lease_expires_at: integer().notNull(),
    brief_id: text().references(() => GoalBriefTable.id, { onDelete: "cascade" }),
    brief_version: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [uniqueIndex("goal_brief_generation_request_brief_idx").on(table.brief_id)],
)

export const GoalBriefStartRequestTable = sqliteTable(
  "goal_brief_start_request",
  {
    request_id: text().primaryKey(),
    brief_id: text()
      .notNull()
      .references(() => GoalBriefTable.id, { onDelete: "cascade" }),
    brief_version: integer().notNull(),
    owner_token: text().notNull(),
    lease_expires_at: integer().notNull(),
    project_id: text().references(() => CompanyProjectTable.id, { onDelete: "set null" }),
    run_id: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("goal_brief_start_request_brief_idx").on(table.brief_id),
    uniqueIndex("goal_brief_start_request_project_idx").on(table.project_id),
  ],
)
