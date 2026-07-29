CREATE TABLE `founder_shadow_decision` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `status` text NOT NULL CHECK (`status` IN ('suggested','blocked')),
  `block_reasons_json` text NOT NULL,
  `scope_kind` text NOT NULL CHECK (`scope_kind` IN ('company','domain','project','brand')),
  `scope_ref` text,
  `snapshot_id` text REFERENCES `founder_twin_snapshot`(`id`),
  `snapshot_checksum` text,
  `model_config_ref` text NOT NULL,
  `recommendation` text,
  `alternatives_json` text NOT NULL,
  `authority_class` text CHECK (`authority_class` IN ('green','yellow','red')),
  `confidence` integer CHECK (`confidence` IS NULL OR (`confidence` >= 0 AND `confidence` <= 1000000)),
  `principle_refs_json` text NOT NULL,
  `decision_case_refs_json` text NOT NULL,
  `taste_example_refs_json` text NOT NULL,
  `rubric_refs_json` text NOT NULL,
  `evidence_refs_json` text NOT NULL,
  `missing_information_json` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  CHECK ((`scope_kind` = 'company' AND `scope_ref` IS NULL) OR (`scope_kind` <> 'company' AND `scope_ref` IS NOT NULL)),
  CHECK ((`status` = 'suggested' AND `recommendation` IS NOT NULL AND `authority_class` IS NOT NULL AND `confidence` IS NOT NULL AND `snapshot_id` IS NOT NULL AND `snapshot_checksum` IS NOT NULL) OR (`status` = 'blocked' AND `recommendation` IS NULL AND `authority_class` IS NULL AND `confidence` IS NULL))
);
--> statement-breakpoint
CREATE INDEX `founder_shadow_decision_company_created_idx` ON `founder_shadow_decision` (`company_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `founder_shadow_decision_snapshot_idx` ON `founder_shadow_decision` (`snapshot_id`);
--> statement-breakpoint
CREATE TABLE `founder_shadow_comparison` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `shadow_decision_id` text NOT NULL REFERENCES `founder_shadow_decision`(`id`),
  `actual_decision` text NOT NULL,
  `actual_decision_ref_json` text NOT NULL,
  `alignment` text NOT NULL CHECK (`alignment` IN ('match','partial','mismatch')),
  `rationale` text NOT NULL,
  `verification_status` text NOT NULL CHECK (`verification_status` IN ('not_confirmed','human_confirmed')),
  `confirmed_by` text,
  `confirmation_event_id` text,
  `compared_by` text NOT NULL,
  `created_at` integer NOT NULL,
  CHECK ((`verification_status` = 'not_confirmed' AND `confirmed_by` IS NULL AND `confirmation_event_id` IS NULL) OR (`verification_status` = 'human_confirmed' AND `confirmed_by` IS NOT NULL AND `confirmation_event_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `founder_shadow_comparison_company_created_idx` ON `founder_shadow_comparison` (`company_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_shadow_comparison_decision_source_idx` ON `founder_shadow_comparison` (`shadow_decision_id`,`actual_decision_ref_json`);
--> statement-breakpoint
CREATE TABLE `founder_calibration_request` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL CHECK (`kind` IN ('ab','accept','reject')),
  `scope_kind` text NOT NULL CHECK (`scope_kind` IN ('company','domain','project','brand')),
  `scope_ref` text,
  `prompt` text NOT NULL,
  `candidates_json` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  CHECK ((`scope_kind` = 'company' AND `scope_ref` IS NULL) OR (`scope_kind` <> 'company' AND `scope_ref` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `founder_calibration_request_company_created_idx` ON `founder_calibration_request` (`company_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `founder_calibration_response` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `request_id` text NOT NULL REFERENCES `founder_calibration_request`(`id`),
  `response` text NOT NULL CHECK (`response` IN ('accept','reject','prefer_first','prefer_second')),
  `reason` text NOT NULL,
  `confirmation_event_id` text NOT NULL,
  `confirmed_by` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_calibration_response_request_idx` ON `founder_calibration_response` (`request_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_calibration_response_confirmation_idx` ON `founder_calibration_response` (`confirmation_event_id`);
--> statement-breakpoint
CREATE TABLE `founder_benchmark_case` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `benchmark_type` text NOT NULL CHECK (`benchmark_type` IN ('founder_decision','taste')),
  `dataset_version` text NOT NULL,
  `split` text NOT NULL CHECK (`split` IN ('training','holdout')),
  `source_asset_id` text NOT NULL,
  `source_asset_version` integer NOT NULL,
  `expected_json` text NOT NULL,
  `confirmation_event_id` text NOT NULL,
  `confirmed_by` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`source_asset_id`,`source_asset_version`) REFERENCES `governance_asset`(`id`,`version`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_benchmark_case_dataset_asset_idx` ON `founder_benchmark_case` (`company_id`,`benchmark_type`,`dataset_version`,`source_asset_id`,`source_asset_version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_benchmark_case_confirmation_idx` ON `founder_benchmark_case` (`confirmation_event_id`);
--> statement-breakpoint
CREATE INDEX `founder_benchmark_case_split_idx` ON `founder_benchmark_case` (`company_id`,`benchmark_type`,`dataset_version`,`split`);
--> statement-breakpoint
CREATE TABLE `founder_benchmark_report` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `benchmark_type` text NOT NULL CHECK (`benchmark_type` IN ('founder_decision','taste')),
  `dataset_version` text NOT NULL,
  `snapshot_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('pass','fail','blocked')),
  `block_reasons_json` text NOT NULL,
  `metrics_json` text NOT NULL,
  `confirmed_sample_count` integer NOT NULL CHECK (`confirmed_sample_count` >= 0),
  `input_checksum` text NOT NULL CHECK (length(`input_checksum`) = 64),
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_benchmark_report_input_idx` ON `founder_benchmark_report` (`company_id`,`benchmark_type`,`dataset_version`,`snapshot_id`,`input_checksum`);
--> statement-breakpoint
CREATE INDEX `founder_benchmark_report_company_created_idx` ON `founder_benchmark_report` (`company_id`,`created_at`);
