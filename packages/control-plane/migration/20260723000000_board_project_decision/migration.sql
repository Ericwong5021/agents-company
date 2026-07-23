ALTER TABLE `company_project` ADD COLUMN `company_id` text;
--> statement-breakpoint
ALTER TABLE `company_project` ADD COLUMN `root_need_id` text;
--> statement-breakpoint
ALTER TABLE `company_project` ADD COLUMN `source_thread_id` text;
--> statement-breakpoint
ALTER TABLE `company_project` ADD COLUMN `decision_request_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `company_project_source_thread_idx` ON `company_project` (`source_thread_id`);
--> statement-breakpoint
ALTER TABLE `company_project_charter` ADD COLUMN `title` text NOT NULL DEFAULT 'Project Charter';
--> statement-breakpoint
ALTER TABLE `company_project_charter` ADD COLUMN `value` text NOT NULL DEFAULT 'Legacy project value';
--> statement-breakpoint
ALTER TABLE `company_project_charter` ADD COLUMN `deliverables_json` text NOT NULL DEFAULT '["Legacy project delivery"]';
--> statement-breakpoint
ALTER TABLE `company_project_charter` ADD COLUMN `non_goals_json` text NOT NULL DEFAULT '["No additional non-goals recorded"]';
--> statement-breakpoint
ALTER TABLE `company_project_charter` ADD COLUMN `resources_json` text NOT NULL DEFAULT '[{"kind":"other","scope":"Legacy project resources","disposition":"Retain"}]';
--> statement-breakpoint
ALTER TABLE `company_project_charter` ADD COLUMN `risks_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `company_project_charter` ADD COLUMN `dri_agent_id` text NOT NULL DEFAULT 'legacy-project-owner';
--> statement-breakpoint
ALTER TABLE `company_project_charter` ADD COLUMN `milestones_json` text NOT NULL DEFAULT '["Complete delivery"]';
--> statement-breakpoint
ALTER TABLE `company_project_charter` ADD COLUMN `open_decisions_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD COLUMN `inputs_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD COLUMN `expected_outputs_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD COLUMN `validators_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `company_work_item` ADD COLUMN `disposition` text NOT NULL DEFAULT 'retain';
