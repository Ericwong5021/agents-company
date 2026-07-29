CREATE TABLE `company_rollout_promotion_decision` (
  `id` text PRIMARY KEY NOT NULL,
  `target_phase` text NOT NULL,
  `candidate_ids_json` text NOT NULL,
  `candidate_shas_json` text NOT NULL,
  `repeat_ids_json` text NOT NULL,
  `rollback_ids_json` text NOT NULL,
  `metric_contract_sha256` text NOT NULL,
  `metric_report_sha256s_json` text NOT NULL,
  `shadow_report_sha256s_json` text NOT NULL,
  `ancestry_json` text NOT NULL,
  `input_sha256` text NOT NULL,
  `input_json` text NOT NULL,
  `output_sha256` text NOT NULL,
  `status` text NOT NULL,
  `reasons_json` text NOT NULL,
  `created_at` integer NOT NULL
);

CREATE INDEX `company_rollout_promotion_status_idx`
ON `company_rollout_promotion_decision` (`status`, `created_at`);

CREATE INDEX `company_rollout_promotion_created_idx`
ON `company_rollout_promotion_decision` (`created_at`);
