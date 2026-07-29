CREATE TABLE `governance_asset` (
  `id` text NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `type` text NOT NULL CHECK (`type` IN ('constitution','principle','heuristic','boundary','taste_reference','taste_anti_reference','rubric','decision_case')),
  `scope_kind` text NOT NULL CHECK (`scope_kind` IN ('company','domain','project','brand')),
  `scope_ref` text,
  `content` text NOT NULL,
  `rationale` text NOT NULL,
  `tags_json` text NOT NULL,
  `authority` text NOT NULL CHECK (`authority` IN ('human_explicit','human_confirmed','ai_proposed','external_source')),
  `status` text NOT NULL CHECK (`status` IN ('draft','active','deprecated')),
  `source_refs_json` text NOT NULL,
  `supersedes_version` integer,
  `version` integer NOT NULL CHECK (`version` > 0),
  `created_by` text NOT NULL,
  `approved_by` text,
  `confirmation_event_id` text,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`id`, `version`),
  CHECK ((`scope_kind` = 'company' AND `scope_ref` IS NULL) OR (`scope_kind` <> 'company' AND `scope_ref` IS NOT NULL)),
  CHECK ((`authority` IN ('ai_proposed','external_source') AND `status` = 'draft' AND `approved_by` IS NULL AND `confirmation_event_id` IS NULL) OR (`authority` IN ('human_explicit','human_confirmed') AND `approved_by` IS NOT NULL AND `confirmation_event_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `governance_asset_company_scope_idx` ON `governance_asset` (`company_id`,`scope_kind`,`scope_ref`);
--> statement-breakpoint
CREATE INDEX `governance_asset_company_type_idx` ON `governance_asset` (`company_id`,`type`,`created_at`);
--> statement-breakpoint
CREATE TABLE `governance_asset_selection` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `asset_id` text NOT NULL,
  `asset_version` integer NOT NULL,
  `previous_version` integer,
  `selected_by` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`asset_id`,`asset_version`) REFERENCES `governance_asset`(`id`,`version`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `governance_asset_selection_version_idx` ON `governance_asset_selection` (`asset_id`,`asset_version`);
--> statement-breakpoint
CREATE INDEX `governance_asset_selection_current_idx` ON `governance_asset_selection` (`company_id`,`asset_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `founder_twin_snapshot` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `version` integer NOT NULL CHECK (`version` > 0),
  `profile_summary` text NOT NULL,
  `asset_refs_json` text NOT NULL,
  `prompt_template_version` text NOT NULL,
  `model_config_ref` text NOT NULL,
  `retrieval_config_ref` text NOT NULL,
  `permission_config_ref` text NOT NULL,
  `compiled_prompt_hash` text NOT NULL CHECK (length(`compiled_prompt_hash`) = 64),
  `checksum` text NOT NULL CHECK (length(`checksum`) = 64),
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_twin_snapshot_company_version_idx` ON `founder_twin_snapshot` (`company_id`,`version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_twin_snapshot_checksum_idx` ON `founder_twin_snapshot` (`company_id`,`checksum`);
--> statement-breakpoint
CREATE TABLE `founder_twin_snapshot_selection` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `snapshot_id` text NOT NULL REFERENCES `founder_twin_snapshot`(`id`),
  `previous_snapshot_id` text,
  `reason` text NOT NULL,
  `selected_by` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `founder_twin_snapshot_selection_current_idx` ON `founder_twin_snapshot_selection` (`company_id`,`created_at`);
