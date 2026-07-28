import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const CompanyProjectTable = sqliteTable(
  "company_project",
  {
    id: text().primaryKey(),
    company_id: text(),
    root_need_id: text(),
    source_thread_id: text(),
    decision_request_id: text(),
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
    uniqueIndex("company_project_source_thread_idx").on(table.source_thread_id),
  ],
)

export const CompanyProjectCharterTable = sqliteTable("company_project_charter", {
  project_id: text()
    .primaryKey()
    .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
  title: text().notNull(),
  value: text().notNull(),
  deliverables_json: text().notNull(),
  scope_json: text().notNull(),
  non_goals_json: text().notNull(),
  success_criteria_json: text().notNull(),
  constraints_json: text().notNull(),
  resources_json: text().notNull(),
  risks_json: text().notNull(),
  dri_agent_id: text().notNull(),
  milestones_json: text().notNull(),
  open_decisions_json: text().notNull(),
  acceptance_criteria_json: text().notNull(),
  policy_json: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
})

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
    source_task_key: text(),
    parent_id: text(),
    title: text().notNull(),
    description: text().notNull(),
    kind: text().notNull(),
    work_type: text().notNull(),
    role: text().notNull(),
    capability_packs_json: text().notNull(),
    decision_scope_json: text().notNull(),
    resource_scope_json: text().notNull(),
    inputs_json: text().notNull(),
    expected_outputs_json: text().notNull(),
    validators_json: text().notNull(),
    disposition: text().notNull(),
    model_group: text().notNull(),
    risk_level: text().notNull(),
    review_status: text().notNull(),
    status: text().notNull(),
    owner_agent_id: text(),
    workflow_run_id: text(),
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
    uniqueIndex("company_work_item_source_task_key_idx").on(
      table.project_id,
      table.plan_id,
      table.source_task_key,
      table.kind,
    ),
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

export const CompanyWorkAttemptTable = sqliteTable(
  "company_work_attempt",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    work_item_id: text()
      .notNull()
      .references(() => CompanyWorkItemTable.id, { onDelete: "cascade" }),
    agent_run_id: text(),
    ordinal: integer().notNull(),
    status: text().notNull(),
    failure_kind: text(),
    safe_summary: text(),
    started_at: integer().notNull(),
    finished_at: integer(),
  },
  (table) => [
    uniqueIndex("company_work_attempt_item_ordinal_idx").on(table.work_item_id, table.ordinal),
    uniqueIndex("company_work_attempt_agent_run_idx").on(table.agent_run_id),
    index("company_work_attempt_project_status_idx").on(table.project_id, table.status),
  ],
)

export const CompanyWorkReceiptTable = sqliteTable(
  "company_work_receipt",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    work_item_id: text()
      .notNull()
      .references(() => CompanyWorkItemTable.id, { onDelete: "cascade" }),
    attempt_id: text()
      .notNull()
      .references(() => CompanyWorkAttemptTable.id, { onDelete: "cascade" }),
    idempotency_key: text().notNull(),
    outcome: text().notNull(),
    summary: text().notNull(),
    artifact_ids_json: text().notNull(),
    evidence_refs_json: text().notNull(),
    confirmed_facts_json: text().notNull(),
    invalidated_assumptions_json: text().notNull(),
    unknowns_json: text().notNull(),
    blockers_json: text().notNull(),
    capability_gaps_json: text().notNull(),
    task_proposals_json: text().notNull(),
    dependency_proposals_json: text().notNull(),
    questions_json: text().notNull(),
    processing_status: text().notNull(),
    processed_mutation_id: text(),
    created_at: integer().notNull(),
    processed_at: integer(),
  },
  (table) => [
    uniqueIndex("company_work_receipt_attempt_idx").on(table.attempt_id),
    uniqueIndex("company_work_receipt_idempotency_idx").on(table.idempotency_key),
    index("company_work_receipt_project_status_idx").on(table.project_id, table.processing_status),
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
