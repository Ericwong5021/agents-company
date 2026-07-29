import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CompanyTable } from "@/company/company.sql"
import { FounderTwinSnapshotTable } from "./asset.sql"

export const FounderShadowDecisionTable = sqliteTable(
  "founder_shadow_decision",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    status: text().notNull(),
    block_reasons_json: text().notNull(),
    scope_kind: text().notNull(),
    scope_ref: text(),
    snapshot_id: text().references(() => FounderTwinSnapshotTable.id),
    snapshot_checksum: text(),
    model_config_ref: text().notNull(),
    recommendation: text(),
    alternatives_json: text().notNull(),
    authority_class: text(),
    confidence: integer(),
    principle_refs_json: text().notNull(),
    decision_case_refs_json: text().notNull(),
    taste_example_refs_json: text().notNull(),
    rubric_refs_json: text().notNull(),
    evidence_refs_json: text().notNull(),
    missing_information_json: text().notNull(),
    created_by: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("founder_shadow_decision_company_created_idx").on(table.company_id, table.created_at),
    index("founder_shadow_decision_snapshot_idx").on(table.snapshot_id),
  ],
)

export const FounderShadowComparisonTable = sqliteTable(
  "founder_shadow_comparison",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    shadow_decision_id: text().notNull().references(() => FounderShadowDecisionTable.id),
    actual_decision: text().notNull(),
    actual_decision_ref_json: text().notNull(),
    alignment: text().notNull(),
    rationale: text().notNull(),
    verification_status: text().notNull(),
    confirmed_by: text(),
    confirmation_event_id: text(),
    compared_by: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("founder_shadow_comparison_company_created_idx").on(table.company_id, table.created_at),
    uniqueIndex("founder_shadow_comparison_decision_source_idx").on(
      table.shadow_decision_id,
      table.actual_decision_ref_json,
    ),
  ],
)

export const FounderCalibrationRequestTable = sqliteTable(
  "founder_calibration_request",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    scope_kind: text().notNull(),
    scope_ref: text(),
    prompt: text().notNull(),
    candidates_json: text().notNull(),
    created_by: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("founder_calibration_request_company_created_idx").on(table.company_id, table.created_at),
  ],
)

export const FounderCalibrationResponseTable = sqliteTable(
  "founder_calibration_response",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    request_id: text().notNull().references(() => FounderCalibrationRequestTable.id),
    response: text().notNull(),
    reason: text().notNull(),
    confirmation_event_id: text().notNull(),
    confirmed_by: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_calibration_response_request_idx").on(table.request_id),
    uniqueIndex("founder_calibration_response_confirmation_idx").on(table.confirmation_event_id),
  ],
)

export const FounderBenchmarkCaseTable = sqliteTable(
  "founder_benchmark_case",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    benchmark_type: text().notNull(),
    dataset_version: text().notNull(),
    split: text().notNull(),
    source_asset_id: text().notNull(),
    source_asset_version: integer().notNull(),
    expected_json: text().notNull(),
    confirmation_event_id: text().notNull(),
    confirmed_by: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_benchmark_case_dataset_asset_idx").on(
      table.company_id,
      table.benchmark_type,
      table.dataset_version,
      table.source_asset_id,
      table.source_asset_version,
    ),
    uniqueIndex("founder_benchmark_case_confirmation_idx").on(table.confirmation_event_id),
    index("founder_benchmark_case_split_idx").on(
      table.company_id,
      table.benchmark_type,
      table.dataset_version,
      table.split,
    ),
  ],
)

export const FounderBenchmarkReportTable = sqliteTable(
  "founder_benchmark_report",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    benchmark_type: text().notNull(),
    dataset_version: text().notNull(),
    snapshot_id: text().notNull(),
    status: text().notNull(),
    block_reasons_json: text().notNull(),
    metrics_json: text().notNull(),
    confirmed_sample_count: integer().notNull(),
    input_checksum: text().notNull(),
    created_by: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_benchmark_report_input_idx").on(
      table.company_id,
      table.benchmark_type,
      table.dataset_version,
      table.snapshot_id,
      table.input_checksum,
    ),
    index("founder_benchmark_report_company_created_idx").on(table.company_id, table.created_at),
  ],
)
