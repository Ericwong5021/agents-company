CREATE TABLE `company_validation_gate` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `work_item_id` text REFERENCES `company_work_item`(`id`) ON DELETE SET NULL,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `criteria_json` text NOT NULL,
  `criteria_sha256` text NOT NULL,
  `blocking_work_item_ids_json` text NOT NULL,
  `evidence_refs_json` text NOT NULL,
  `evaluator` text NOT NULL,
  `repair_round` integer DEFAULT 0 NOT NULL,
  `max_repair_rounds` integer DEFAULT 3 NOT NULL,
  `failure_summary` text,
  `supersedes_gate_id` text,
  `created_at` integer NOT NULL,
  `evaluated_at` integer
);
--> statement-breakpoint
CREATE INDEX `company_validation_gate_project_status_idx` ON `company_validation_gate` (`project_id`, `status`);
--> statement-breakpoint
CREATE INDEX `company_validation_gate_work_item_idx` ON `company_validation_gate` (`work_item_id`);
--> statement-breakpoint
CREATE TABLE `company_validation_repair` (
  `id` text PRIMARY KEY NOT NULL,
  `gate_id` text NOT NULL REFERENCES `company_validation_gate`(`id`) ON DELETE CASCADE,
  `round` integer NOT NULL,
  `idempotency_key` text NOT NULL,
  `input_sha256` text NOT NULL,
  `failure_kind` text NOT NULL,
  `diagnosis_json` text NOT NULL,
  `fix_summary` text NOT NULL,
  `repair_diff_json` text NOT NULL,
  `reverify_evidence_json` text NOT NULL,
  `result` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_validation_repair_gate_round_idx` ON `company_validation_repair` (`gate_id`, `round`);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_validation_repair_gate_idempotency_idx` ON `company_validation_repair` (`gate_id`, `idempotency_key`);
