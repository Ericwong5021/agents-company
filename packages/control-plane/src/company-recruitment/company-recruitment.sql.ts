import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import {
  CompanyProjectTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "@/company-project/company-project.sql"
import { CompanyTable } from "@/company/company.sql"
import type { CompanyID } from "@/company/schema"
import { Timestamps } from "@/storage/schema.sql"

export const CompanyCapabilityNeedTable = sqliteTable(
  "company_capability_need",
  {
    id: text().primaryKey(),
    company_id: text()
      .$type<CompanyID>()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    need_key: text().notNull(),
    work_item_id: text().references(() => CompanyWorkItemTable.id, { onDelete: "cascade" }),
    source_receipt_id: text().references(() => CompanyWorkReceiptTable.id, { onDelete: "set null" }),
    role: text().notNull(),
    work_type: text().notNull(),
    capability_packs_json: text().notNull(),
    risk_level: text().notNull(),
    demand_horizon: text().notNull(),
    department_key: text(),
    required_runtime_capabilities_json: text().notNull().default("[]"),
    required_tools_json: text().notNull().default("[]"),
    allowed_permission_modes_json: text().notNull().default('["read_only","workspace_write"]'),
    workspace_scopes_json: text().notNull().default("[]"),
    independent_from_agent_ids_json: text().notNull().default("[]"),
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
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    capability_need_id: text()
      .notNull()
      .references(() => CompanyCapabilityNeedTable.id, { onDelete: "cascade" }),
    selection_round: integer().notNull().default(1),
    agent_id: text()
      .notNull()
      .references(() => CompanyAgentTable.id),
    decision: text().notNull(),
    source: text().notNull(),
    lifecycle_at_selection: text().notNull(),
    reason: text().notNull(),
    score_json: text().notNull(),
    constraint_results_json: text().notNull().default("[]"),
    time_released: integer(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("company_team_selection_need_round_agent_idx").on(
      table.capability_need_id,
      table.selection_round,
      table.agent_id,
    ),
    uniqueIndex("company_team_selection_current_selected_idx")
      .on(table.capability_need_id)
      .where(sql`${table.decision} = 'selected' and ${table.time_released} is null`),
    index("company_team_selection_project_decision_idx").on(table.project_id, table.decision),
    index("company_team_selection_agent_idx").on(table.agent_id, table.time_created),
  ],
)

export const CompanyProjectAssignmentTable = sqliteTable(
  "company_project_assignment",
  {
    id: text().primaryKey(),
    company_id: text()
      .$type<CompanyID>()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    work_item_id: text()
      .notNull()
      .references(() => CompanyWorkItemTable.id, { onDelete: "cascade" }),
    capability_need_id: text()
      .notNull()
      .references(() => CompanyCapabilityNeedTable.id, { onDelete: "cascade" }),
    selection_id: text()
      .notNull()
      .references(() => CompanyTeamSelectionTable.id),
    agent_id: text()
      .notNull()
      .references(() => CompanyAgentTable.id),
    version: integer().notNull(),
    idempotency_key: text().notNull(),
    supersedes_assignment_id: text(),
    temporary_role: text().notNull(),
    responsibility: text().notNull(),
    decision_scope_json: text().notNull(),
    resource_scope_json: text().notNull(),
    permission_mode: text().notNull(),
    source_receipt_id: text().references(() => CompanyWorkReceiptTable.id, { onDelete: "set null" }),
    status: text().notNull(),
    assigned_at: integer().notNull(),
    started_at: integer(),
    released_at: integer(),
    release_reason: text(),
  },
  (table) => [
    uniqueIndex("company_project_assignment_current_work_item_idx")
      .on(table.work_item_id)
      .where(sql`${table.status} in ('assigned', 'active')`),
    index("company_project_assignment_project_status_idx").on(table.project_id, table.status),
    index("company_project_assignment_agent_status_idx").on(table.agent_id, table.status),
    uniqueIndex("company_project_assignment_work_item_version_idx").on(table.work_item_id, table.version),
    uniqueIndex("company_project_assignment_project_idempotency_idx").on(table.project_id, table.idempotency_key),
    uniqueIndex("company_project_assignment_selection_idx").on(table.selection_id),
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
