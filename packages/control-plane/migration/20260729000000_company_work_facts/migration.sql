CREATE TABLE `company_work_attempt` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `work_item_id` text NOT NULL REFERENCES `company_work_item`(`id`) ON DELETE CASCADE,
  `agent_run_id` text,
  `ordinal` integer NOT NULL,
  `status` text NOT NULL,
  `failure_kind` text,
  `safe_summary` text,
  `started_at` integer NOT NULL,
  `finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_work_attempt_item_ordinal_idx` ON `company_work_attempt` (`work_item_id`, `ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_work_attempt_agent_run_idx` ON `company_work_attempt` (`agent_run_id`);
--> statement-breakpoint
CREATE INDEX `company_work_attempt_project_status_idx` ON `company_work_attempt` (`project_id`, `status`);
--> statement-breakpoint
CREATE TABLE `company_work_receipt` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `work_item_id` text NOT NULL REFERENCES `company_work_item`(`id`) ON DELETE CASCADE,
  `attempt_id` text NOT NULL REFERENCES `company_work_attempt`(`id`) ON DELETE CASCADE,
  `idempotency_key` text NOT NULL,
  `outcome` text NOT NULL,
  `summary` text NOT NULL,
  `artifact_ids_json` text NOT NULL,
  `evidence_refs_json` text NOT NULL,
  `confirmed_facts_json` text NOT NULL,
  `invalidated_assumptions_json` text NOT NULL,
  `unknowns_json` text NOT NULL,
  `blockers_json` text NOT NULL,
  `capability_gaps_json` text NOT NULL,
  `task_proposals_json` text NOT NULL,
  `dependency_proposals_json` text NOT NULL,
  `questions_json` text NOT NULL,
  `processing_status` text NOT NULL,
  `processed_mutation_id` text,
  `created_at` integer NOT NULL,
  `processed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_work_receipt_attempt_idx` ON `company_work_receipt` (`attempt_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_work_receipt_idempotency_idx` ON `company_work_receipt` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `company_work_receipt_project_status_idx` ON `company_work_receipt` (`project_id`, `processing_status`);
