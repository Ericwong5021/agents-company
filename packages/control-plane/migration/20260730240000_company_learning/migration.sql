CREATE TABLE `company_belief` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `source_id` text NOT NULL REFERENCES `company_commons_source`(`id`) ON DELETE RESTRICT,
  `statement` text NOT NULL,
  `scope_json` text NOT NULL,
  `applicable_scopes_json` text NOT NULL,
  `inapplicable_scopes_json` text NOT NULL,
  `confidence` real NOT NULL,
  `status` text NOT NULL,
  `action_implications_json` text NOT NULL,
  `created_by` text NOT NULL,
  `approved_by` text,
  `board_decision_id` text REFERENCES `founder_decision_record`(`id`) ON DELETE RESTRICT,
  `review_at` integer,
  `created_at` integer NOT NULL,
  `approved_at` integer,
  `updated_at` integer NOT NULL,
  CONSTRAINT `company_belief_confidence_check` CHECK (`confidence` >= 0 AND `confidence` <= 1),
  CONSTRAINT `company_belief_status_check` CHECK (`status` IN ('candidate','contested','experiment_pending','validated','adopted','rejected','deprecated')),
  CONSTRAINT `company_belief_adoption_check` CHECK (`status` != 'adopted' OR (`approved_by` IS NOT NULL AND `approved_at` IS NOT NULL AND `board_decision_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `company_belief_company_status_idx` ON `company_belief` (`company_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `company_belief_source_idx` ON `company_belief` (`source_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `company_belief_interpretation` (
  `belief_id` text NOT NULL REFERENCES `company_belief`(`id`) ON DELETE CASCADE,
  `interpretation_id` text NOT NULL REFERENCES `company_interpretation`(`id`) ON DELETE RESTRICT,
  `position` text NOT NULL,
  CONSTRAINT `company_belief_interpretation_position_check` CHECK (`position` IN ('supporting','counter','context'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_belief_interpretation_idx` ON `company_belief_interpretation` (`belief_id`,`interpretation_id`);
--> statement-breakpoint
CREATE INDEX `company_belief_interpretation_source_idx` ON `company_belief_interpretation` (`interpretation_id`);
--> statement-breakpoint
CREATE TABLE `company_belief_evidence` (
  `id` text PRIMARY KEY NOT NULL,
  `belief_id` text NOT NULL REFERENCES `company_belief`(`id`) ON DELETE CASCADE,
  `position` text NOT NULL,
  `source_kind` text NOT NULL,
  `source_ref` text NOT NULL,
  `summary` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `company_belief_evidence_position_check` CHECK (`position` IN ('supporting','counter')),
  CONSTRAINT `company_belief_evidence_source_check` CHECK (`source_kind` IN ('interpretation','outcome_signal','artifact','decision','external'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_belief_evidence_ref_idx` ON `company_belief_evidence` (`belief_id`,`position`,`source_kind`,`source_ref`);
--> statement-breakpoint
CREATE INDEX `company_belief_evidence_belief_idx` ON `company_belief_evidence` (`belief_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `company_experiment` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `belief_id` text NOT NULL REFERENCES `company_belief`(`id`) ON DELETE RESTRICT,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE RESTRICT,
  `decision_id` text NOT NULL REFERENCES `founder_decision_record`(`id`) ON DELETE RESTRICT,
  `idempotency_key` text NOT NULL,
  `decision_intent_json` text NOT NULL,
  `hypothesis` text NOT NULL,
  `success_criteria_json` text NOT NULL,
  `failure_criteria_json` text NOT NULL,
  `rollback_plan` text NOT NULL,
  `status` text NOT NULL,
  `verdict` text NOT NULL,
  `authority_class` text NOT NULL,
  `approval_gate_id` text,
  `proposed_by` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `completed_at` integer,
  `evaluated_at` integer,
  CONSTRAINT `company_experiment_status_check` CHECK (`status` IN ('proposed','authorized','running','completed','evaluated','rejected','stopped')),
  CONSTRAINT `company_experiment_verdict_check` CHECK (`verdict` IN ('pending','supported','refuted','inconclusive')),
  CONSTRAINT `company_experiment_result_check` CHECK (`status` != 'completed' OR `verdict` = 'pending')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_experiment_idempotency_idx` ON `company_experiment` (`company_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `company_experiment_belief_idx` ON `company_experiment` (`belief_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `company_experiment_project_idx` ON `company_experiment` (`project_id`,`status`);
--> statement-breakpoint
CREATE TABLE `company_experiment_outcome` (
  `experiment_id` text NOT NULL REFERENCES `company_experiment`(`id`) ON DELETE CASCADE,
  `outcome_signal_id` text NOT NULL REFERENCES `company_outcome_signal`(`id`) ON DELETE RESTRICT,
  `linked_by` text NOT NULL,
  `linked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_experiment_outcome_idx` ON `company_experiment_outcome` (`experiment_id`,`outcome_signal_id`);
--> statement-breakpoint
CREATE INDEX `company_experiment_outcome_signal_idx` ON `company_experiment_outcome` (`outcome_signal_id`);
--> statement-breakpoint
CREATE TABLE `company_learning_patch` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `source_decision_id` text NOT NULL REFERENCES `founder_decision_record`(`id`) ON DELETE RESTRICT,
  `source_experiment_id` text NOT NULL REFERENCES `company_experiment`(`id`) ON DELETE RESTRICT,
  `source_outcome_id` text NOT NULL REFERENCES `company_outcome_signal`(`id`) ON DELETE RESTRICT,
  `target_type` text NOT NULL,
  `target_id` text NOT NULL,
  `proposed_diff_json` text NOT NULL,
  `evidence_json` text NOT NULL,
  `expected_impact` text NOT NULL,
  `benchmark_plan` text NOT NULL,
  `rollback_plan` text NOT NULL,
  `status` text NOT NULL,
  `authority_class` text NOT NULL,
  `approval_gate_id` text,
  `created_by` text NOT NULL,
  `approved_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `company_learning_patch_target_check` CHECK (`target_type` IN ('governance_asset','delegation_policy','skill','benchmark','agent_interest','workflow')),
  CONSTRAINT `company_learning_patch_status_check` CHECK (`status` IN ('proposed','approved','canary','active','rejected','rolled_back'))
);
--> statement-breakpoint
CREATE INDEX `company_learning_patch_company_status_idx` ON `company_learning_patch` (`company_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `company_learning_patch_target_idx` ON `company_learning_patch` (`target_type`,`target_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `company_patch_benchmark` (
  `id` text PRIMARY KEY NOT NULL,
  `patch_id` text NOT NULL REFERENCES `company_learning_patch`(`id`) ON DELETE CASCADE,
  `version` integer NOT NULL,
  `holdout_manifest_json` text NOT NULL,
  `holdout_sha256` text NOT NULL,
  `frozen_at` integer NOT NULL,
  `author_id` text NOT NULL,
  `subject_id` text,
  `reviewer_id` text NOT NULL,
  `result` text NOT NULL,
  `evidence_refs_json` text NOT NULL,
  `real_sample_count` integer NOT NULL,
  `reviewed_at` integer NOT NULL,
  CONSTRAINT `company_patch_benchmark_result_check` CHECK (`result` IN ('passed','failed','not_confirmed')),
  CONSTRAINT `company_patch_benchmark_sample_check` CHECK (`real_sample_count` >= 0),
  CONSTRAINT `company_patch_benchmark_reviewer_check` CHECK (`reviewer_id` != `author_id` AND (`subject_id` IS NULL OR `reviewer_id` != `subject_id`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_patch_benchmark_version_idx` ON `company_patch_benchmark` (`patch_id`,`version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_patch_benchmark_holdout_idx` ON `company_patch_benchmark` (`patch_id`,`holdout_sha256`);
--> statement-breakpoint
CREATE TABLE `company_patch_canary` (
  `id` text PRIMARY KEY NOT NULL,
  `patch_id` text NOT NULL REFERENCES `company_learning_patch`(`id`) ON DELETE CASCADE,
  `previous_version_ref` text NOT NULL,
  `candidate_version_ref` text NOT NULL,
  `status` text NOT NULL,
  `metric_evidence_refs_json` text NOT NULL,
  `started_at` integer NOT NULL,
  `finished_at` integer,
  CONSTRAINT `company_patch_canary_status_check` CHECK (`status` IN ('running','passed','failed','rolled_back','not_confirmed'))
);
--> statement-breakpoint
CREATE INDEX `company_patch_canary_patch_idx` ON `company_patch_canary` (`patch_id`,`started_at`);
--> statement-breakpoint
CREATE TABLE `company_patch_event` (
  `id` text PRIMARY KEY NOT NULL,
  `patch_id` text NOT NULL REFERENCES `company_learning_patch`(`id`) ON DELETE CASCADE,
  `type` text NOT NULL,
  `actor_id` text NOT NULL,
  `data_json` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `company_patch_event_patch_idx` ON `company_patch_event` (`patch_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `company_patch_target_version` (
  `id` text PRIMARY KEY NOT NULL,
  `patch_id` text NOT NULL REFERENCES `company_learning_patch`(`id`) ON DELETE RESTRICT,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `target_type` text NOT NULL,
  `target_id` text NOT NULL,
  `version` integer NOT NULL,
  `payload_json` text NOT NULL,
  `previous_version_ref` text,
  `status` text NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `company_patch_target_version_status_check` CHECK (`status` IN ('candidate','active','superseded','rolled_back'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_patch_target_version_idx` ON `company_patch_target_version` (`company_id`,`target_type`,`target_id`,`version`);
--> statement-breakpoint
CREATE INDEX `company_patch_target_current_idx` ON `company_patch_target_version` (`company_id`,`target_type`,`target_id`,`status`);
--> statement-breakpoint
CREATE TABLE `company_skill_candidate_snapshot` (
  `id` text PRIMARY KEY NOT NULL,
  `patch_id` text NOT NULL REFERENCES `company_learning_patch`(`id`) ON DELETE RESTRICT,
  `skill_id` text NOT NULL,
  `runtime_snapshot_id` text NOT NULL REFERENCES `skill_snapshot`(`id`) ON DELETE RESTRICT,
  `version` integer NOT NULL,
  `checksum` text NOT NULL,
  `payload_json` text NOT NULL,
  `status` text NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `company_skill_candidate_status_check` CHECK (`status` IN ('candidate','canary','active','superseded','rolled_back'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_skill_candidate_version_idx` ON `company_skill_candidate_snapshot` (`skill_id`,`version`);
--> statement-breakpoint
CREATE INDEX `company_skill_candidate_patch_idx` ON `company_skill_candidate_snapshot` (`patch_id`,`created_at`);
