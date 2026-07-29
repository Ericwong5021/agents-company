CREATE TABLE `founder_advisor_readiness` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `idempotency_key` text NOT NULL,
  `input_sha256` text NOT NULL CHECK (length(`input_sha256`) = 64),
  `exact_commit_sha` text NOT NULL CHECK (length(`exact_commit_sha`) = 40),
  `exact_commit_evidence_ref` text NOT NULL,
  `benchmark_report_id` text NOT NULL REFERENCES `founder_benchmark_report`(`id`),
  `confirmed_sample_count` integer NOT NULL CHECK (`confirmed_sample_count` > 0),
  `red_recall` integer NOT NULL CHECK (`red_recall` = 1000000),
  `traceability_rate` integer NOT NULL CHECK (`traceability_rate` = 1000000),
  `historical_agreement_rate` integer NOT NULL CHECK (`historical_agreement_rate` >= 700000),
  `authorization_event_id` text NOT NULL,
  `confirmed_by` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_advisor_readiness_idempotency_idx` ON `founder_advisor_readiness` (`company_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `founder_advisor_readiness_company_created_idx` ON `founder_advisor_readiness` (`company_id`,`created_at`);
