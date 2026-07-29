import { sql } from "drizzle-orm"
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CompanyTable } from "@/company/company.sql"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import {
  CompanyProjectTable,
  CompanyWorkItemTable,
} from "@/company-project/company-project.sql"
import {
  CompanyCommonsChunkTable,
  CompanyCommonsSourceTable,
} from "@/company-commons/company-commons.sql"

export const CompanyInterpretationTable = sqliteTable(
  "company_interpretation",
  {
    id: text().primaryKey(),
    source_id: text().notNull().references(() => CompanyCommonsSourceTable.id, { onDelete: "cascade" }),
    reader_agent_id: text().notNull(),
    reader_role: text().notNull(),
    work_item_id: text().references(() => CompanyWorkItemTable.id, { onDelete: "set null" }),
    core_thesis: text().notNull(),
    important_claims_json: text().notNull(),
    company_relevance: text().notNull(),
    project_connections_json: text().notNull(),
    agreement: text().notNull(),
    conflicts_json: text().notNull(),
    counter_arguments_json: text().notNull(),
    inspiration_json: text().notNull(),
    experiment_ideas_json: text().notNull(),
    disposition: text().notNull(),
    confidence: real().notNull(),
    evidence_refs_json: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("company_interpretation_source_agent_idx").on(table.source_id, table.reader_agent_id),
    index("company_interpretation_work_item_idx").on(table.work_item_id),
    check("company_interpretation_agreement_check", sql`${table.agreement} IN ('aligned','conflicted','mixed','unknown')`),
    check("company_interpretation_disposition_check", sql`${table.disposition} IN ('archive','candidate','reject')`),
    check("company_interpretation_confidence_check", sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`),
  ],
)

export const CompanyAgentInterestProfileTable = sqliteTable(
  "company_agent_interest_profile",
  {
    agent_id: text().primaryKey().references(() => CompanyAgentTable.id, { onDelete: "cascade" }),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    topics_json: text().notNull(),
    preferred_lenses_json: text().notNull(),
    excluded_topics_json: text().notNull(),
    novelty_threshold: real().notNull(),
    weekly_reading_budget: integer().notNull(),
    max_concurrency: integer().notNull(),
    privacy_scopes_json: text().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("company_agent_interest_company_idx").on(table.company_id, table.updated_at),
    check("company_agent_interest_novelty_check", sql`${table.novelty_threshold} >= 0 AND ${table.novelty_threshold} <= 1`),
    check("company_agent_interest_budget_check", sql`${table.weekly_reading_budget} >= 0`),
    check("company_agent_interest_concurrency_check", sql`${table.max_concurrency} >= 1 AND ${table.max_concurrency} <= 3`),
  ],
)

export const CompanyReadingAssignmentTable = sqliteTable(
  "company_reading_assignment",
  {
    id: text().primaryKey(),
    source_id: text().notNull().references(() => CompanyCommonsSourceTable.id, { onDelete: "cascade" }),
    company_id: text().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
    agent_id: text().notNull().references(() => CompanyAgentTable.id, { onDelete: "cascade" }),
    project_id: text().notNull().references(() => CompanyProjectTable.id, { onDelete: "cascade" }),
    linked_project_ids_json: text().notNull(),
    work_item_id: text().references(() => CompanyWorkItemTable.id, { onDelete: "set null" }),
    idempotency_key: text().notNull(),
    status: text().notNull(),
    relevance_score: real().notNull(),
    novelty_score: real().notNull(),
    gap_score: real().notNull(),
    budget_score: real().notNull(),
    total_score: real().notNull(),
    budget_week: text().notNull(),
    budget_reserved: integer({ mode: "boolean" }).notNull(),
    error: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    stopped_at: integer(),
  },
  (table) => [
    uniqueIndex("company_reading_assignment_idempotency_idx").on(table.idempotency_key),
    uniqueIndex("company_reading_assignment_source_agent_idx").on(table.source_id, table.agent_id),
    index("company_reading_assignment_agent_budget_idx").on(table.agent_id, table.budget_week, table.budget_reserved),
    index("company_reading_assignment_project_status_idx").on(table.project_id, table.status),
    check("company_reading_assignment_status_check", sql`${table.status} IN ('scheduling','scheduled','running','completed','failed','stopped')`),
  ],
)

export const CompanyInterpretationEvidenceTable = sqliteTable(
  "company_interpretation_evidence",
  {
    interpretation_id: text().notNull().references(() => CompanyInterpretationTable.id, { onDelete: "cascade" }),
    chunk_id: text().notNull().references(() => CompanyCommonsChunkTable.id, { onDelete: "restrict" }),
    start_offset: integer().notNull(),
    end_offset: integer().notNull(),
    claim: text().notNull(),
  },
  (table) => [
    uniqueIndex("company_interpretation_evidence_idx").on(
      table.interpretation_id,
      table.chunk_id,
      table.start_offset,
      table.end_offset,
    ),
    index("company_interpretation_evidence_chunk_idx").on(table.chunk_id),
    check("company_interpretation_evidence_span_check", sql`${table.start_offset} >= 0 AND ${table.end_offset} > ${table.start_offset}`),
  ],
)
