CREATE TABLE `goal_brief` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text,
  `source_thread_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `company_project`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_brief_project_idx` ON `goal_brief` (`project_id`);
--> statement-breakpoint
CREATE INDEX `goal_brief_source_thread_idx` ON `goal_brief` (`source_thread_id`);
--> statement-breakpoint
CREATE TABLE `goal_brief_version` (
  `brief_id` text NOT NULL,
  `version` integer NOT NULL,
  `goal` text NOT NULL,
  `deliverables_json` text NOT NULL,
  `acceptance_criteria_json` text NOT NULL,
  `constraints_json` text NOT NULL,
  `non_goals_json` text NOT NULL,
  `assumptions_json` text NOT NULL,
  `open_questions_json` text NOT NULL,
  `risk_level` text NOT NULL,
  `recommended_plan_json` text NOT NULL,
  `approval_mode` text NOT NULL,
  `source` text NOT NULL,
  `source_refs_json` text NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`brief_id`, `version`),
  FOREIGN KEY (`brief_id`) REFERENCES `goal_brief`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `goal_brief_version_created_idx` ON `goal_brief_version` (`brief_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `company_work_projection` (
  `project_id` text PRIMARY KEY NOT NULL,
  `projector_version` integer NOT NULL,
  `source_watermark` text NOT NULL,
  `projection_json` text NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `company_project`(`id`) ON UPDATE no action ON DELETE cascade
);
