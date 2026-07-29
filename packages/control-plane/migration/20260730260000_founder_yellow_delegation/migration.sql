ALTER TABLE `founder_green_readiness` ADD `w5_observation_status` text NOT NULL DEFAULT 'missing' CHECK (`w5_observation_status` IN ('passed','missing'));
--> statement-breakpoint
ALTER TABLE `founder_green_readiness` ADD `w5_observation_evidence_ref` text;
--> statement-breakpoint
ALTER TABLE `founder_green_readiness` ADD `takeover_fence_status` text NOT NULL DEFAULT 'missing' CHECK (`takeover_fence_status` IN ('passed','missing'));
--> statement-breakpoint
ALTER TABLE `founder_green_readiness` ADD `takeover_fence_evidence_ref` text;
--> statement-breakpoint
ALTER TABLE `founder_green_readiness` ADD `preference_holdout_status` text NOT NULL DEFAULT 'missing' CHECK (`preference_holdout_status` IN ('passed','missing'));
--> statement-breakpoint
ALTER TABLE `founder_green_readiness` ADD `preference_benchmark_report_id` text;
--> statement-breakpoint
ALTER TABLE `founder_green_readiness` ADD `preference_agreement_rate` real;
--> statement-breakpoint
ALTER TABLE `founder_green_readiness` ADD `metric_contract_status` text NOT NULL DEFAULT 'missing' CHECK (`metric_contract_status` IN ('passed','missing'));
--> statement-breakpoint
ALTER TABLE `founder_green_readiness` ADD `metric_contract_evidence_ref` text;
--> statement-breakpoint
ALTER TABLE `founder_green_readiness` ADD `metric_window_days` integer;
--> statement-breakpoint
ALTER TABLE `founder_green_readiness` ADD `metric_sample_contract_met` integer NOT NULL DEFAULT 0 CHECK (`metric_sample_contract_met` IN (0,1));
--> statement-breakpoint
CREATE TABLE `founder_yellow_readiness` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `idempotency_key` text NOT NULL,
  `input_sha256` text NOT NULL CHECK (length(`input_sha256`) = 64),
  `green_readiness_id` text NOT NULL REFERENCES `founder_green_readiness`(`id`),
  `w6_observation_evidence_ref` text NOT NULL,
  `e0_evidence_ref` text NOT NULL,
  `outcome_signal_id` text NOT NULL REFERENCES `company_outcome_signal`(`id`),
  `authorization_event_id` text NOT NULL,
  `confirmed_by` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_yellow_readiness_idempotency_idx` ON `founder_yellow_readiness` (`company_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `founder_yellow_readiness_company_created_idx` ON `founder_yellow_readiness` (`company_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `founder_yellow_checkpoint` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `decision_id` text NOT NULL REFERENCES `founder_decision_record`(`id`),
  `receipt_id` text NOT NULL REFERENCES `company_work_receipt`(`id`),
  `action_type` text NOT NULL,
  `direction_json` text NOT NULL,
  `rollback_handler_id` text NOT NULL,
  `snapshot_json` text NOT NULL,
  `snapshot_sha256` text NOT NULL CHECK (length(`snapshot_sha256`) = 64),
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `founder_yellow_checkpoint_decision_idx` ON `founder_yellow_checkpoint` (`decision_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `founder_yellow_checkpoint_project_idx` ON `founder_yellow_checkpoint` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `founder_yellow_run` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `idempotency_key` text NOT NULL,
  `input_sha256` text NOT NULL CHECK (length(`input_sha256`) = 64),
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `board_thread_id` text NOT NULL,
  `decision_id` text NOT NULL REFERENCES `founder_decision_record`(`id`),
  `receipt_id` text NOT NULL REFERENCES `company_work_receipt`(`id`),
  `action_type` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('blocked','authorized','outcome_pending','completed','failed','rolled_back')),
  `readiness_id` text REFERENCES `founder_yellow_readiness`(`id`),
  `checkpoint_id` text REFERENCES `founder_yellow_checkpoint`(`id`),
  `governance_ref` text,
  `graph_decision_id` text,
  `mutation_id` text,
  `work_item_ids_json` text NOT NULL,
  `receipt_ids_json` text NOT NULL,
  `outcome_ids_json` text NOT NULL,
  `direction_json` text NOT NULL,
  `cost_unit` text NOT NULL CHECK (`cost_unit` = 'receipt'),
  `cost_limit` real NOT NULL CHECK (`cost_limit` > 0),
  `estimated_cost` real NOT NULL CHECK (`estimated_cost` > 0),
  `actual_cost` real NOT NULL CHECK (`actual_cost` >= 0),
  `rollback_handler_id` text,
  `dispatched_at` integer,
  `fail_closed_reasons_json` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_yellow_run_idempotency_idx` ON `founder_yellow_run` (`company_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `founder_yellow_run_decision_idx` ON `founder_yellow_run` (`decision_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `founder_yellow_run_company_status_idx` ON `founder_yellow_run` (`company_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `founder_yellow_dispatch_outbox` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `run_id` text NOT NULL REFERENCES `founder_yellow_run`(`id`) ON DELETE CASCADE,
  `decision_id` text NOT NULL REFERENCES `founder_decision_record`(`id`),
  `receipt_id` text NOT NULL REFERENCES `company_work_receipt`(`id`),
  `checkpoint_id` text NOT NULL REFERENCES `founder_yellow_checkpoint`(`id`),
  `status` text NOT NULL CHECK (`status` IN ('pending','processed','failed')),
  `attempts` integer NOT NULL CHECK (`attempts` >= 0),
  `last_error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_yellow_dispatch_outbox_run_idx` ON `founder_yellow_dispatch_outbox` (`run_id`);
--> statement-breakpoint
CREATE INDEX `founder_yellow_dispatch_outbox_status_idx` ON `founder_yellow_dispatch_outbox` (`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `founder_yellow_event` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `run_id` text REFERENCES `founder_yellow_run`(`id`) ON DELETE CASCADE,
  `decision_id` text REFERENCES `founder_decision_record`(`id`),
  `idempotency_key` text NOT NULL,
  `type` text NOT NULL CHECK (`type` IN ('checkpoint_recorded','authorized','dispatch_started','dispatch_completed','outcome_recorded','override_recorded','circuit_opened','rollback_requested','rollback_completed','rollback_failed','rejected')),
  `actor_kind` text NOT NULL CHECK (`actor_kind` IN ('human','ai_founder','policy_engine','control_plane')),
  `actor_id` text NOT NULL,
  `data_json` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_yellow_event_idempotency_idx` ON `founder_yellow_event` (`company_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `founder_yellow_event_run_created_idx` ON `founder_yellow_event` (`run_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `founder_yellow_event_company_type_idx` ON `founder_yellow_event` (`company_id`,`type`,`created_at`);
--> statement-breakpoint
UPDATE `founder_delegation_policy`
SET
  `budget_limit_json` = '{"unit":"receipt","maximum":1}',
  `reversible` = 1,
  `external_impact` = 0,
  `requires_approval` = 0,
  `allowed_mode` = 'yellow_delegated'
WHERE `action_type` = 'project.goal.propose' AND `scope_type` = 'company';
--> statement-breakpoint
UPDATE `founder_delegation_policy`
SET
  `risk_level` = 'red',
  `reversible` = 0,
  `budget_limit_json` = NULL,
  `requires_approval` = 1,
  `allowed_mode` = 'none'
WHERE `action_type` = 'organization.staffing.propose' AND `scope_type` = 'company';
