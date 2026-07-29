CREATE TABLE `founder_decision_record` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL,
  `scope_type` text NOT NULL,
  `project_id` text,
  `pre_project_id` text,
  `idempotency_key` text NOT NULL,
  `input_sha256` text NOT NULL,
  `source_completeness` text NOT NULL,
  `founder_snapshot_id` text,
  `founder_snapshot_version` integer,
  `subject` text,
  `context` text,
  `options_json` text,
  `recommendation` text,
  `final_decision` text,
  `decision_maker` text NOT NULL,
  `decision_maker_id` text NOT NULL,
  `authority_class` text,
  `operating_mode` text,
  `confidence` real,
  `reversible` integer,
  `external_impact` integer,
  `risk_level` text,
  `evidence_refs_json` text,
  `principle_refs_json` text,
  `decision_case_refs_json` text,
  `override_of` text,
  `created_at` integer NOT NULL,
  `decided_at` integer,
  FOREIGN KEY (`company_id`) REFERENCES `company`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `founder_decision_record_scope_check` CHECK (
    (`scope_type` = 'company' AND `project_id` IS NULL AND `pre_project_id` IS NULL)
    OR (`scope_type` = 'project' AND `project_id` IS NOT NULL AND `pre_project_id` IS NULL)
    OR (`scope_type` = 'pre_project' AND `project_id` IS NULL AND `pre_project_id` IS NOT NULL)
  ),
  CONSTRAINT `founder_decision_record_snapshot_pair_check` CHECK (
    (`founder_snapshot_id` IS NULL) = (`founder_snapshot_version` IS NULL)
  ),
  CONSTRAINT `founder_decision_record_ai_snapshot_check` CHECK (
    `decision_maker` != 'ai_founder' OR `founder_snapshot_id` IS NOT NULL
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_decision_record_idempotency_idx` ON `founder_decision_record` (`company_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `founder_decision_record_scope_idx` ON `founder_decision_record` (`company_id`,`scope_type`,`project_id`);
--> statement-breakpoint
CREATE INDEX `founder_decision_record_pre_project_idx` ON `founder_decision_record` (`company_id`,`pre_project_id`);
--> statement-breakpoint
CREATE TABLE `founder_decision_transition` (
  `id` text PRIMARY KEY NOT NULL,
  `decision_id` text NOT NULL,
  `sequence` integer NOT NULL,
  `idempotency_key` text NOT NULL,
  `input_sha256` text NOT NULL,
  `from_status` text,
  `to_status` text NOT NULL,
  `kind` text NOT NULL,
  `reason` text NOT NULL,
  `actor_id` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`decision_id`) REFERENCES `founder_decision_record`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_decision_transition_sequence_idx` ON `founder_decision_transition` (`decision_id`,`sequence`);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_decision_transition_idempotency_idx` ON `founder_decision_transition` (`decision_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `founder_decision_transition_time_idx` ON `founder_decision_transition` (`decision_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `founder_decision_current` (
  `decision_id` text PRIMARY KEY NOT NULL,
  `current_status` text NOT NULL,
  `latest_transition_id` text NOT NULL,
  `transition_count` integer NOT NULL,
  `outcome_ref_ids_json` text DEFAULT '[]' NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`decision_id`) REFERENCES `founder_decision_record`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`latest_transition_id`) REFERENCES `founder_decision_transition`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `founder_decision_source` (
  `decision_id` text PRIMARY KEY NOT NULL,
  `channel_message_id` text,
  `board_thread_id` text,
  `board_run_id` text,
  `runtime_id` text,
  `source_completeness` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`decision_id`) REFERENCES `founder_decision_record`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_decision_source_message_idx` ON `founder_decision_source` (`channel_message_id`) WHERE `channel_message_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `founder_decision_source_thread_run_idx` ON `founder_decision_source` (`board_thread_id`,`board_run_id`);
--> statement-breakpoint
CREATE TABLE `founder_delegation_policy` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL,
  `action_type` text NOT NULL,
  `risk_level` text NOT NULL,
  `reversible` integer NOT NULL,
  `external_impact` integer NOT NULL,
  `budget_limit_json` text,
  `requires_approval` integer NOT NULL,
  `allowed_mode` text NOT NULL,
  `version` integer NOT NULL,
  `scope_type` text NOT NULL,
  `scope_key` text NOT NULL,
  `project_id` text,
  `pre_project_id` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`company_id`) REFERENCES `company`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `founder_delegation_policy_scope_check` CHECK (
    (`scope_type` = 'company' AND `project_id` IS NULL AND `pre_project_id` IS NULL)
    OR (`scope_type` = 'project' AND `project_id` IS NOT NULL AND `pre_project_id` IS NULL)
    OR (`scope_type` = 'pre_project' AND `project_id` IS NULL AND `pre_project_id` IS NOT NULL)
  ),
  CONSTRAINT `founder_delegation_policy_red_check` CHECK (
    `risk_level` != 'red' OR (`requires_approval` = 1 AND `allowed_mode` = 'none')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_delegation_policy_version_idx` ON `founder_delegation_policy` (`company_id`,`action_type`,`scope_key`,`version`);
--> statement-breakpoint
CREATE INDEX `founder_delegation_policy_scope_idx` ON `founder_delegation_policy` (`company_id`,`scope_type`,`action_type`);
