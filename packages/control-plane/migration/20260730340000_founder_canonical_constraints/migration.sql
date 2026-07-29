CREATE TRIGGER `founder_decision_record_canonical_insert`
BEFORE INSERT ON `founder_decision_record`
WHEN NOT (
  (
    NEW.`record_origin` != 'live'
    OR NEW.`decision_maker` != 'ai_founder'
    OR (
      NEW.`founder_snapshot_id` IS NOT NULL
      AND NEW.`recommendation` IS NOT NULL
      AND NEW.`authority_class` IS NOT NULL
      AND NEW.`operating_mode` IS NOT NULL
      AND NEW.`confidence` IS NOT NULL
      AND NEW.`reversible` IS NOT NULL
      AND NEW.`external_impact` IS NOT NULL
      AND NEW.`risk_level` IS NOT NULL
    )
  )
  AND (
    (NEW.`record_origin` = 'live' AND NEW.`decision_maker` != 'unknown')
    OR NEW.`record_origin` = 'historical_import'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'founder_decision_record canonical constraint failed');
END;
--> statement-breakpoint

CREATE TRIGGER `founder_decision_record_canonical_update`
BEFORE UPDATE ON `founder_decision_record`
WHEN NOT (
  (
    NEW.`record_origin` != 'live'
    OR NEW.`decision_maker` != 'ai_founder'
    OR (
      NEW.`founder_snapshot_id` IS NOT NULL
      AND NEW.`recommendation` IS NOT NULL
      AND NEW.`authority_class` IS NOT NULL
      AND NEW.`operating_mode` IS NOT NULL
      AND NEW.`confidence` IS NOT NULL
      AND NEW.`reversible` IS NOT NULL
      AND NEW.`external_impact` IS NOT NULL
      AND NEW.`risk_level` IS NOT NULL
    )
  )
  AND (
    (NEW.`record_origin` = 'live' AND NEW.`decision_maker` != 'unknown')
    OR NEW.`record_origin` = 'historical_import'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'founder_decision_record canonical constraint failed');
END;
--> statement-breakpoint

CREATE TRIGGER `founder_decision_transition_finalization_insert`
BEFORE INSERT ON `founder_decision_transition`
WHEN NOT (
  (
    NEW.`to_status` IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back')
    AND NEW.`final_decision` IS NOT NULL
    AND NEW.`decided_at` IS NOT NULL
  )
  OR (
    NEW.`to_status` NOT IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back')
    AND NEW.`final_decision` IS NULL
    AND NEW.`decided_at` IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'founder_decision_transition finalization constraint failed');
END;
--> statement-breakpoint

CREATE TRIGGER `founder_decision_transition_finalization_update`
BEFORE UPDATE ON `founder_decision_transition`
WHEN NOT (
  (
    NEW.`to_status` IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back')
    AND NEW.`final_decision` IS NOT NULL
    AND NEW.`decided_at` IS NOT NULL
  )
  OR (
    NEW.`to_status` NOT IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back')
    AND NEW.`final_decision` IS NULL
    AND NEW.`decided_at` IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'founder_decision_transition finalization constraint failed');
END;
--> statement-breakpoint

CREATE TRIGGER `founder_decision_current_finalization_insert`
BEFORE INSERT ON `founder_decision_current`
WHEN NOT (
  (
    NEW.`current_status` IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back')
    AND NEW.`final_decision` IS NOT NULL
    AND NEW.`decided_at` IS NOT NULL
  )
  OR (
    NEW.`current_status` NOT IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back')
    AND NEW.`final_decision` IS NULL
    AND NEW.`decided_at` IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'founder_decision_current finalization constraint failed');
END;
--> statement-breakpoint

CREATE TRIGGER `founder_decision_current_finalization_update`
BEFORE UPDATE ON `founder_decision_current`
WHEN NOT (
  (
    NEW.`current_status` IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back')
    AND NEW.`final_decision` IS NOT NULL
    AND NEW.`decided_at` IS NOT NULL
  )
  OR (
    NEW.`current_status` NOT IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back')
    AND NEW.`final_decision` IS NULL
    AND NEW.`decided_at` IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'founder_decision_current finalization constraint failed');
END;
--> statement-breakpoint

CREATE TABLE `founder_advisor_convergence_new` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `idempotency_key` text NOT NULL,
  `input_sha256` text NOT NULL CHECK (length(`input_sha256`) = 64),
  `board_thread_id` text NOT NULL REFERENCES `conversation_thread`(`id`),
  `board_run_id` text REFERENCES `conversation_run`(`id`),
  `channel_message_id` text NOT NULL REFERENCES `channel_message`(`id`),
  `shadow_decision_id` text NOT NULL REFERENCES `founder_shadow_decision`(`id`),
  `current_request_key` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('intent_recorded','blocked')),
  `decision_intent_json` text,
  `ledger_decision_id` text REFERENCES `founder_decision_record`(`id`),
  `authority_status` text NOT NULL CHECK (`authority_status` IN ('authorized','blocked','unavailable')),
  `authority_reason` text NOT NULL,
  `governance_ref` text,
  `reversible` integer CHECK (`reversible` IS NULL OR `reversible` IN (0,1)),
  `external_impact` integer CHECK (`external_impact` IS NULL OR `external_impact` IN (0,1)),
  `risk_level` text CHECK (`risk_level` IS NULL OR `risk_level` IN ('low','medium','high','critical')),
  `dri_agent_id` text NOT NULL REFERENCES `company_agent`(`id`),
  `timeout_at` integer NOT NULL,
  `dissent_json` text NOT NULL,
  `created_at` integer NOT NULL,
  CHECK (
    (
      `status` = 'intent_recorded'
      AND `decision_intent_json` IS NOT NULL
      AND `ledger_decision_id` IS NOT NULL
      AND `authority_status` = 'authorized'
      AND `governance_ref` IS NOT NULL
      AND `reversible` IS NOT NULL
      AND `external_impact` IS NOT NULL
      AND `risk_level` IS NOT NULL
    )
    OR (
      `status` = 'blocked'
      AND `decision_intent_json` IS NULL
      AND `ledger_decision_id` IS NULL
      AND `authority_status` <> 'authorized'
    )
  )
);
--> statement-breakpoint

INSERT INTO `founder_advisor_convergence_new` (
  `id`,
  `company_id`,
  `idempotency_key`,
  `input_sha256`,
  `board_thread_id`,
  `board_run_id`,
  `channel_message_id`,
  `shadow_decision_id`,
  `current_request_key`,
  `status`,
  `decision_intent_json`,
  `ledger_decision_id`,
  `authority_status`,
  `authority_reason`,
  `governance_ref`,
  `reversible`,
  `external_impact`,
  `risk_level`,
  `dri_agent_id`,
  `timeout_at`,
  `dissent_json`,
  `created_at`
)
SELECT
  `id`,
  `company_id`,
  `idempotency_key`,
  `input_sha256`,
  `board_thread_id`,
  `board_run_id`,
  `channel_message_id`,
  `shadow_decision_id`,
  `current_request_key`,
  `status`,
  `decision_intent_json`,
  `ledger_decision_id`,
  `authority_status`,
  `authority_reason`,
  `governance_ref`,
  `reversible`,
  `external_impact`,
  `risk_level`,
  `dri_agent_id`,
  `timeout_at`,
  `dissent_json`,
  `created_at`
FROM `founder_advisor_convergence`;
--> statement-breakpoint

CREATE TABLE `founder_advisor_convergence_event_new` (
  `id` text PRIMARY KEY NOT NULL,
  `convergence_id` text NOT NULL REFERENCES `founder_advisor_convergence_new`(`id`) ON DELETE CASCADE,
  `sequence` integer NOT NULL,
  `idempotency_key` text NOT NULL,
  `status` text NOT NULL,
  `reason` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint

INSERT INTO `founder_advisor_convergence_event_new` (
  `id`,
  `convergence_id`,
  `sequence`,
  `idempotency_key`,
  `status`,
  `reason`,
  `created_at`
)
SELECT
  `id`,
  `convergence_id`,
  `sequence`,
  `idempotency_key`,
  `status`,
  `reason`,
  `created_at`
FROM `founder_advisor_convergence_event`;
--> statement-breakpoint

DROP TABLE `founder_advisor_convergence_event`;
--> statement-breakpoint

DROP TABLE `founder_advisor_convergence`;
--> statement-breakpoint

ALTER TABLE `founder_advisor_convergence_new` RENAME TO `founder_advisor_convergence`;
--> statement-breakpoint

ALTER TABLE `founder_advisor_convergence_event_new` RENAME TO `founder_advisor_convergence_event`;
--> statement-breakpoint

CREATE UNIQUE INDEX `founder_advisor_convergence_idempotency_idx`
ON `founder_advisor_convergence` (`company_id`,`idempotency_key`);
--> statement-breakpoint

CREATE UNIQUE INDEX `founder_advisor_convergence_source_idx`
ON `founder_advisor_convergence` (`company_id`,`board_thread_id`,`channel_message_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `founder_advisor_convergence_current_request_idx`
ON `founder_advisor_convergence` (`company_id`,`board_thread_id`,`current_request_key`);
--> statement-breakpoint

CREATE INDEX `founder_advisor_convergence_company_created_idx`
ON `founder_advisor_convergence` (`company_id`,`created_at`);
--> statement-breakpoint

CREATE UNIQUE INDEX `founder_advisor_convergence_event_sequence_idx`
ON `founder_advisor_convergence_event` (`convergence_id`,`sequence`);
--> statement-breakpoint

CREATE UNIQUE INDEX `founder_advisor_convergence_event_idempotency_idx`
ON `founder_advisor_convergence_event` (`convergence_id`,`idempotency_key`);
--> statement-breakpoint

CREATE INDEX `founder_advisor_convergence_event_created_idx`
ON `founder_advisor_convergence_event` (`convergence_id`,`created_at`);
