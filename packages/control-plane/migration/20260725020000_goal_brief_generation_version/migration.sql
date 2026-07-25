ALTER TABLE `goal_brief_generation_request` ADD `brief_version` integer;
--> statement-breakpoint
UPDATE `goal_brief_generation_request` SET `brief_version` = 1 WHERE `brief_id` IS NOT NULL;
