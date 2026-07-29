CREATE TABLE `company_rollout_state` (
  `id` text PRIMARY KEY NOT NULL CHECK (`id` = 'seed_and_grow'),
  `phase` text NOT NULL CHECK (`phase` IN ('off', 'shadow', 'opt_in', 'dogfood_default', 'pre_public_default')),
  `version` integer NOT NULL CHECK (`version` > 0),
  `last_transition_id` text,
  `updated_at` integer NOT NULL CHECK (`updated_at` >= 0)
);
--> statement-breakpoint
INSERT INTO `company_rollout_state` (
  `id`,
  `phase`,
  `version`,
  `last_transition_id`,
  `updated_at`
) VALUES ('seed_and_grow', 'off', 1, NULL, 0);
--> statement-breakpoint
CREATE TABLE `company_rollout_journal` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('transition', 'action')),
  `action_kind` text CHECK (`action_kind` IS NULL OR `action_kind` IN ('register_candidate', 'record_local_repeat', 'record_rollback')),
  `idempotency_key` text NOT NULL,
  `payload_sha256` text NOT NULL CHECK (length(`payload_sha256`) = 64 AND `payload_sha256` NOT GLOB '*[^0-9a-f]*'),
  `payload_json` text NOT NULL,
  `result_ref_id` text NOT NULL,
  `result_json` text NOT NULL,
  `created_at` integer NOT NULL CHECK (`created_at` >= 0),
  CHECK (
    (`kind` = 'transition' AND `action_kind` IS NULL) OR
    (`kind` = 'action' AND `action_kind` IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_rollout_journal_idempotency_idx`
ON `company_rollout_journal` (`kind`, `idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_rollout_journal_action_ref_idx`
ON `company_rollout_journal` (`action_kind`, `result_ref_id`);
--> statement-breakpoint
CREATE INDEX `company_rollout_journal_created_idx`
ON `company_rollout_journal` (`created_at`);
--> statement-breakpoint
CREATE TABLE `company_rollout_candidate` (
  `id` text PRIMARY KEY NOT NULL,
  `candidate_sha` text NOT NULL CHECK (length(`candidate_sha`) = 40 AND `candidate_sha` NOT GLOB '*[^0-9a-f]*'),
  `target_ref` text NOT NULL,
  `registered_at` integer NOT NULL CHECK (`registered_at` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_rollout_candidate_sha_idx`
ON `company_rollout_candidate` (`candidate_sha`);
--> statement-breakpoint
CREATE INDEX `company_rollout_candidate_registered_idx`
ON `company_rollout_candidate` (`registered_at`);
--> statement-breakpoint
CREATE TABLE `company_rollout_local_repeat` (
  `id` text PRIMARY KEY NOT NULL,
  `candidate_id` text NOT NULL,
  `run_id` text NOT NULL,
  `ordinal` integer NOT NULL CHECK (`ordinal` IN (1, 2)),
  `outcome` text NOT NULL CHECK (`outcome` IN ('completed', 'failed', 'blocked', 'invalid')),
  `environment_sha256` text NOT NULL CHECK (length(`environment_sha256`) = 64 AND `environment_sha256` NOT GLOB '*[^0-9a-f]*'),
  `evidence_sha256` text NOT NULL CHECK (length(`evidence_sha256`) = 64 AND `evidence_sha256` NOT GLOB '*[^0-9a-f]*'),
  `normalized_result_sha256` text CHECK (`normalized_result_sha256` IS NULL OR (length(`normalized_result_sha256`) = 64 AND `normalized_result_sha256` NOT GLOB '*[^0-9a-f]*')),
  `started_at` integer NOT NULL CHECK (`started_at` >= 0),
  `finished_at` integer NOT NULL CHECK (`finished_at` >= `started_at`),
  `recorded_at` integer NOT NULL CHECK (`recorded_at` >= 0),
  CHECK (`outcome` != 'completed' OR `normalized_result_sha256` IS NOT NULL),
  FOREIGN KEY (`candidate_id`) REFERENCES `company_rollout_candidate`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_rollout_local_repeat_candidate_ordinal_idx`
ON `company_rollout_local_repeat` (`candidate_id`, `ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_rollout_local_repeat_run_idx`
ON `company_rollout_local_repeat` (`run_id`);
--> statement-breakpoint
CREATE INDEX `company_rollout_local_repeat_recorded_idx`
ON `company_rollout_local_repeat` (`recorded_at`);
--> statement-breakpoint
CREATE TABLE `company_rollout_rollback` (
  `id` text PRIMARY KEY NOT NULL,
  `candidate_id` text,
  `project_id` text,
  `target` text NOT NULL CHECK (`target` IN ('kill_switch', 'legacy_fallback')),
  `phase_at_action` text NOT NULL CHECK (`phase_at_action` IN ('off', 'shadow', 'opt_in', 'dogfood_default', 'pre_public_default')),
  `execution_mode_after` text NOT NULL CHECK (`execution_mode_after` IN ('off', 'shadow', 'active')),
  `outcome` text NOT NULL CHECK (`outcome` IN ('completed', 'failed', 'blocked', 'invalid')),
  `evidence_sha256` text NOT NULL CHECK (length(`evidence_sha256`) = 64 AND `evidence_sha256` NOT GLOB '*[^0-9a-f]*'),
  `observed_at` integer NOT NULL CHECK (`observed_at` >= 0),
  `recorded_at` integer NOT NULL CHECK (`recorded_at` >= 0),
  CHECK (`target` != 'kill_switch' OR `execution_mode_after` = 'off'),
  FOREIGN KEY (`candidate_id`) REFERENCES `company_rollout_candidate`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`project_id`) REFERENCES `company_project`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `company_rollout_rollback_candidate_idx`
ON `company_rollout_rollback` (`candidate_id`);
--> statement-breakpoint
CREATE INDEX `company_rollout_rollback_project_idx`
ON `company_rollout_rollback` (`project_id`);
--> statement-breakpoint
CREATE INDEX `company_rollout_rollback_recorded_idx`
ON `company_rollout_rollback` (`recorded_at`);
