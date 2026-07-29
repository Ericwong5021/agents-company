import type { CompanyCommonsMode, FounderTwinMode } from "@agents-company/shared/founder-os"
import { sql } from "drizzle-orm"
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { ModelID, ProviderID } from "@/provider/schema"
import type { ProjectID } from "@/project/schema"
import { ProjectTable } from "@/project/project.sql"
import { Timestamps } from "@/storage/schema.sql"
import type { ApprovalPreset, CompanyID } from "./schema"

export const CompanyTable = sqliteTable(
  "company",
  {
    id: text().$type<CompanyID>().primaryKey(),
    name: text().notNull(),
    data_version: integer().notNull(),
    default_provider_id: text().$type<ProviderID>().notNull(),
    default_model_id: text().$type<ModelID>().notNull(),
    bootstrap_request_id: text().notNull(),
    bootstrap_input_path: text().notNull(),
    founder_twin_mode: text().$type<FounderTwinMode>().notNull().default("off"),
    company_commons_mode: text().$type<CompanyCommonsMode>().notNull().default("off"),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("company_bootstrap_request_idx").on(table.bootstrap_request_id),
    check(
      "company_founder_twin_mode_check",
      sql`${table.founder_twin_mode} IN ('off', 'shadow', 'advisor', 'green-delegated', 'yellow-delegated')`,
    ),
    check(
      "company_commons_mode_check",
      sql`${table.company_commons_mode} IN ('off', 'ingest-only', 'reading', 'belief-loop')`,
    ),
  ],
)

export const ApprovalPolicyTable = sqliteTable("approval_policy", {
  company_id: text()
    .$type<CompanyID>()
    .primaryKey()
    .references(() => CompanyTable.id, { onDelete: "cascade" }),
  preset: text().$type<ApprovalPreset>().notNull(),
  ...Timestamps,
})

export const RepositoryBindingTable = sqliteTable(
  "repository_binding",
  {
    id: text().primaryKey(),
    company_id: text()
      .$type<CompanyID>()
      .notNull()
      .references(() => CompanyTable.id, { onDelete: "cascade" }),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id),
    root_path: text().notNull(),
    default_branch: text().notNull(),
    bootstrap_head_commit: text(),
    bootstrap_dirty: integer({ mode: "boolean" }).notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("repository_binding_company_idx").on(table.company_id),
    uniqueIndex("repository_binding_project_idx").on(table.project_id),
  ],
)

export const CompanySetupGoalTable = sqliteTable("company_setup_goal", {
  company_id: text()
    .$type<CompanyID>()
    .primaryKey()
    .references(() => CompanyTable.id, { onDelete: "cascade" }),
  body: text().notNull(),
  ...Timestamps,
})
