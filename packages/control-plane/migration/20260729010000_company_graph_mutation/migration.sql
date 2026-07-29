ALTER TABLE `company_project` ADD `graph_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD `purpose` text DEFAULT 'delivery' NOT NULL;
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD `origin_kind` text DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD `origin_ref_id` text;
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD `graph_revision_created` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD `validation_mode` text DEFAULT 'self_check' NOT NULL;
--> statement-breakpoint
UPDATE `company_work_item`
SET `validation_mode` = 'independent_review'
WHERE `review_status` != 'not_required';
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD `superseded_by_id` text;
--> statement-breakpoint
CREATE TABLE `company_graph_mutation` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `trigger_receipt_id` text NOT NULL REFERENCES `company_work_receipt`(`id`) ON DELETE CASCADE,
  `expected_revision` integer NOT NULL,
  `applied_revision` integer,
  `orchestrator_version` integer NOT NULL,
  `idempotency_key` text NOT NULL,
  `decision` text NOT NULL,
  `rationale` text NOT NULL,
  `evidence_refs_json` text NOT NULL,
  `operations_json` text NOT NULL,
  `status` text NOT NULL,
  `policy_verdict_json` text NOT NULL,
  `created_at` integer NOT NULL,
  `applied_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_graph_mutation_project_idempotency_idx` ON `company_graph_mutation` (`project_id`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX `company_graph_mutation_receipt_idx` ON `company_graph_mutation` (`trigger_receipt_id`);
--> statement-breakpoint
CREATE INDEX `company_graph_mutation_project_status_idx` ON `company_graph_mutation` (`project_id`, `status`);
