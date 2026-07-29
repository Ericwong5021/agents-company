import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CompanyProjectTable } from "@/company-project/company-project.sql"

export const CompanyGateObservationTable = sqliteTable(
  "company_gate_observation",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    paired_project_id: text().references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    candidate_sha: text().notNull(),
    scenario_id: text().notNull(),
    run_id: text().notNull(),
    strategy: text().notNull(),
    snapshot_sha256: text().notNull(),
    event_type: text().notNull(),
    properties_json: text().notNull(),
    source_refs_json: text().notNull(),
    evidence_json: text().notNull(),
    producer_path: text().notNull(),
    producer_sha256: text().notNull(),
    input_sha256: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("company_gate_observation_run_event_idx").on(table.run_id, table.event_type),
    index("company_gate_observation_project_idx").on(table.project_id, table.created_at),
    index("company_gate_observation_candidate_idx").on(
      table.candidate_sha,
      table.scenario_id,
      table.strategy,
    ),
  ],
)
