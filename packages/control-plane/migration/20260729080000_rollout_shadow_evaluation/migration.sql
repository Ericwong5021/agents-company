CREATE TABLE `company_rollout_shadow_evaluation` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `source_key` text NOT NULL,
  `kind` text NOT NULL,
  `receipt_id` text,
  `snapshot_sha256` text NOT NULL,
  `input_sha256` text NOT NULL,
  `output_sha256` text NOT NULL,
  `business_state_before_sha256` text NOT NULL,
  `business_state_after_sha256` text NOT NULL,
  `input_json` text NOT NULL,
  `output_json` text NOT NULL,
  `status` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `company_project`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX `company_rollout_shadow_source_idx`
ON `company_rollout_shadow_evaluation` (`source_key`);

CREATE INDEX `company_rollout_shadow_project_idx`
ON `company_rollout_shadow_evaluation` (`project_id`, `created_at`);

CREATE INDEX `company_rollout_shadow_receipt_idx`
ON `company_rollout_shadow_evaluation` (`receipt_id`);
