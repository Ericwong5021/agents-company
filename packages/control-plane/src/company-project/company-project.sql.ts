import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

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
    execution_strategy: text().notNull().default("legacy_full_plan"),
    seed_mode: text(),
    orchestration_state: text().notNull().default("idle"),
    orchestrator_version: integer().notNull().default(1),
    dispatch_paused: integer({ mode: "boolean" }).notNull().default(false),
    graph_revision: integer().notNull().default(0),
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
    purpose: text().notNull().default("delivery"),
    origin_kind: text().notNull().default("legacy"),
    origin_ref_id: text(),
    graph_revision_created: integer().notNull().default(0),
    validation_mode: text().notNull().default("self_check"),
    superseded_by_id: text(),
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
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    company_id: text(),
    scope_type: text().notNull().default("project"),
    private_owner_id: text(),
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
    index("company_artifact_company_scope_idx").on(table.company_id, table.scope_type),
    index("company_artifact_private_owner_idx").on(table.private_owner_id),
    index("company_artifact_work_item_idx").on(table.work_item_id),
    check(
      "company_artifact_scope_check",
      sql.raw(`(
        scope_type = 'project' AND project_id IS NOT NULL AND private_owner_id IS NULL
      ) OR (
        scope_type = 'company' AND company_id IS NOT NULL AND project_id IS NULL AND private_owner_id IS NULL
      ) OR (
        scope_type = 'private' AND company_id IS NOT NULL AND project_id IS NULL AND private_owner_id IS NOT NULL
      )`),
    ),
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
    payload_kind: text(),
    typed_payload_json: text(),
    processing_status: text().notNull(),
    processing_claim_id: text(),
    claimed_at: integer(),
    processed_decision_id: text(),
    processed_mutation_id: text(),
    created_at: integer().notNull(),
    processed_at: integer(),
  },
  (table) => [
    uniqueIndex("company_work_receipt_attempt_idx").on(table.attempt_id),
    uniqueIndex("company_work_receipt_idempotency_idx").on(table.idempotency_key),
    index("company_work_receipt_project_status_idx").on(table.project_id, table.processing_status),
    uniqueIndex("company_work_receipt_project_processing_idx")
      .on(table.project_id)
      .where(sql.raw("processing_status = 'processing'")),
  ],
)

