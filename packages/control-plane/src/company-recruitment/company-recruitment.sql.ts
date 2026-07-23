import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { CompanyProjectTable } from "@/company-project/company-project.sql"
import { CompanyTable } from "@/company/company.sql"
import type { CompanyID } from "@/company/schema"
import { Timestamps } from "@/storage/schema.sql"

export const CompanyCapabilityNeedTable = sqliteTable(
  "company_capability_need",
  {
    id: text().primaryKey(),
    company_id: text()
      .$type<CompanyID>()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    need_key: text().notNull(),
    role: text().notNull(),
    work_type: text().notNull(),
    capability_packs_json: text().notNull(),
    risk_level: text().notNull(),
    demand_horizon: text().notNull(),
    department_key: text(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("company_capability_need_project_key_idx").on(table.project_id, table.need_key),
    index("company_capability_need_company_horizon_idx").on(
      table.company_id,
      table.demand_horizon,
      table.department_key,
    ),
  ],
)

export const CompanyTeamSelectionTable = sqliteTable(
  "company_team_selection",
  {
    id: text().primaryKey(),
    company_id: text()
      .$type<CompanyID>()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    capability_need_id: text()
      .notNull()
      .references(() => CompanyCapabilityNeedTable.id, { onDelete: "cascade" }),
    agent_id: text()
      .notNull()
      .references(() => CompanyAgentTable.id),
    decision: text().notNull(),
    source: text().notNull(),
    lifecycle_at_selection: text().notNull(),
    reason: text().notNull(),
    score_json: text().notNull(),
    time_released: integer(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("company_team_selection_need_agent_idx").on(table.capability_need_id, table.agent_id),
    index("company_team_selection_project_decision_idx").on(table.project_id, table.decision),
    index("company_team_selection_agent_idx").on(table.agent_id, table.time_created),
  ],
)

export const CompanyAgentPerformanceTable = sqliteTable(
  "company_agent_performance",
  {
    id: text().primaryKey(),
    company_id: text()
      .$type<CompanyID>()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    selection_id: text()
      .notNull()
      .references(() => CompanyTeamSelectionTable.id, { onDelete: "cascade" }),
    agent_id: text()
      .notNull()
      .references(() => CompanyAgentTable.id),
    outcome: text().notNull(),
    quality_score: integer().notNull(),
    reliability_score: integer().notNull(),
    cost_score: integer().notNull(),
    speed_score: integer().notNull(),
    review_summary: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("company_agent_performance_selection_idx").on(table.selection_id),
    index("company_agent_performance_agent_idx").on(table.agent_id, table.time_created),
  ],
)

export const CompanyEmploymentReviewTable = sqliteTable(
  "company_employment_review",
  {
    id: text().primaryKey(),
    company_id: text()
      .$type<CompanyID>()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    agent_id: text()
      .notNull()
      .references(() => CompanyAgentTable.id),
    status: text().notNull(),
    selected_project_count: integer().notNull(),
    successful_project_count: integer().notNull(),
    average_quality_score: integer().notNull(),
    average_reliability_score: integer().notNull(),
    recurring_need_count: integer().notNull(),
    rationale: text().notNull(),
    decision_note: text(),
    time_decided: integer(),
    ...Timestamps,
  },
  (table) => [index("company_employment_review_agent_status_idx").on(table.agent_id, table.status, table.time_created)],
)

export const CompanyDepartmentTable = sqliteTable(
  "company_department",
  {
    id: text().primaryKey(),
    company_id: text()
      .$type<CompanyID>()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    department_key: text().notNull(),
    name: text().notNull(),
    purpose: text().notNull(),
    status: text().notNull(),
    recurring_project_count: integer().notNull(),
    evidence_json: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("company_department_company_key_idx").on(table.company_id, table.department_key),
    index("company_department_company_status_idx").on(table.company_id, table.status),
  ],
)
