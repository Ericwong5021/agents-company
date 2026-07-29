CREATE TABLE `company_outcome_signal` (
  `id` text PRIMARY KEY NOT NULL,
  `schema_version` integer NOT NULL,
  `project_id` text NOT NULL,
  `decision_id` text,
  `idempotency_key` text NOT NULL,
  `result` text NOT NULL,
  `summary` text NOT NULL,
  `validator_kind` text NOT NULL,
  `validator_id` text NOT NULL,
  `source_refs_json` text NOT NULL,
  `observed_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `company_project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_outcome_signal_project_idempotency_idx` ON `company_outcome_signal` (`project_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `company_outcome_signal_project_created_idx` ON `company_outcome_signal` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `company_outcome_signal_decision_idx` ON `company_outcome_signal` (`decision_id`);
