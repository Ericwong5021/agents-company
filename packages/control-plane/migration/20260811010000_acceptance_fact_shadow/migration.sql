ALTER TABLE `company_project` ADD COLUMN `dispatch_generation` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD COLUMN `dispatch_claim_id` text;
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD COLUMN `dispatch_claim_generation` integer;
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD COLUMN `dispatch_claimed_at` integer;
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD COLUMN `reviews_work_item_id` text REFERENCES `company_work_item`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD COLUMN `validation_contract_version` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE UNIQUE INDEX `company_work_item_active_reviewer_target_idx`
ON `company_work_item` (`project_id`, `reviews_work_item_id`)
WHERE `kind` = 'reviewer' AND `reviews_work_item_id` IS NOT NULL AND `status` NOT IN ('superseded', 'cancelled');
--> statement-breakpoint
ALTER TABLE `company_work_attempt` ADD COLUMN `base_artifact_id` text REFERENCES `company_artifact`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `company_work_attempt` ADD COLUMN `repair_criterion_ids_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `company_artifact` ADD COLUMN `attempt_id` text REFERENCES `company_work_attempt`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `company_artifact` ADD COLUMN `version` integer;
--> statement-breakpoint
ALTER TABLE `company_artifact` ADD COLUMN `supersedes_artifact_id` text REFERENCES `company_artifact`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `company_artifact` ADD COLUMN `content_sha256` text;
--> statement-breakpoint
ALTER TABLE `company_artifact` ADD COLUMN `materialized_sha256` text;
--> statement-breakpoint
ALTER TABLE `company_artifact` ADD COLUMN `integrity_sha256` text;
--> statement-breakpoint
CREATE INDEX `company_artifact_attempt_idx` ON `company_artifact` (`attempt_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_artifact_work_item_kind_version_idx`
ON `company_artifact` (`work_item_id`, `kind`, `version`)
WHERE `work_item_id` IS NOT NULL AND `version` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `company_validation_gate` ADD COLUMN `attempt_id` text REFERENCES `company_work_attempt`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `company_validation_gate` ADD COLUMN `artifact_id` text REFERENCES `company_artifact`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `company_validation_gate_attempt_artifact_idx`
ON `company_validation_gate` (`attempt_id`, `artifact_id`);
--> statement-breakpoint
CREATE TABLE `company_acceptance_criterion` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `plan_id` text NOT NULL REFERENCES `company_plan`(`id`) ON DELETE CASCADE,
  `work_item_id` text NOT NULL REFERENCES `company_work_item`(`id`) ON DELETE CASCADE,
  `ordinal` integer NOT NULL,
  `statement` text NOT NULL,
  `statement_sha256` text NOT NULL,
  `verification_kind` text NOT NULL,
  `required_authority` text,
  `evaluator` text,
  `required` integer NOT NULL DEFAULT 1,
  `created_at` integer NOT NULL,
  CONSTRAINT `company_acceptance_criterion_ordinal_check` CHECK (`ordinal` > 0),
  CONSTRAINT `company_acceptance_criterion_kind_check` CHECK (`verification_kind` IN ('legacy_unscoped', 'deterministic', 'semantic_review', 'human')),
  CONSTRAINT `company_acceptance_criterion_authority_check` CHECK (`required_authority` IS NULL OR `required_authority` IN ('control_plane', 'independent_reviewer', 'human'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_acceptance_criterion_item_ordinal_idx`
ON `company_acceptance_criterion` (`work_item_id`, `ordinal`);
--> statement-breakpoint
CREATE INDEX `company_acceptance_criterion_project_idx`
ON `company_acceptance_criterion` (`project_id`, `work_item_id`);
--> statement-breakpoint
CREATE TABLE `company_acceptance_fact` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `work_item_id` text NOT NULL REFERENCES `company_work_item`(`id`) ON DELETE CASCADE,
  `attempt_id` text NOT NULL REFERENCES `company_work_attempt`(`id`) ON DELETE CASCADE,
  `artifact_id` text NOT NULL REFERENCES `company_artifact`(`id`) ON DELETE CASCADE,
  `artifact_integrity_sha256` text NOT NULL,
  `criterion_id` text NOT NULL REFERENCES `company_acceptance_criterion`(`id`) ON DELETE CASCADE,
  `gate_id` text REFERENCES `company_validation_gate`(`id`) ON DELETE SET NULL,
  `verdict` text NOT NULL,
  `authority` text NOT NULL,
  `evaluator` text NOT NULL,
  `observation_json` text NOT NULL,
  `evidence_refs_json` text NOT NULL,
  `evidence_sha256` text NOT NULL,
  `input_sha256` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `supersedes_fact_id` text REFERENCES `company_acceptance_fact`(`id`) ON DELETE RESTRICT,
  `created_at` integer NOT NULL,
  CONSTRAINT `company_acceptance_fact_verdict_check` CHECK (`verdict` IN ('passed', 'failed', 'inconclusive')),
  CONSTRAINT `company_acceptance_fact_authority_check` CHECK (`authority` IN ('legacy', 'worker_claim', 'control_plane', 'independent_reviewer', 'human')),
  CONSTRAINT `company_acceptance_fact_supersedes_check` CHECK (`supersedes_fact_id` IS NULL OR `supersedes_fact_id` <> `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_acceptance_fact_project_idempotency_idx`
ON `company_acceptance_fact` (`project_id`, `idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_acceptance_fact_supersedes_idx`
ON `company_acceptance_fact` (`supersedes_fact_id`)
WHERE `supersedes_fact_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `company_acceptance_fact_tuple_idx`
ON `company_acceptance_fact` (`work_item_id`, `attempt_id`, `artifact_id`, `criterion_id`);
--> statement-breakpoint
CREATE INDEX `company_acceptance_fact_gate_idx` ON `company_acceptance_fact` (`gate_id`);
--> statement-breakpoint
CREATE TABLE `company_work_receipt_acceptance_fact` (
  `receipt_id` text NOT NULL REFERENCES `company_work_receipt`(`id`) ON DELETE CASCADE,
  `fact_id` text NOT NULL REFERENCES `company_acceptance_fact`(`id`) ON DELETE CASCADE,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`receipt_id`, `fact_id`)
);
--> statement-breakpoint
CREATE INDEX `company_work_receipt_acceptance_fact_fact_idx`
ON `company_work_receipt_acceptance_fact` (`fact_id`);
