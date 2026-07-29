CREATE TABLE `company_interpretation` (
  `id` text PRIMARY KEY NOT NULL,
  `source_id` text NOT NULL REFERENCES `company_commons_source`(`id`) ON DELETE CASCADE,
  `reader_agent_id` text NOT NULL,
  `reader_role` text NOT NULL,
  `work_item_id` text REFERENCES `company_work_item`(`id`) ON DELETE SET NULL,
  `core_thesis` text NOT NULL,
  `important_claims_json` text NOT NULL,
  `company_relevance` text NOT NULL,
  `project_connections_json` text NOT NULL,
  `agreement` text NOT NULL,
  `conflicts_json` text NOT NULL,
  `counter_arguments_json` text NOT NULL,
  `inspiration_json` text NOT NULL,
  `experiment_ideas_json` text NOT NULL,
  `disposition` text NOT NULL,
  `confidence` real NOT NULL,
  `evidence_refs_json` text NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `company_interpretation_agreement_check` CHECK (`agreement` IN ('aligned','conflicted','mixed','unknown')),
  CONSTRAINT `company_interpretation_disposition_check` CHECK (`disposition` IN ('archive','candidate','reject')),
  CONSTRAINT `company_interpretation_confidence_check` CHECK (`confidence` >= 0 AND `confidence` <= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_interpretation_source_agent_idx` ON `company_interpretation` (`source_id`,`reader_agent_id`);
--> statement-breakpoint
CREATE INDEX `company_interpretation_work_item_idx` ON `company_interpretation` (`work_item_id`);
--> statement-breakpoint
CREATE TABLE `company_agent_interest_profile` (
  `agent_id` text PRIMARY KEY NOT NULL REFERENCES `company_agent`(`id`) ON DELETE CASCADE,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `topics_json` text NOT NULL,
  `preferred_lenses_json` text NOT NULL,
  `excluded_topics_json` text NOT NULL,
  `novelty_threshold` real NOT NULL,
  `weekly_reading_budget` integer NOT NULL,
  `max_concurrency` integer NOT NULL,
  `privacy_scopes_json` text NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `company_agent_interest_novelty_check` CHECK (`novelty_threshold` >= 0 AND `novelty_threshold` <= 1),
  CONSTRAINT `company_agent_interest_budget_check` CHECK (`weekly_reading_budget` >= 0),
  CONSTRAINT `company_agent_interest_concurrency_check` CHECK (`max_concurrency` >= 1 AND `max_concurrency` <= 3)
);
--> statement-breakpoint
CREATE INDEX `company_agent_interest_company_idx` ON `company_agent_interest_profile` (`company_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `company_reading_assignment` (
  `id` text PRIMARY KEY NOT NULL,
  `source_id` text NOT NULL REFERENCES `company_commons_source`(`id`) ON DELETE CASCADE,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `agent_id` text NOT NULL REFERENCES `company_agent`(`id`) ON DELETE CASCADE,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `linked_project_ids_json` text NOT NULL,
  `work_item_id` text REFERENCES `company_work_item`(`id`) ON DELETE SET NULL,
  `idempotency_key` text NOT NULL,
  `status` text NOT NULL,
  `relevance_score` real NOT NULL,
  `novelty_score` real NOT NULL,
  `gap_score` real NOT NULL,
  `budget_score` real NOT NULL,
  `total_score` real NOT NULL,
  `budget_week` text NOT NULL,
  `budget_reserved` integer NOT NULL,
  `error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `stopped_at` integer,
  CONSTRAINT `company_reading_assignment_status_check` CHECK (`status` IN ('scheduling','scheduled','running','completed','failed','stopped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_reading_assignment_idempotency_idx` ON `company_reading_assignment` (`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_reading_assignment_source_agent_idx` ON `company_reading_assignment` (`source_id`,`agent_id`);
--> statement-breakpoint
CREATE INDEX `company_reading_assignment_agent_budget_idx` ON `company_reading_assignment` (`agent_id`,`budget_week`,`budget_reserved`);
--> statement-breakpoint
CREATE INDEX `company_reading_assignment_project_status_idx` ON `company_reading_assignment` (`project_id`,`status`);
--> statement-breakpoint
CREATE TABLE `company_interpretation_evidence` (
  `interpretation_id` text NOT NULL REFERENCES `company_interpretation`(`id`) ON DELETE CASCADE,
  `chunk_id` text NOT NULL REFERENCES `company_commons_chunk`(`id`) ON DELETE RESTRICT,
  `start_offset` integer NOT NULL,
  `end_offset` integer NOT NULL,
  `claim` text NOT NULL,
  CONSTRAINT `company_interpretation_evidence_span_check` CHECK (`start_offset` >= 0 AND `end_offset` > `start_offset`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_interpretation_evidence_idx` ON `company_interpretation_evidence` (`interpretation_id`,`chunk_id`,`start_offset`,`end_offset`);
--> statement-breakpoint
CREATE INDEX `company_interpretation_evidence_chunk_idx` ON `company_interpretation_evidence` (`chunk_id`);
