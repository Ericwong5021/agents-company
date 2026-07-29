import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CompanyTable } from "@/company/company.sql"
import {
  CompanyArtifactTable,
  CompanyProjectTable,
} from "@/company-project/company-project.sql"

export const CompanyCommonsSourceTable = sqliteTable(
  "company_commons_source",
  {
    id: text().primaryKey(),
    artifact_id: text()
      .notNull()
      .references(() => CompanyArtifactTable.id, { onDelete: "cascade" }),
    company_id: text()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    project_id: text().references(() => CompanyProjectTable.id, { onDelete: "set null" }),
    private_owner_id: text(),
    source_type: text().notNull(),
    title: text().notNull(),
    author: text(),
    origin: text(),
    published_at: integer(),
    language: text(),
    tags_json: text().notNull(),
    privacy_scope: text().notNull(),
    ingestion_status: text().notNull(),
    transcript_status: text().notNull(),
    content_hash: text(),
    normalized_content_hash: text(),
    duplicate_of_source_id: text(),
    deduplication_kind: text(),
    metadata_json: text().notNull(),
    adapter_id: text(),
    adapter_version: text(),
    error_code: text(),
    error_message: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("company_commons_source_artifact_idx").on(table.artifact_id),
    index("company_commons_source_company_status_idx").on(
      table.company_id,
      table.ingestion_status,
      table.updated_at,
    ),
    index("company_commons_source_project_idx").on(table.project_id, table.updated_at),
    index("company_commons_source_private_idx").on(table.private_owner_id, table.updated_at),
    index("company_commons_source_hash_idx").on(table.company_id, table.content_hash),
    index("company_commons_source_normalized_hash_idx").on(table.company_id, table.normalized_content_hash),
    check(
      "company_commons_source_type_check",
      sql.raw("source_type IN ('text','markdown','url','conversation_export','pdf','image','podcast','video')"),
    ),
    check(
      "company_commons_privacy_scope_check",
      sql.raw("privacy_scope IN ('company','project','private')"),
    ),
    check(
      "company_commons_ingestion_status_check",
      sql.raw("ingestion_status IN ('queued','processing','ready','failed','blocked','unsupported')"),
    ),
    check(
      "company_commons_transcript_status_check",
      sql.raw("transcript_status IN ('not_applicable','queued','processing','ready','failed','blocked','unsupported')"),
    ),
    check(
      "company_commons_deduplication_kind_check",
      sql.raw("deduplication_kind IS NULL OR deduplication_kind IN ('exact','normalized')"),
    ),
    check(
      "company_commons_scope_check",
      sql.raw(`(
        privacy_scope = 'company' AND project_id IS NULL AND private_owner_id IS NULL
      ) OR (
        privacy_scope = 'project' AND project_id IS NOT NULL AND private_owner_id IS NULL
      ) OR (
        privacy_scope = 'private' AND project_id IS NULL AND private_owner_id IS NOT NULL
      )`),
    ),
  ],
)

export const CompanyCommonsChunkTable = sqliteTable(
  "company_commons_chunk",
  {
    id: text().primaryKey(),
    source_id: text()
      .notNull()
      .references(() => CompanyCommonsSourceTable.id, { onDelete: "cascade" }),
    ordinal: integer().notNull(),
    body: text().notNull(),
    content_hash: text().notNull(),
    start_offset: integer().notNull(),
    end_offset: integer().notNull(),
    source_span_json: text().notNull(),
    trust_class: text().notNull().default("untrusted_source"),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("company_commons_chunk_source_ordinal_idx").on(table.source_id, table.ordinal),
    index("company_commons_chunk_source_span_idx").on(table.source_id, table.start_offset, table.end_offset),
    check("company_commons_chunk_span_check", sql`${table.start_offset} >= 0 AND ${table.end_offset} >= ${table.start_offset}`),
    check("company_commons_chunk_trust_check", sql`${table.trust_class} = 'untrusted_source'`),
  ],
)
