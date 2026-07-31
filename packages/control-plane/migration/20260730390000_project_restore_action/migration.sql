CREATE TABLE `company_project_action_v4` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `attention_id` text REFERENCES `company_attention`(`id`) ON DELETE SET NULL,
  `action` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `payload_json` text NOT NULL,
  `payload_sha256` text NOT NULL,
  `expected_revision` integer,
  `status` text NOT NULL,
  `result_json` text,
  `error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `claimed_at` integer,
  `finished_at` integer,
  CONSTRAINT `company_project_action_action_check` CHECK (`action` IN ('pause_work', 'resume_work', 'stop_work', 'retry', 'resolve_blocker', 'adjust_brief', 'accept_delivery', 'request_change', 'archive', 'restore')),
  CONSTRAINT `company_project_action_revision_check` CHECK (`expected_revision` IS NULL OR `expected_revision` >= 0),
  CONSTRAINT `company_project_action_status_check` CHECK (`status` IN ('requested', 'claimed', 'applied', 'rejected'))
);
--> statement-breakpoint
INSERT INTO `company_project_action_v4` (
  `id`,
  `project_id`,
  `attention_id`,
  `action`,
  `idempotency_key`,
  `payload_json`,
  `payload_sha256`,
  `expected_revision`,
  `status`,
  `result_json`,
  `error`,
  `created_at`,
  `updated_at`,
  `claimed_at`,
  `finished_at`
)
SELECT
  `id`,
  `project_id`,
  `attention_id`,
  `action`,
  `idempotency_key`,
  `payload_json`,
  `payload_sha256`,
  `expected_revision`,
  `status`,
  `result_json`,
  `error`,
  `created_at`,
  `updated_at`,
  `claimed_at`,
  `finished_at`
FROM `company_project_action`;
--> statement-breakpoint
DROP TABLE `company_project_action`;
--> statement-breakpoint
ALTER TABLE `company_project_action_v4` RENAME TO `company_project_action`;
--> statement-breakpoint
CREATE UNIQUE INDEX `company_project_action_project_idempotency_idx` ON `company_project_action` (`project_id`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX `company_project_action_project_status_idx` ON `company_project_action` (`project_id`, `status`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `company_project_action_attention_idx` ON `company_project_action` (`attention_id`);
