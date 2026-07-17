import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const CompanyProjectTable = sqliteTable(
  "company_project",
  {
    id: text().primaryKey(),
    goal: text().notNull(),
    title: text().notNull(),
    status: text().notNull(),
    owner_agent_id: text(),
    coordinator_session_id: text(),
    provider_id: text(),
    model_id: text(),
    active_run_id: text(),
    output_dir: text().notNull(),
    active_plan_version: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    completed_at: integer(),
  },
  (table) => [
    index("company_project_status_idx").on(table.status),
    index("company_project_owner_idx").on(table.owner_agent_id),
  ],
)

export const CompanyProjectCharterTable = sqliteTable(
  "company_project_charter",
  {
    project_id: text()
      .primaryKey()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    scope_json: text().notNull(),
    success_criteria_json: text().notNull(),
    constraints_json: text().notNull(),
    acceptance_criteria_json: text().notNull(),
    policy_json: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
)

export const CompanyPlanTable = sqliteTable(
  "company_plan",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    phase: text().notNull(),
    status: text().notNull(),
    summary: text().notNull(),
    assumptions_json: text().notNull(),
    acceptance_criteria_json: text().notNull(),
    change_reason: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("company_plan_project_version_idx").on(table.project_id, table.version),
    index("company_plan_project_idx").on(table.project_id),
  ],
)

export const CompanyWorkItemTable = sqliteTable(
  "company_work_item",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    plan_id: text()
      .notNull()
      .references(() => CompanyPlanTable.id, { onDelete: "cascade" }),
    parent_id: text(),
    title: text().notNull(),
    description: text().notNull(),
    kind: text().notNull(),
    status: text().notNull(),
    owner_agent_id: text(),
    acceptance_criteria_json: text().notNull(),
    attempt: integer().notNull().default(0),
    max_attempts: integer().notNull().default(3),
    error: text(),
    started_at: integer(),
    completed_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("company_work_item_project_status_idx").on(table.project_id, table.status),
    index("company_work_item_owner_idx").on(table.owner_agent_id, table.status),
  ],
)

export const CompanyWorkItemDependencyTable = sqliteTable(
  "company_work_item_dependency",
  {
    work_item_id: text()
      .notNull()
      .references(() => CompanyWorkItemTable.id, { onDelete: "cascade" }),
    depends_on_id: text()
      .notNull()
      .references(() => CompanyWorkItemTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.work_item_id, table.depends_on_id] })],
)

export const CompanyWorktreeRunTable = sqliteTable(
  "company_worktree_run",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    work_item_id: text().references(() => CompanyWorkItemTable.id, { onDelete: "set null" }),
    agent_run_id: text(),
    status: text().notNull(),
    repository_path: text().notNull(),
    directory: text().notNull(),
    branch: text().notNull(),
    base_commit: text().notNull(),
    head_commit: text(),
    verification_commands_json: text().notNull(),
    verification_json: text().notNull(),
    review_json: text().notNull(),
    merge_gate_id: text(),
    error: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    merged_at: integer(),
  },
  (table) => [
    index("company_worktree_run_project_idx").on(table.project_id, table.status),
    index("company_worktree_run_work_item_idx").on(table.work_item_id),
  ],
)

export const CompanyArtifactTable = sqliteTable(
  "company_artifact",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    work_item_id: text().references(() => CompanyWorkItemTable.id, { onDelete: "set null" }),
    kind: text().notNull(),
    title: text().notNull(),
    path: text(),
    content: text(),
    evidence_json: text().notNull(),
    created_by_agent_id: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("company_artifact_project_idx").on(table.project_id),
    index("company_artifact_work_item_idx").on(table.work_item_id),
  ],
)

export const CompanyApprovalGateTable = sqliteTable(
  "company_approval_gate",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    status: text().notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    requested_by_agent_id: text(),
    worktree_run_id: text().references(() => CompanyWorktreeRunTable.id, { onDelete: "set null" }),
    decision_note: text(),
    requested_at: integer().notNull(),
    decided_at: integer(),
  },
  (table) => [
    index("company_approval_gate_project_idx").on(table.project_id, table.status),
    index("company_approval_gate_project_kind_status_idx").on(table.project_id, table.kind, table.status),
  ],
)

export const CompanyProjectEventTable = sqliteTable(
  "company_project_event",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    type: text().notNull(),
    actor_id: text(),
    data_json: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [index("company_project_event_project_idx").on(table.project_id, table.created_at)],
)
