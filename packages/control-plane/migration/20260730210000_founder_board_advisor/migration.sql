CREATE TABLE `founder_advisor_convergence` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `idempotency_key` text NOT NULL,
  `input_sha256` text NOT NULL CHECK (length(`input_sha256`) = 64),
  `board_thread_id` text NOT NULL,
  `board_run_id` text,
  `channel_message_id` text NOT NULL,
  `shadow_decision_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('intent_recorded','blocked')),
  `decision_intent_json` text,
  `ledger_decision_id` text REFERENCES `founder_decision_record`(`id`),
  `authority_status` text NOT NULL CHECK (`authority_status` IN ('authorized','blocked','unavailable')),
  `authority_reason` text NOT NULL,
  `governance_ref` text,
  `reversible` integer CHECK (`reversible` IS NULL OR `reversible` IN (0,1)),
  `external_impact` integer CHECK (`external_impact` IS NULL OR `external_impact` IN (0,1)),
  `risk_level` text CHECK (`risk_level` IS NULL OR `risk_level` IN ('low','medium','high','critical')),
  `dri_agent_id` text NOT NULL,
  `timeout_at` integer NOT NULL,
  `dissent_json` text NOT NULL,
  `created_at` integer NOT NULL,
  CHECK ((`status` = 'intent_recorded' AND `decision_intent_json` IS NOT NULL AND `ledger_decision_id` IS NOT NULL AND `authority_status` = 'authorized' AND `governance_ref` IS NOT NULL AND `reversible` IS NOT NULL AND `external_impact` IS NOT NULL AND `risk_level` IS NOT NULL) OR (`status` = 'blocked' AND `decision_intent_json` IS NULL AND `ledger_decision_id` IS NULL AND `authority_status` <> 'authorized'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_advisor_convergence_idempotency_idx` ON `founder_advisor_convergence` (`company_id`,`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_advisor_convergence_source_idx` ON `founder_advisor_convergence` (`company_id`,`board_thread_id`,`channel_message_id`);
--> statement-breakpoint
CREATE INDEX `founder_advisor_convergence_company_created_idx` ON `founder_advisor_convergence` (`company_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `founder_intervention` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `idempotency_key` text NOT NULL,
  `input_sha256` text NOT NULL CHECK (length(`input_sha256`) = 64),
  `kind` text NOT NULL CHECK (`kind` IN ('takeover','pause','correct','reject','redefine_goal')),
  `board_thread_id` text NOT NULL,
  `project_id` text,
  `decision_id` text,
  `ledger_decision_id` text NOT NULL REFERENCES `founder_decision_record`(`id`),
  `reason` text NOT NULL,
  `new_goal` text,
  `actor_id` text NOT NULL,
  `creates_fence` integer NOT NULL CHECK (`creates_fence` IN (0,1)),
  `created_at` integer NOT NULL,
  CHECK (`kind` <> 'redefine_goal' OR `new_goal` IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_intervention_idempotency_idx` ON `founder_intervention` (`company_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `founder_intervention_thread_created_idx` ON `founder_intervention` (`company_id`,`board_thread_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `founder_intervention_project_created_idx` ON `founder_intervention` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `founder_intervention_fence` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `board_thread_id` text NOT NULL,
  `intervention_id` text NOT NULL REFERENCES `founder_intervention`(`id`),
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_intervention_fence_thread_idx` ON `founder_intervention_fence` (`company_id`,`board_thread_id`);
--> statement-breakpoint
CREATE TABLE `founder_intervention_effect` (
  `id` text PRIMARY KEY NOT NULL,
  `intervention_id` text NOT NULL REFERENCES `founder_intervention`(`id`),
  `kind` text NOT NULL CHECK (`kind` IN ('attention_opened','stop_requested','stop_completed','stop_failed')),
  `status` text NOT NULL CHECK (`status` IN ('recorded','failed')),
  `detail` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `founder_intervention_effect_event_idx` ON `founder_intervention_effect` (`intervention_id`,`created_at`);
