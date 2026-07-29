import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CompanyProjectTable } from "@/company-project/company-project.sql"

export const CompanyRolloutStateTable = sqliteTable("company_rollout_state", {
  id: text().primaryKey(),
  phase: text().notNull(),
  version: integer().notNull(),
  last_transition_id: text(),
  updated_at: integer().notNull(),
})

export const CompanyRolloutJournalTable = sqliteTable(
  "company_rollout_journal",
  {
    id: text().primaryKey(),
    kind: text().notNull(),
    action_kind: text(),
    idempotency_key: text().notNull(),
    payload_sha256: text().notNull(),
    payload_json: text().notNull(),
    result_ref_id: text().notNull(),
    result_json: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("company_rollout_journal_idempotency_idx").on(table.kind, table.idempotency_key),
    uniqueIndex("company_rollout_journal_action_ref_idx").on(table.action_kind, table.result_ref_id),
    index("company_rollout_journal_created_idx").on(table.created_at),
  ],
)

export const CompanyRolloutCandidateTable = sqliteTable(
  "company_rollout_candidate",
  {
    id: text().primaryKey(),
    candidate_sha: text().notNull(),
    target_ref: text().notNull(),
    registered_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("company_rollout_candidate_sha_idx").on(table.candidate_sha),
    index("company_rollout_candidate_registered_idx").on(table.registered_at),
  ],
)

export const CompanyRolloutLocalRepeatTable = sqliteTable(
  "company_rollout_local_repeat",
  {
    id: text().primaryKey(),
    candidate_id: text()
      .notNull()
      .references(() => CompanyRolloutCandidateTable.id, { onDelete: "cascade" }),
    run_id: text().notNull(),
    ordinal: integer().notNull(),
    outcome: text().notNull(),
    environment_sha256: text().notNull(),
    evidence_sha256: text().notNull(),
    normalized_result_sha256: text(),
    started_at: integer().notNull(),
    finished_at: integer().notNull(),
    recorded_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("company_rollout_local_repeat_candidate_ordinal_idx").on(table.candidate_id, table.ordinal),
    uniqueIndex("company_rollout_local_repeat_run_idx").on(table.run_id),
    index("company_rollout_local_repeat_recorded_idx").on(table.recorded_at),
  ],
)

export const CompanyRolloutRollbackTable = sqliteTable(
  "company_rollout_rollback",
  {
    id: text().primaryKey(),
    candidate_id: text().references(() => CompanyRolloutCandidateTable.id, {
      onDelete: "set null",
    }),
    project_id: text().references(() => CompanyProjectTable.id, { onDelete: "set null" }),
    target: text().notNull(),
    phase_at_action: text().notNull(),
    execution_mode_after: text().notNull(),
    outcome: text().notNull(),
    evidence_sha256: text().notNull(),
    observed_at: integer().notNull(),
    recorded_at: integer().notNull(),
  },
  (table) => [
    index("company_rollout_rollback_candidate_idx").on(table.candidate_id),
    index("company_rollout_rollback_project_idx").on(table.project_id),
    index("company_rollout_rollback_recorded_idx").on(table.recorded_at),
  ],
)

export const CompanyRolloutShadowEvaluationTable = sqliteTable(
  "company_rollout_shadow_evaluation",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    source_key: text().notNull(),
    kind: text().notNull(),
    receipt_id: text(),
    snapshot_sha256: text().notNull(),
    input_sha256: text().notNull(),
    output_sha256: text().notNull(),
    business_state_before_sha256: text().notNull(),
    business_state_after_sha256: text().notNull(),
    input_json: text().notNull(),
    output_json: text().notNull(),
    status: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("company_rollout_shadow_source_idx").on(table.source_key),
    index("company_rollout_shadow_project_idx").on(table.project_id, table.created_at),
    index("company_rollout_shadow_receipt_idx").on(table.receipt_id),
  ],
)
