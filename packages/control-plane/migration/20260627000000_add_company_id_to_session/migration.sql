ALTER TABLE `session` ADD `company_id` text REFERENCES `project`(`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `session_company_idx` ON `session` (`company_id`);--> statement-breakpoint
-- Backfill: set company_id = project_id for non-global sessions so disband
-- can properly identify and delete company-related sessions.
UPDATE `session` SET `company_id` = `project_id` WHERE `project_id` != 'global';
