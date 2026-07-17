CREATE TABLE `company_project_charter` (
  `project_id` text PRIMARY KEY NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `scope_json` text NOT NULL,
  `success_criteria_json` text NOT NULL,
  `constraints_json` text NOT NULL,
  `acceptance_criteria_json` text NOT NULL,
  `policy_json` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `company_worktree_run` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `work_item_id` text REFERENCES `company_work_item`(`id`) ON DELETE SET NULL,
  `agent_run_id` text,
  `status` text NOT NULL,
  `repository_path` text NOT NULL,
  `directory` text NOT NULL,
  `branch` text NOT NULL,
  `base_commit` text NOT NULL,
  `head_commit` text,
  `verification_commands_json` text NOT NULL,
  `verification_json` text NOT NULL,
  `review_json` text NOT NULL,
  `merge_gate_id` text,
  `error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `merged_at` integer
);
--> statement-breakpoint
CREATE INDEX `company_worktree_run_project_idx` ON `company_worktree_run` (`project_id`, `status`);
--> statement-breakpoint
CREATE INDEX `company_worktree_run_work_item_idx` ON `company_worktree_run` (`work_item_id`);
--> statement-breakpoint
ALTER TABLE `company_approval_gate` ADD COLUMN `worktree_run_id` text REFERENCES `company_worktree_run`(`id`) ON DELETE SET NULL;
