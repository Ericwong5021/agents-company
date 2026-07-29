CREATE UNIQUE INDEX IF NOT EXISTS `company_rollout_shadow_source_idx`
ON `company_rollout_shadow_evaluation` (`source_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `company_rollout_shadow_project_idx`
ON `company_rollout_shadow_evaluation` (`project_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `company_rollout_shadow_receipt_idx`
ON `company_rollout_shadow_evaluation` (`receipt_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `company_rollout_promotion_status_idx`
ON `company_rollout_promotion_decision` (`status`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `company_rollout_promotion_created_idx`
ON `company_rollout_promotion_decision` (`created_at`);
