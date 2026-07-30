CREATE TABLE `goal_brief_start_request` (
  `request_id` text PRIMARY KEY NOT NULL,
  `brief_id` text NOT NULL,
  `brief_version` integer NOT NULL,
  `owner_token` text NOT NULL,
  `lease_expires_at` integer NOT NULL,
  `project_id` text,
  `run_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`brief_id`) REFERENCES `goal_brief`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`project_id`) REFERENCES `company_project`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_brief_start_request_brief_idx` ON `goal_brief_start_request` (`brief_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_brief_start_request_project_idx` ON `goal_brief_start_request` (`project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_project_decision_request_idx` ON `company_project` (`decision_request_id`);
