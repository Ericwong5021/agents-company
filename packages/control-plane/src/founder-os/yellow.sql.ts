import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CompanyOutcomeSignalTable, CompanyProjectTable, CompanyWorkReceiptTable } from "@/company-project/company-project.sql"
import { CompanyTable } from "@/company/company.sql"
import { DecisionRecordTable } from "./decision-ledger.sql"
import { FounderGreenReadinessTable } from "@/project-orchestrator/founder-delegation.sql"

export const FounderYellowReadinessTable = sqliteTable(
  "founder_yellow_readiness",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    idempotency_key: text().notNull(),
    input_sha256: text().notNull(),
    green_readiness_id: text().notNull().references(() => FounderGreenReadinessTable.id),
    w6_observation_evidence_ref: text().notNull(),
    e0_evidence_ref: text().notNull(),
    outcome_signal_id: text().notNull().references(() => CompanyOutcomeSignalTable.id),
    authorization_event_id: text().notNull(),
    confirmed_by: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_yellow_readiness_idempotency_idx").on(table.company_id, table.idempotency_key),
    index("founder_yellow_readiness_company_created_idx").on(table.company_id, table.created_at),
  ],
)

export const FounderYellowCheckpointTable = sqliteTable(
  "founder_yellow_checkpoint",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    project_id: text().notNull().references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    decision_id: text().notNull().references(() => DecisionRecordTable.id),
    receipt_id: text().notNull().references(() => CompanyWorkReceiptTable.id),
    action_type: text().notNull(),
    direction_json: text().notNull(),
    rollback_handler_id: text().notNull(),
    snapshot_json: text().notNull(),
    snapshot_sha256: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("founder_yellow_checkpoint_decision_idx").on(table.decision_id, table.created_at),
    index("founder_yellow_checkpoint_project_idx").on(table.project_id, table.created_at),
  ],
)

export const FounderYellowRunTable = sqliteTable(
  "founder_yellow_run",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    idempotency_key: text().notNull(),
    input_sha256: text().notNull(),
    project_id: text().notNull().references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    board_thread_id: text().notNull(),
    decision_id: text().notNull().references(() => DecisionRecordTable.id),
    receipt_id: text().notNull().references(() => CompanyWorkReceiptTable.id),
    action_type: text().notNull(),
    status: text().notNull(),
    readiness_id: text().references(() => FounderYellowReadinessTable.id),
    checkpoint_id: text().references(() => FounderYellowCheckpointTable.id),
    governance_ref: text(),
    graph_decision_id: text(),
    mutation_id: text(),
    work_item_ids_json: text().notNull(),
    receipt_ids_json: text().notNull(),
    outcome_ids_json: text().notNull(),
    direction_json: text().notNull(),
    cost_unit: text().notNull(),
    cost_limit: real().notNull(),
    estimated_cost: real().notNull(),
    actual_cost: real().notNull(),
    rollback_handler_id: text(),
    dispatched_at: integer(),
    fail_closed_reasons_json: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_yellow_run_idempotency_idx").on(table.company_id, table.idempotency_key),
    index("founder_yellow_run_decision_idx").on(table.decision_id, table.created_at),
    index("founder_yellow_run_company_status_idx").on(table.company_id, table.status, table.created_at),
  ],
)

export const FounderYellowDispatchOutboxTable = sqliteTable(
  "founder_yellow_dispatch_outbox",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    run_id: text().notNull().references(() => FounderYellowRunTable.id, { onDelete: "cascade" }),
    decision_id: text().notNull().references(() => DecisionRecordTable.id),
    receipt_id: text().notNull().references(() => CompanyWorkReceiptTable.id),
    checkpoint_id: text().notNull().references(() => FounderYellowCheckpointTable.id),
    status: text().notNull(),
    attempts: integer().notNull(),
    last_error: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_yellow_dispatch_outbox_run_idx").on(table.run_id),
    index("founder_yellow_dispatch_outbox_status_idx").on(table.status, table.created_at),
  ],
)

export const FounderYellowEventTable = sqliteTable(
  "founder_yellow_event",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    run_id: text().references(() => FounderYellowRunTable.id, { onDelete: "cascade" }),
    decision_id: text().references(() => DecisionRecordTable.id),
    idempotency_key: text().notNull(),
    type: text().notNull(),
    actor_kind: text().notNull(),
    actor_id: text().notNull(),
    data_json: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_yellow_event_idempotency_idx").on(table.company_id, table.idempotency_key),
    index("founder_yellow_event_run_created_idx").on(table.run_id, table.created_at),
    index("founder_yellow_event_company_type_idx").on(table.company_id, table.type, table.created_at),
  ],
)
