import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { CompanyTable } from "@/company/company.sql"
import {
  CompanyOutcomeSignalTable,
  CompanyProjectTable,
  CompanyWorkReceiptTable,
} from "@/company-project/company-project.sql"
import { CompanyCommonsSourceTable } from "@/company-commons/company-commons.sql"
import { CompanyInterpretationTable } from "@/company-reading/company-reading.sql"
import { DecisionRecordTable } from "@/founder-os/decision-ledger.sql"
import { SkillSnapshotTable } from "@/agent-run/agent-run.sql"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"

export const CompanyBeliefTable = sqliteTable("company_belief", {
  id: text().primaryKey(),
  company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
  source_id: text().notNull().references(() => CompanyCommonsSourceTable.id, { onDelete: "restrict" }),
  statement: text().notNull(),
  scope_json: text().notNull(),
  applicable_scopes_json: text().notNull(),
  inapplicable_scopes_json: text().notNull(),
  confidence: real().notNull(),
  status: text().notNull(),
  action_implications_json: text().notNull(),
  created_by: text().notNull(),
  approved_by: text(),
  board_decision_id: text().references(() => DecisionRecordTable.id, { onDelete: "restrict" }),
  review_at: integer(),
  created_at: integer().notNull(),
  approved_at: integer(),
  updated_at: integer().notNull(),
}, (table) => [
  index("company_belief_company_status_idx").on(table.company_id, table.status, table.updated_at),
  index("company_belief_source_idx").on(table.source_id, table.created_at),
  check("company_belief_confidence_check", sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`),
  check("company_belief_status_check", sql`${table.status} IN ('candidate','contested','experiment_pending','validated','adopted','rejected','deprecated')`),
  check("company_belief_adoption_check", sql`${table.status} != 'adopted' OR (${table.approved_by} IS NOT NULL AND ${table.approved_at} IS NOT NULL AND ${table.board_decision_id} IS NOT NULL)`),
])

export const CompanyBeliefInterpretationTable = sqliteTable("company_belief_interpretation", {
  belief_id: text().notNull().references(() => CompanyBeliefTable.id, { onDelete: "cascade" }),
  interpretation_id: text().notNull().references(() => CompanyInterpretationTable.id, { onDelete: "restrict" }),
  position: text().notNull(),
}, (table) => [
  uniqueIndex("company_belief_interpretation_idx").on(table.belief_id, table.interpretation_id),
  index("company_belief_interpretation_source_idx").on(table.interpretation_id),
  check("company_belief_interpretation_position_check", sql`${table.position} IN ('supporting','counter','context')`),
])

export const CompanyBeliefEvidenceTable = sqliteTable("company_belief_evidence", {
  id: text().primaryKey(),
  belief_id: text().notNull().references(() => CompanyBeliefTable.id, { onDelete: "cascade" }),
  position: text().notNull(),
  source_kind: text().notNull(),
  source_ref: text().notNull(),
  summary: text().notNull(),
  created_by: text().notNull(),
  created_at: integer().notNull(),
}, (table) => [
  uniqueIndex("company_belief_evidence_ref_idx").on(table.belief_id, table.position, table.source_kind, table.source_ref),
  index("company_belief_evidence_belief_idx").on(table.belief_id, table.created_at),
  check("company_belief_evidence_position_check", sql`${table.position} IN ('supporting','counter')`),
  check("company_belief_evidence_source_check", sql`${table.source_kind} IN ('interpretation','outcome_signal','artifact','decision','external')`),
])

export const CompanyExperimentTable = sqliteTable("company_experiment", {
  id: text().primaryKey(),
  company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
  belief_id: text().notNull().references(() => CompanyBeliefTable.id, { onDelete: "restrict" }),
  project_id: text().notNull().references(() => CompanyProjectTable.id, { onDelete: "restrict" }),
  decision_id: text().notNull().references(() => DecisionRecordTable.id, { onDelete: "restrict" }),
  idempotency_key: text().notNull(),
  decision_intent_json: text().notNull(),
  hypothesis: text().notNull(),
  success_criteria_json: text().notNull(),
  failure_criteria_json: text().notNull(),
  rollback_plan: text().notNull(),
  status: text().notNull(),
  verdict: text().notNull(),
  authority_class: text().notNull(),
  approval_gate_id: text(),
  proposed_by: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  completed_at: integer(),
  evaluated_at: integer(),
}, (table) => [
  uniqueIndex("company_experiment_idempotency_idx").on(table.company_id, table.idempotency_key),
  index("company_experiment_belief_idx").on(table.belief_id, table.created_at),
  index("company_experiment_project_idx").on(table.project_id, table.status),
  check("company_experiment_status_check", sql`${table.status} IN ('proposed','authorized','running','completed','evaluated','rejected','stopped')`),
  check("company_experiment_verdict_check", sql`${table.verdict} IN ('pending','supported','refuted','inconclusive')`),
  check("company_experiment_result_check", sql`${table.status} != 'completed' OR ${table.verdict} = 'pending'`),
])

export const CompanyExperimentOutcomeTable = sqliteTable("company_experiment_outcome", {
  experiment_id: text().notNull().references(() => CompanyExperimentTable.id, { onDelete: "cascade" }),
  outcome_signal_id: text().notNull().references(() => CompanyOutcomeSignalTable.id, { onDelete: "restrict" }),
  linked_by: text().notNull(),
  linked_at: integer().notNull(),
}, (table) => [
  uniqueIndex("company_experiment_outcome_idx").on(table.experiment_id, table.outcome_signal_id),
  index("company_experiment_outcome_signal_idx").on(table.outcome_signal_id),
])

export const CompanyLearningPatchTable = sqliteTable("company_learning_patch", {
  id: text().primaryKey(),
  company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
  source_decision_id: text().notNull().references(() => DecisionRecordTable.id, { onDelete: "restrict" }),
  source_experiment_id: text().notNull().references(() => CompanyExperimentTable.id, { onDelete: "restrict" }),
  source_outcome_id: text().notNull().references(() => CompanyOutcomeSignalTable.id, { onDelete: "restrict" }),
  target_type: text().notNull(),
  target_id: text().notNull(),
  proposed_diff_json: text().notNull(),
  evidence_json: text().notNull(),
  expected_impact: text().notNull(),
  benchmark_plan: text().notNull(),
  rollback_plan: text().notNull(),
  status: text().notNull(),
  authority_class: text().notNull(),
  approval_gate_id: text(),
  created_by: text().notNull(),
  approved_by: text(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  index("company_learning_patch_company_status_idx").on(table.company_id, table.status, table.updated_at),
  index("company_learning_patch_target_idx").on(table.target_type, table.target_id, table.created_at),
  check("company_learning_patch_target_check", sql`${table.target_type} IN ('governance_asset','delegation_policy','skill','benchmark','agent_interest','workflow')`),
  check("company_learning_patch_status_check", sql`${table.status} IN ('proposed','approved','canary','active','rejected','rolled_back')`),
])

export const CompanyPatchBenchmarkTable = sqliteTable("company_patch_benchmark", {
  id: text().primaryKey(),
  patch_id: text().notNull().references(() => CompanyLearningPatchTable.id, { onDelete: "cascade" }),
  version: integer().notNull(),
  holdout_manifest_json: text().notNull(),
  holdout_sha256: text().notNull(),
  frozen_at: integer().notNull(),
  author_id: text().notNull(),
  subject_id: text(),
  reviewer_id: text().notNull(),
  reviewer_principal_id: text().references(() => CompanyAgentTable.id, { onDelete: "restrict" }),
  report_author_id: text().references(() => CompanyAgentTable.id, { onDelete: "restrict" }),
  result: text().notNull(),
  evidence_refs_json: text().notNull(),
  real_sample_count: integer().notNull(),
  reviewed_at: integer().notNull(),
}, (table) => [
  uniqueIndex("company_patch_benchmark_version_idx").on(table.patch_id, table.version),
  uniqueIndex("company_patch_benchmark_holdout_idx").on(table.patch_id, table.holdout_sha256),
  check("company_patch_benchmark_result_check", sql`${table.result} IN ('passed','failed','not_confirmed')`),
  check("company_patch_benchmark_sample_check", sql`${table.real_sample_count} >= 0`),
  check("company_patch_benchmark_reviewer_check", sql`${table.reviewer_id} != ${table.author_id} AND (${table.subject_id} IS NULL OR ${table.reviewer_id} != ${table.subject_id})`),
  check("company_patch_benchmark_reviewer_principal_check", sql`${table.reviewer_principal_id} IS NULL OR ${table.reviewer_principal_id} = ${table.reviewer_id}`),
  check("company_patch_benchmark_report_author_check", sql`${table.report_author_id} IS NULL OR ${table.reviewer_id} != ${table.report_author_id}`),
])

export const CompanyPatchCanaryTable = sqliteTable("company_patch_canary", {
  id: text().primaryKey(),
  patch_id: text().notNull().references(() => CompanyLearningPatchTable.id, { onDelete: "cascade" }),
  previous_version_ref: text().notNull(),
  candidate_version_ref: text().notNull(),
  status: text().notNull(),
  metric_evidence_refs_json: text().notNull(),
  started_at: integer().notNull(),
  finished_at: integer(),
}, (table) => [
  index("company_patch_canary_patch_idx").on(table.patch_id, table.started_at),
  check("company_patch_canary_status_check", sql`${table.status} IN ('running','passed','failed','rolled_back','not_confirmed')`),
])

export const CompanyPatchEventTable = sqliteTable("company_patch_event", {
  id: text().primaryKey(),
  patch_id: text().notNull().references(() => CompanyLearningPatchTable.id, { onDelete: "cascade" }),
  type: text().notNull(),
  actor_id: text().notNull(),
  data_json: text().notNull(),
  created_at: integer().notNull(),
}, (table) => [
  index("company_patch_event_patch_idx").on(table.patch_id, table.created_at),
])

export const CompanyPatchTargetVersionTable = sqliteTable("company_patch_target_version", {
  id: text().primaryKey(),
  patch_id: text().notNull().references(() => CompanyLearningPatchTable.id, { onDelete: "restrict" }),
  company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
  target_type: text().notNull(),
  target_id: text().notNull(),
  version: integer().notNull(),
  payload_json: text().notNull(),
  previous_version_ref: text(),
  target_version_ref: text(),
  status: text().notNull(),
  created_at: integer().notNull(),
}, (table) => [
  uniqueIndex("company_patch_target_version_idx").on(table.company_id, table.target_type, table.target_id, table.version),
  index("company_patch_target_current_idx").on(table.company_id, table.target_type, table.target_id, table.status),
  check("company_patch_target_version_status_check", sql`${table.status} IN ('candidate','active','superseded','rolled_back')`),
])

export const CompanyLearningBenchmarkTargetVersionTable = sqliteTable("company_learning_benchmark_target_version", {
  id: text().primaryKey(),
  patch_id: text().notNull().references(() => CompanyLearningPatchTable.id, { onDelete: "restrict" }),
  company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
  target_id: text().notNull(),
  version: integer().notNull(),
  payload_json: text().notNull(),
  created_by: text().notNull(),
  created_at: integer().notNull(),
}, (table) => [
  uniqueIndex("company_learning_benchmark_target_patch_idx").on(table.patch_id),
  uniqueIndex("company_learning_benchmark_target_version_idx").on(table.company_id, table.target_id, table.version),
])

export const CompanyLearningBenchmarkTargetSelectionTable = sqliteTable("company_learning_benchmark_target_selection", {
  id: text().primaryKey(),
  company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
  target_id: text().notNull(),
  version_id: text().references(() => CompanyLearningBenchmarkTargetVersionTable.id, { onDelete: "restrict" }),
  previous_version_id: text().references(() => CompanyLearningBenchmarkTargetVersionTable.id, { onDelete: "restrict" }),
  selected_by: text().notNull(),
  selected_at: integer().notNull(),
}, (table) => [
  index("company_learning_benchmark_target_current_idx").on(table.company_id, table.target_id, table.selected_at),
])

export const CompanyLearningInterestTargetVersionTable = sqliteTable("company_learning_interest_target_version", {
  id: text().primaryKey(),
  patch_id: text().notNull().references(() => CompanyLearningPatchTable.id, { onDelete: "restrict" }),
  company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
  agent_id: text().notNull().references(() => CompanyAgentTable.id, { onDelete: "restrict" }),
  version: integer().notNull(),
  payload_json: text().notNull(),
  created_by: text().notNull(),
  created_at: integer().notNull(),
}, (table) => [
  index("company_learning_interest_target_patch_idx").on(table.patch_id),
  uniqueIndex("company_learning_interest_target_version_idx").on(table.company_id, table.agent_id, table.version),
])

export const CompanyLearningInterestTargetSelectionTable = sqliteTable("company_learning_interest_target_selection", {
  id: text().primaryKey(),
  company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
  agent_id: text().notNull().references(() => CompanyAgentTable.id, { onDelete: "restrict" }),
  version_id: text().references(() => CompanyLearningInterestTargetVersionTable.id, { onDelete: "restrict" }),
  previous_version_id: text().references(() => CompanyLearningInterestTargetVersionTable.id, { onDelete: "restrict" }),
  selected_by: text().notNull(),
  selected_at: integer().notNull(),
}, (table) => [
  index("company_learning_interest_target_current_idx").on(table.company_id, table.agent_id, table.selected_at),
])

export const CompanyLearningWorkflowTargetVersionTable = sqliteTable("company_learning_workflow_target_version", {
  id: text().primaryKey(),
  patch_id: text().notNull().references(() => CompanyLearningPatchTable.id, { onDelete: "restrict" }),
  company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
  target_id: text().notNull(),
  version: integer().notNull(),
  payload_json: text().notNull(),
  created_by: text().notNull(),
  created_at: integer().notNull(),
}, (table) => [
  uniqueIndex("company_learning_workflow_target_patch_idx").on(table.patch_id),
  uniqueIndex("company_learning_workflow_target_version_idx").on(table.company_id, table.target_id, table.version),
])

export const CompanyLearningWorkflowTargetSelectionTable = sqliteTable("company_learning_workflow_target_selection", {
  id: text().primaryKey(),
  company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
  target_id: text().notNull(),
  version_id: text().references(() => CompanyLearningWorkflowTargetVersionTable.id, { onDelete: "restrict" }),
  previous_version_id: text().references(() => CompanyLearningWorkflowTargetVersionTable.id, { onDelete: "restrict" }),
  selected_by: text().notNull(),
  selected_at: integer().notNull(),
}, (table) => [
  index("company_learning_workflow_target_current_idx").on(table.company_id, table.target_id, table.selected_at),
])

export const CompanyWorkReceiptLearningTargetRefTable = sqliteTable("company_work_receipt_learning_target_ref", {
  receipt_id: text().notNull().references(() => CompanyWorkReceiptTable.id, { onDelete: "cascade" }),
  target_version_id: text().notNull().references(() => CompanyPatchTargetVersionTable.id, { onDelete: "restrict" }),
  target_type: text().notNull(),
  target_id: text().notNull(),
  version: integer().notNull(),
  created_at: integer().notNull(),
}, (table) => [
  uniqueIndex("company_work_receipt_learning_target_ref_idx").on(table.receipt_id, table.target_version_id),
  index("company_work_receipt_learning_target_version_idx").on(table.target_version_id, table.receipt_id),
  check("company_work_receipt_learning_target_type_check", sql`${table.target_type} IN ('governance_asset','delegation_policy','skill','benchmark','agent_interest','workflow')`),
])

export const CompanySkillCandidateSnapshotTable = sqliteTable("company_skill_candidate_snapshot", {
  id: text().primaryKey(),
  patch_id: text().notNull().references(() => CompanyLearningPatchTable.id, { onDelete: "restrict" }),
  skill_id: text().notNull(),
  runtime_snapshot_id: text().notNull().references(() => SkillSnapshotTable.id, { onDelete: "restrict" }),
  version: integer().notNull(),
  checksum: text().notNull(),
  payload_json: text().notNull(),
  status: text().notNull(),
  created_at: integer().notNull(),
}, (table) => [
  uniqueIndex("company_skill_candidate_version_idx").on(table.skill_id, table.version),
  index("company_skill_candidate_patch_idx").on(table.patch_id, table.created_at),
  check("company_skill_candidate_status_check", sql`${table.status} IN ('candidate','canary','active','superseded','rolled_back')`),
])
