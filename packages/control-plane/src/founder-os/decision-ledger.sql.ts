import { sql } from "drizzle-orm"
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CompanyTable } from "@/company/company.sql"

export const DecisionRecordTable = sqliteTable(
  "founder_decision_record",
  {
    id: text().primaryKey(),
    company_id: text()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    scope_type: text().notNull(),
    project_id: text(),
    pre_project_id: text(),
    idempotency_key: text().notNull(),
    input_sha256: text().notNull(),
    record_origin: text().notNull(),
    source_completeness: text().notNull(),
    founder_snapshot_id: text(),
    founder_snapshot_version: integer(),
    subject: text(),
    context: text(),
    options_json: text(),
    recommendation: text(),
    final_decision: text(),
    decision_maker: text().notNull(),
    decision_maker_id: text().notNull(),
    authority_class: text(),
    operating_mode: text(),
    confidence: real(),
    reversible: integer({ mode: "boolean" }),
    external_impact: integer({ mode: "boolean" }),
    risk_level: text(),
    evidence_refs_json: text(),
    principle_refs_json: text(),
    decision_case_refs_json: text(),
    override_of: text(),
    created_at: integer().notNull(),
    decided_at: integer(),
  },
  (table) => [
    uniqueIndex("founder_decision_record_idempotency_idx").on(table.company_id, table.idempotency_key),
    index("founder_decision_record_scope_idx").on(table.company_id, table.scope_type, table.project_id),
    index("founder_decision_record_pre_project_idx").on(table.company_id, table.pre_project_id),
    check(
      "founder_decision_record_scope_check",
      sql`(${table.scope_type} = 'company' AND ${table.project_id} IS NULL AND ${table.pre_project_id} IS NULL)
        OR (${table.scope_type} = 'project' AND ${table.project_id} IS NOT NULL AND ${table.pre_project_id} IS NULL)
        OR (${table.scope_type} = 'pre_project' AND ${table.project_id} IS NULL AND ${table.pre_project_id} IS NOT NULL)`,
    ),
    check(
      "founder_decision_record_snapshot_pair_check",
      sql`(${table.founder_snapshot_id} IS NULL) = (${table.founder_snapshot_version} IS NULL)`,
    ),
    check(
      "founder_decision_record_ai_snapshot_check",
      sql`${table.record_origin} != 'live' OR ${table.decision_maker} != 'ai_founder'
        OR (${table.founder_snapshot_id} IS NOT NULL
          AND ${table.recommendation} IS NOT NULL
          AND ${table.authority_class} IS NOT NULL
          AND ${table.operating_mode} IS NOT NULL
          AND ${table.confidence} IS NOT NULL
          AND ${table.reversible} IS NOT NULL
          AND ${table.external_impact} IS NOT NULL
          AND ${table.risk_level} IS NOT NULL)`,
    ),
    check(
      "founder_decision_record_origin_check",
      sql`(${table.record_origin} = 'live' AND ${table.decision_maker} != 'unknown')
        OR ${table.record_origin} = 'historical_import'`,
    ),
  ],
)

