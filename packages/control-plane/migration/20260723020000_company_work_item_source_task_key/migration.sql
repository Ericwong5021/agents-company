ALTER TABLE `company_work_item` ADD COLUMN `source_task_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `company_work_item_source_task_key_idx` ON `company_work_item` (`project_id`, `plan_id`, `source_task_key`, `kind`);
