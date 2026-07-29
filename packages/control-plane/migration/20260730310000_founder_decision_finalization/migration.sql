ALTER TABLE `founder_decision_record` ADD `record_origin` text DEFAULT 'live' NOT NULL CHECK (`record_origin` IN ('live', 'historical_import'));
--> statement-breakpoint
ALTER TABLE `founder_decision_transition` ADD `final_decision` text;
--> statement-breakpoint
ALTER TABLE `founder_decision_transition` ADD `decided_at` integer;
--> statement-breakpoint
ALTER TABLE `founder_decision_current` ADD `final_decision` text;
--> statement-breakpoint
ALTER TABLE `founder_decision_current` ADD `decided_at` integer;
--> statement-breakpoint
UPDATE `founder_decision_record`
SET `record_origin` = 'historical_import'
WHERE `decision_maker` = 'unknown'
  OR (
    `decision_maker` = 'ai_founder'
    AND (
      `founder_snapshot_id` IS NULL
      OR `recommendation` IS NULL
      OR `authority_class` IS NULL
      OR `operating_mode` IS NULL
      OR `confidence` IS NULL
      OR `reversible` IS NULL
      OR `external_impact` IS NULL
      OR `risk_level` IS NULL
    )
  )
  OR EXISTS (
    SELECT 1
    FROM `founder_decision_current`
    WHERE `founder_decision_current`.`decision_id` = `founder_decision_record`.`id`
      AND `founder_decision_current`.`current_status` IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back')
      AND (`founder_decision_record`.`final_decision` IS NULL OR `founder_decision_record`.`decided_at` IS NULL)
  );
--> statement-breakpoint
UPDATE `founder_decision_transition`
SET
  `final_decision` = COALESCE(
    (SELECT `final_decision` FROM `founder_decision_record` WHERE `id` = `founder_decision_transition`.`decision_id`),
    (SELECT `recommendation` FROM `founder_decision_record` WHERE `id` = `founder_decision_transition`.`decision_id`),
    (SELECT `subject` FROM `founder_decision_record` WHERE `id` = `founder_decision_transition`.`decision_id`),
    `reason`
  ),
  `decided_at` = COALESCE(
    (SELECT `decided_at` FROM `founder_decision_record` WHERE `id` = `founder_decision_transition`.`decision_id`),
    `created_at`
  )
WHERE `to_status` IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back');
--> statement-breakpoint
UPDATE `founder_decision_current`
SET
  `final_decision` = (
    SELECT `final_decision`
    FROM `founder_decision_transition`
    WHERE `founder_decision_transition`.`id` = `founder_decision_current`.`latest_transition_id`
  ),
  `decided_at` = (
    SELECT `decided_at`
    FROM `founder_decision_transition`
    WHERE `founder_decision_transition`.`id` = `founder_decision_current`.`latest_transition_id`
  )
WHERE `current_status` IN ('accepted', 'executed', 'overridden', 'failed', 'rolled_back');