export const DecisionTransitionTable = sqliteTable(
  "founder_decision_transition",
  {
    id: text().primaryKey(),
    decision_id: text()
      .notNull()
      .references(() => DecisionRecordTable.id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    idempotency_key: text().notNull(),
    input_sha256: text().notNull(),
    from_status: text(),
    to_status: text().notNull(),
    kind: text().notNull(),
    reason: text().notNull(),
    actor_id: text().notNull(),
    final_decision: text(),
    decided_at: integer(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_decision_transition_sequence_idx").on(table.decision_id, table.sequence),
    uniqueIndex("founder_decision_transition_idempotency_idx").on(table.decision_id, table.idempotency_key),
    index("founder_decision_transition_time_idx").on(table.decision_id, table.created_at),
    check(
      "founder_decision_transition_finalization_check",
      sql`(${table.to_status} IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back')
        AND ${table.final_decision} IS NOT NULL AND ${table.decided_at} IS NOT NULL)
        OR (${table.to_status} NOT IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back')
          AND ${table.final_decision} IS NULL AND ${table.decided_at} IS NULL)`,
    ),
  ],
)

export const DecisionCurrentProjectionTable = sqliteTable(
  "founder_decision_current",
  {
    decision_id: text()
      .primaryKey()
      .references(() => DecisionRecordTable.id, { onDelete: "cascade" }),
    current_status: text().notNull(),
    latest_transition_id: text()
      .notNull()
      .references(() => DecisionTransitionTable.id),
    transition_count: integer().notNull(),
    outcome_ref_ids_json: text().notNull().default("[]"),
    final_decision: text(),
    decided_at: integer(),
    updated_at: integer().notNull(),
  },
  (table) => [
    check(
      "founder_decision_current_finalization_check",
      sql`(${table.current_status} IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back')
        AND ${table.final_decision} IS NOT NULL AND ${table.decided_at} IS NOT NULL)
        OR (${table.current_status} NOT IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back')
          AND ${table.final_decision} IS NULL AND ${table.decided_at} IS NULL)`,
    ),
  ],
)

export const DecisionDispatchOutboxTable = sqliteTable(
  "founder_decision_dispatch_outbox",
  {
    id: text().primaryKey(),
    company_id: text()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    decision_id: text()
      .notNull()
      .references(() => DecisionRecordTable.id, { onDelete: "cascade" }),
    transition_id: text().references(() => DecisionTransitionTable.id, { onDelete: "restrict" }),
    consumer: text().notNull(),
    action_type: text().notNull(),
    payload_json: text().notNull(),
    idempotency_key: text().notNull(),
    input_sha256: text().notNull(),
    execution_key: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_decision_dispatch_outbox_idempotency_idx").on(table.decision_id, table.idempotency_key),
    uniqueIndex("founder_decision_dispatch_outbox_execution_idx").on(table.execution_key),
    index("founder_decision_dispatch_outbox_consumer_idx").on(table.consumer, table.created_at),
  ],
)

export const DecisionDispatchEventTable = sqliteTable(
  "founder_decision_dispatch_event",
  {
    id: text().primaryKey(),
    outbox_id: text()
      .notNull()
      .references(() => DecisionDispatchOutboxTable.id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    idempotency_key: text().notNull(),
    status: text().notNull(),
    consumer_id: text(),
    lease_token: text(),
    lease_expires_at: integer(),
    execution_receipt: text(),
    error: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_decision_dispatch_event_sequence_idx").on(table.outbox_id, table.sequence),
    uniqueIndex("founder_decision_dispatch_event_idempotency_idx").on(table.outbox_id, table.idempotency_key),
    index("founder_decision_dispatch_event_status_idx").on(table.status, table.created_at),
  ],
)

export const DecisionDispatchCurrentTable = sqliteTable("founder_decision_dispatch_current", {
  outbox_id: text()
    .primaryKey()
    .references(() => DecisionDispatchOutboxTable.id, { onDelete: "cascade" }),
  current_status: text().notNull(),
  latest_event_id: text()
    .notNull()
    .references(() => DecisionDispatchEventTable.id, { onDelete: "restrict" }),
  event_count: integer().notNull(),
  consumer_id: text(),
  lease_token: text(),
  lease_expires_at: integer(),
  execution_receipt: text(),
  last_error: text(),
  updated_at: integer().notNull(),
})

export const DecisionSourceMappingTable = sqliteTable(
  "founder_decision_source",
  {
    decision_id: text()
      .primaryKey()
      .references(() => DecisionRecordTable.id, { onDelete: "cascade" }),
    channel_message_id: text(),
    board_thread_id: text(),
    board_run_id: text(),
    runtime_id: text(),
    source_completeness: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_decision_source_message_idx")
      .on(table.channel_message_id)
      .where(sql`${table.channel_message_id} IS NOT NULL`),
    index("founder_decision_source_thread_run_idx").on(table.board_thread_id, table.board_run_id),
  ],
)

export const DelegationPolicyTable = sqliteTable(
  "founder_delegation_policy",
  {
    id: text().primaryKey(),
    company_id: text()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    action_type: text().notNull(),
    risk_level: text().notNull(),
    reversible: integer({ mode: "boolean" }).notNull(),
    external_impact: integer({ mode: "boolean" }).notNull(),
    budget_limit_json: text(),
    requires_approval: integer({ mode: "boolean" }).notNull(),
    allowed_mode: text().notNull(),
    version: integer().notNull(),
    scope_type: text().notNull(),
    scope_key: text().notNull(),
    project_id: text(),
    pre_project_id: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_delegation_policy_version_idx").on(
      table.company_id,
      table.action_type,
      table.scope_key,
      table.version,
    ),
    index("founder_delegation_policy_scope_idx").on(table.company_id, table.scope_type, table.action_type),
    check(
      "founder_delegation_policy_scope_check",
      sql`(${table.scope_type} = 'company' AND ${table.project_id} IS NULL AND ${table.pre_project_id} IS NULL)
        OR (${table.scope_type} = 'project' AND ${table.project_id} IS NOT NULL AND ${table.pre_project_id} IS NULL)
        OR (${table.scope_type} = 'pre_project' AND ${table.project_id} IS NULL AND ${table.pre_project_id} IS NOT NULL)`,
    ),
    check(
      "founder_delegation_policy_red_check",
      sql`${table.risk_level} != 'red' OR (${table.requires_approval} = 1 AND ${table.allowed_mode} = 'none')`,
    ),
  ],
)

export const FounderCorrectionTable = sqliteTable(
  "founder_decision_correction",
  {
    id: text().primaryKey(),
    company_id: text()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    decision_id: text()
      .notNull()
      .references(() => DecisionRecordTable.id, { onDelete: "cascade" }),
    idempotency_key: text().notNull(),
    kind: text().notNull(),
    original_decision: text(),
    human_decision: text().notNull(),
    reason: text().notNull(),
    proposed_asset_updates_json: text().notNull(),
    actor_id: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_decision_correction_idempotency_idx").on(table.company_id, table.idempotency_key),
    index("founder_decision_correction_decision_idx").on(table.decision_id, table.created_at),
  ],
)

export const FounderGovernanceEventTable = sqliteTable(
  "founder_governance_event",
  {
    id: text().primaryKey(),
    company_id: text()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    scope_type: text().notNull(),
    scope_key: text().notNull(),
    decision_id: text()
      .notNull()
      .references(() => DecisionRecordTable.id, { onDelete: "cascade" }),
    gate_id: text(),
    type: text().notNull(),
    actor_kind: text().notNull(),
    actor_id: text().notNull(),
    data_json: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("founder_governance_event_decision_idx").on(table.decision_id, table.created_at),
    index("founder_governance_event_scope_idx").on(table.company_id, table.scope_type, table.scope_key),
  ],
)
