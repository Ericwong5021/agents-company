CREATE TEMP TABLE `company_agent_runtime_backup` (
  `id` text PRIMARY KEY NOT NULL,
  `preferred_runtime` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `company_agent_runtime_backup` (`id`, `preferred_runtime`)
SELECT `id`, `preferred_runtime` FROM `company_agent`;
--> statement-breakpoint
ALTER TABLE `company_agent` DROP COLUMN `preferred_runtime`;
--> statement-breakpoint
ALTER TABLE `company_agent` ADD COLUMN `preferred_runtime` text NOT NULL DEFAULT 'codex';
--> statement-breakpoint
UPDATE `company_agent`
SET `preferred_runtime` = COALESCE(
  (
    SELECT CASE
      WHEN `company_agent_runtime_backup`.`preferred_runtime` = 'pi' THEN 'codex'
      ELSE `company_agent_runtime_backup`.`preferred_runtime`
    END
    FROM `company_agent_runtime_backup`
    WHERE `company_agent_runtime_backup`.`id` = `company_agent`.`id`
  ),
  'codex'
);
--> statement-breakpoint
DROP TABLE `company_agent_runtime_backup`;