export const CompanyOutcomeSignalTable = sqliteTable(
  "company_outcome_signal",
  {
    id: text().primaryKey(),
    schema_version: integer().notNull(),
    company_id: text(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    decision_id: text(),
    idempotency_key: text().notNull(),
    result: text().notNull(),
    summary: text().notNull(),
    validator_kind: text().notNull(),
    validator_id: text().notNull(),
    validator_result_kind: text().notNull(),
    validator_result_id: text().notNull(),
    work_receipt_id: text().references(() => CompanyWorkReceiptTable.id, { onDelete: "restrict" }),
    metric_contract_kind: text().notNull(),
    metric_contract_id: text().notNull(),
    metric_contract_version: integer().notNull(),
    observation_window_starts_at: integer().notNull(),
    observation_window_ends_at: integer().notNull(),
    source_refs_json: text().notNull(),
    observed_at: integer().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("company_outcome_signal_project_idempotency_idx").on(table.project_id, table.idempotency_key),
    index("company_outcome_signal_project_created_idx").on(table.project_id, table.created_at),
    index("company_outcome_signal_decision_idx").on(table.decision_id),
  ],
)

export const CompanyOutcomeSignalTransitionTable = sqliteTable(
  "company_outcome_signal_transition",
  {
    id: text().primaryKey(),
    outcome_signal_id: text().notNull().references(() => CompanyOutcomeSignalTable.id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    idempotency_key: text().notNull(),
    from_status: text(),
    to_status: text().notNull(),
    reason: text().notNull(),
    actor_kind: text().notNull(),
    actor_id: text(),
    validator_result_kind: text(),
    validator_result_id: text(),
    occurred_at: integer().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("company_outcome_signal_transition_sequence_idx").on(table.outcome_signal_id, table.sequence),
    uniqueIndex("company_outcome_signal_transition_idempotency_idx").on(table.outcome_signal_id, table.idempotency_key),
  ],
)

export const CompanyOutcomeSignalCurrentTable = sqliteTable(
  "company_outcome_signal_current",
  {
    outcome_signal_id: text().primaryKey().references(() => CompanyOutcomeSignalTable.id, { onDelete: "cascade" }),
    current_status: text().notNull(),
    latest_transition_id: text().notNull().references(() => CompanyOutcomeSignalTransitionTable.id, { onDelete: "restrict" }),
    transition_count: integer().notNull(),
    validated_at: integer(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("company_outcome_signal_current_status_idx").on(table.current_status, table.updated_at),
  ],
)

export const CompanyGraphMutationTable = sqliteTable(
  "company_graph_mutation",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    trigger_receipt_id: text()
      .notNull()
      .references(() => CompanyWorkReceiptTable.id, { onDelete: "cascade" }),
    expected_revision: integer().notNull(),
    applied_revision: integer(),
    orchestrator_version: integer().notNull(),
    idempotency_key: text().notNull(),
    decision: text().notNull(),
    rationale: text().notNull(),
    evidence_refs_json: text().notNull(),
    operations_json: text().notNull(),
    status: text().notNull(),
    policy_verdict_json: text().notNull(),
    created_at: integer().notNull(),
    applied_at: integer(),
  },
  (table) => [
    uniqueIndex("company_graph_mutation_project_idempotency_idx").on(table.project_id, table.idempotency_key),
    index("company_graph_mutation_receipt_idx").on(table.trigger_receipt_id),
    index("company_graph_mutation_project_status_idx").on(table.project_id, table.status),
  ],
)

export const CompanyGraphDecisionTable = sqliteTable(
  "company_graph_decision",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    receipt_id: text()
      .notNull()
      .references(() => CompanyWorkReceiptTable.id, { onDelete: "cascade" }),
    mutation_id: text().references(() => CompanyGraphMutationTable.id, { onDelete: "set null" }),
    expected_revision: integer().notNull(),
    orchestrator_version: integer().notNull(),
    idempotency_key: text().notNull(),
    kind: text().notNull(),
    mode: text().notNull(),
    reason_code: text().notNull(),
    summary: text().notNull(),
    evidence_refs_json: text().notNull(),
    operations_json: text().notNull(),
    automated: integer({ mode: "boolean" }).notNull(),
    added_node_count: integer().notNull(),
    status: text().notNull(),
    created_at: integer().notNull(),
    resolved_at: integer(),
  },
  (table) => [
    uniqueIndex("company_graph_decision_project_idempotency_idx").on(table.project_id, table.idempotency_key),
    uniqueIndex("company_graph_decision_receipt_revision_idx").on(table.receipt_id, table.expected_revision),
    index("company_graph_decision_project_status_idx").on(table.project_id, table.status),
  ],
)

export const CompanyValidationGateTable = sqliteTable(
  "company_validation_gate",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    work_item_id: text().references(() => CompanyWorkItemTable.id, { onDelete: "set null" }),
    kind: text().notNull(),
    status: text().notNull(),
    criteria_json: text().notNull(),
    criteria_sha256: text().notNull(),
    blocking_work_item_ids_json: text().notNull(),
    evidence_refs_json: text().notNull(),
    evaluator: text().notNull(),
    repair_round: integer().notNull().default(0),
    max_repair_rounds: integer().notNull().default(3),
    failure_summary: text(),
    supersedes_gate_id: text(),
    created_at: integer().notNull(),
    evaluated_at: integer(),
  },
  (table) => [
    index("company_validation_gate_project_status_idx").on(table.project_id, table.status),
    index("company_validation_gate_work_item_idx").on(table.work_item_id),
  ],
)

