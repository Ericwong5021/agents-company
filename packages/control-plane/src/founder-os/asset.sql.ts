import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CompanyTable } from "@/company/company.sql"

export const GovernanceAssetTable = sqliteTable(
  "governance_asset",
  {
    id: text().notNull(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    type: text().notNull(),
    scope_kind: text().notNull(),
    scope_ref: text(),
    content: text().notNull(),
    rationale: text().notNull(),
    tags_json: text().notNull(),
    authority: text().notNull(),
    status: text().notNull(),
    source_refs_json: text().notNull(),
    supersedes_version: integer(),
    version: integer().notNull(),
    created_by: text().notNull(),
    approved_by: text(),
    approved_at: integer(),
    confirmation_event_id: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.version] }),
    index("governance_asset_company_scope_idx").on(table.company_id, table.scope_kind, table.scope_ref),
    index("governance_asset_company_type_idx").on(table.company_id, table.type, table.created_at),
  ],
)

export const GovernanceAssetSelectionTable = sqliteTable(
  "governance_asset_selection",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    asset_id: text().notNull(),
    asset_version: integer().notNull(),
    previous_version: integer(),
    selected_by: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("governance_asset_selection_version_idx").on(table.asset_id, table.asset_version),
    index("governance_asset_selection_current_idx").on(table.company_id, table.asset_id, table.created_at),
  ],
)

export const FounderTwinSnapshotTable = sqliteTable(
  "founder_twin_snapshot",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    profile_summary: text().notNull(),
    asset_refs_json: text().notNull(),
    active_principle_ids_json: text().notNull().default("[]"),
    active_heuristic_ids_json: text().notNull().default("[]"),
    decision_case_ids_json: text().notNull().default("[]"),
    taste_example_ids_json: text().notNull().default("[]"),
    rubric_ids_json: text().notNull().default("[]"),
    prompt_template_version: text().notNull(),
    model_config_ref: text().notNull(),
    retrieval_config_ref: text().notNull(),
    permission_config_ref: text().notNull(),
    compiled_prompt_hash: text().notNull(),
    checksum: text().notNull(),
    created_by: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_twin_snapshot_company_version_idx").on(table.company_id, table.version),
    uniqueIndex("founder_twin_snapshot_checksum_idx").on(table.company_id, table.checksum),
  ],
)

export const FounderTwinSnapshotSelectionTable = sqliteTable(
  "founder_twin_snapshot_selection",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    snapshot_id: text().notNull().references(() => FounderTwinSnapshotTable.id),
    previous_snapshot_id: text(),
    reason: text().notNull(),
    selected_by: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("founder_twin_snapshot_selection_current_idx").on(table.company_id, table.created_at),
  ],
)
