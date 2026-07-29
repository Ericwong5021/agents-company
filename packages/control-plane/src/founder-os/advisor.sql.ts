import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CompanyTable } from "@/company/company.sql"
import { DecisionRecordTable } from "./decision-ledger.sql"

export const FounderAdvisorConvergenceTable = sqliteTable(
  "founder_advisor_convergence",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    idempotency_key: text().notNull(),
    input_sha256: text().notNull(),
    board_thread_id: text().notNull(),
    board_run_id: text(),
    channel_message_id: text().notNull(),
    shadow_decision_id: text().notNull(),
    status: text().notNull(),
    decision_intent_json: text(),
    ledger_decision_id: text().references(() => DecisionRecordTable.id),
    authority_status: text().notNull(),
    authority_reason: text().notNull(),
    governance_ref: text(),
    reversible: integer({ mode: "boolean" }),
    external_impact: integer({ mode: "boolean" }),
    risk_level: text(),
    dri_agent_id: text().notNull(),
    timeout_at: integer().notNull(),
    dissent_json: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_advisor_convergence_idempotency_idx").on(table.company_id, table.idempotency_key),
    uniqueIndex("founder_advisor_convergence_source_idx").on(
      table.company_id,
      table.board_thread_id,
      table.channel_message_id,
    ),
    index("founder_advisor_convergence_company_created_idx").on(table.company_id, table.created_at),
  ],
)

export const FounderInterventionTable = sqliteTable(
  "founder_intervention",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    idempotency_key: text().notNull(),
    input_sha256: text().notNull(),
    kind: text().notNull(),
    board_thread_id: text().notNull(),
    project_id: text(),
    decision_id: text(),
    ledger_decision_id: text().notNull().references(() => DecisionRecordTable.id),
    reason: text().notNull(),
    new_goal: text(),
    actor_id: text().notNull(),
    creates_fence: integer({ mode: "boolean" }).notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_intervention_idempotency_idx").on(table.company_id, table.idempotency_key),
    index("founder_intervention_thread_created_idx").on(table.company_id, table.board_thread_id, table.created_at),
    index("founder_intervention_project_created_idx").on(table.project_id, table.created_at),
  ],
)

export const FounderInterventionFenceTable = sqliteTable(
  "founder_intervention_fence",
  {
    id: text().primaryKey(),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    board_thread_id: text().notNull(),
    intervention_id: text().notNull().references(() => FounderInterventionTable.id),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("founder_intervention_fence_thread_idx").on(table.company_id, table.board_thread_id),
  ],
)

export const FounderInterventionEffectTable = sqliteTable(
  "founder_intervention_effect",
  {
    id: text().primaryKey(),
    intervention_id: text().notNull().references(() => FounderInterventionTable.id),
    kind: text().notNull(),
    status: text().notNull(),
    detail: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("founder_intervention_effect_event_idx").on(table.intervention_id, table.created_at),
  ],
)
