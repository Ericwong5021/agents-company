CREATE TABLE `founder_green_readiness` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `idempotency_key` text NOT NULL,
  `input_sha256` text NOT NULL CHECK (length(`input_sha256`) = 64),
  `b3_status` text NOT NULL CHECK (`b3_status` IN ('passed','missing')),
  `b3_evidence_ref` text,
  `e0_status` text NOT NULL CHECK (`e0_status` IN ('passed','missing')),
  `e0_evidence_ref` text,
  `authorization_status` text NOT NULL CHECK (`authorization_status` IN ('human_confirmed','missing')),
  `authorization_event_id` text,
  `confirmed_by` text,
  `exact_commit_status` text NOT NULL CHECK (`exact_commit_status` IN ('passed','missing')),
  `exact_commit_sha` text,
  `exact_commit_evidence_ref` text,
  `created_at` integer NOT NULL,
  CHECK (`b3_status` = 'missing' OR `b3_evidence_ref` IS NOT NULL),
  CHECK (`e0_status` = 'missing' OR `e0_evidence_ref` IS NOT NULL),
  CHECK (`authorization_status` = 'missing' OR (`authorization_event_id` IS NOT NULL AND `confirmed_by` IS NOT NULL)),
  CHECK (`exact_commit_status` = 'missing' OR (`exact_commit_sha` NOT GLOB '*[^0-9a-f]*' AND length(`exact_commit_sha`) = 40 AND `exact_commit_evidence_ref` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_green_readiness_idempotency_idx` ON `founder_green_readiness` (`company_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `founder_green_readiness_company_created_idx` ON `founder_green_readiness` (`company_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `founder_green_delegation_run` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `idempotency_key` text NOT NULL,
  `input_sha256` text NOT NULL CHECK (length(`input_sha256`) = 64),
  `decision_id` text NOT NULL REFERENCES `founder_decision_record`(`id`),
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `board_thread_id` text NOT NULL,
  `receipt_id` text NOT NULL REFERENCES `company_work_receipt`(`id`),
  `action_type` text NOT NULL,
  `action_allowlisted` integer NOT NULL CHECK (`action_allowlisted` IN (0,1)),
  `status` text NOT NULL CHECK (`status` IN ('blocked','authorized','outcome_pending','completed','failed')),
  `readiness_id` text REFERENCES `founder_green_readiness`(`id`) ON DELETE SET NULL,
  `readiness_json` text NOT NULL,
  `mode_json` text NOT NULL,
  `authority_json` text,
  `gate_json` text,
  `governance_ref` text,
  `graph_decision_id` text,
  `mutation_id` text,
  `dispatch_json` text,
  `fail_closed_reasons_json` text NOT NULL,
  `error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_green_delegation_idempotency_idx` ON `founder_green_delegation_run` (`company_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `founder_green_delegation_project_created_idx` ON `founder_green_delegation_run` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `founder_green_delegation_decision_idx` ON `founder_green_delegation_run` (`decision_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `founder_green_delegation_thread_idx` ON `founder_green_delegation_run` (`company_id`,`board_thread_id`,`created_at`);