export const CompanyValidationRepairTable = sqliteTable(
  "company_validation_repair",
  {
    id: text().primaryKey(),
    gate_id: text()
      .notNull()
      .references(() => CompanyValidationGateTable.id, { onDelete: "cascade" }),
    round: integer().notNull(),
    idempotency_key: text().notNull(),
    input_sha256: text().notNull(),
    failure_kind: text().notNull(),
    diagnosis_json: text().notNull(),
    fix_summary: text().notNull(),
    repair_diff_json: text().notNull(),
    reverify_evidence_json: text().notNull(),
    result: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("company_validation_repair_gate_round_idx").on(table.gate_id, table.round),
    uniqueIndex("company_validation_repair_gate_idempotency_idx").on(table.gate_id, table.idempotency_key),
  ],
)

export const CompanyApprovalGateTable = sqliteTable(
  "company_approval_gate",
  {
    id: text().primaryKey(),
    project_id: text()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    company_id: text(),
    scope_type: text().notNull().default("project"),
    pre_project_id: text(),
    decision_id: text(),
    kind: text().notNull(),
    status: text().notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    requested_by_agent_id: text(),
    requested_by_actor_kind: text(),
    requested_by_actor_id: text(),
    work_item_id: text().references(() => CompanyWorkItemTable.id, { onDelete: "set null" }),
    resource_scope_json: text().notNull().default("[]"),
    worktree_run_id: text().references(() => CompanyWorktreeRunTable.id, { onDelete: "set null" }),
    decision_note: text(),
    requested_at: integer().notNull(),
    decided_at: integer(),
  },
  (table) => [
    index("company_approval_gate_project_idx").on(table.project_id, table.status),
    index("company_approval_gate_project_kind_status_idx").on(table.project_id, table.kind, table.status),
    index("company_approval_gate_work_item_idx").on(table.work_item_id, table.status),
    index("company_approval_gate_company_scope_idx").on(table.company_id, table.scope_type, table.status),
    uniqueIndex("company_approval_gate_pending_decision_idx")
      .on(table.decision_id)
      .where(sql.raw("status = 'pending' AND decision_id IS NOT NULL")),
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

export const CompanyAttentionTable = sqliteTable(
  "company_attention",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    idempotency_key: text().notNull(),
    issue_kind: text().notNull(),
    risk: text().notNull(),
    materiality: text().notNull(),
    route: text().notNull(),
    material: integer({ mode: "boolean" }).notNull(),
    interrupts_user: integer({ mode: "boolean" }).notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    required_decision: text(),
    allowed_actions_json: text().notNull(),
    source_refs_json: text().notNull(),
    input_sha256: text().notNull(),
    status: text().notNull(),
    resolution: text(),
    version: integer().notNull().default(1),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    resolved_at: integer(),
  },
  (table) => [
    uniqueIndex("company_attention_project_idempotency_idx").on(table.project_id, table.idempotency_key),
    index("company_attention_project_status_idx").on(table.project_id, table.status, table.updated_at),
  ],
)

export const CompanyProjectActionTable = sqliteTable(
  "company_project_action",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    attention_id: text().references(() => CompanyAttentionTable.id, { onDelete: "set null" }),
    action: text().notNull(),
    idempotency_key: text().notNull(),
    payload_json: text().notNull(),
    payload_sha256: text().notNull(),
    expected_revision: integer(),
    status: text().notNull(),
    result_json: text(),
    error: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    claimed_at: integer(),
    finished_at: integer(),
  },
  (table) => [
    uniqueIndex("company_project_action_project_idempotency_idx").on(table.project_id, table.idempotency_key),
    index("company_project_action_project_status_idx").on(table.project_id, table.status, table.updated_at),
    index("company_project_action_attention_idx").on(table.attention_id),
  ],
)
