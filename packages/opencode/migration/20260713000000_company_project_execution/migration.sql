CREATE TABLE `company_project` (
  `id` text PRIMARY KEY NOT NULL,
  `goal` text NOT NULL,
  `title` text NOT NULL,
  `status` text NOT NULL,
  `owner_agent_id` text,
  `coordinator_session_id` text,
  `provider_id` text,
  `model_id` text,
  `active_run_id` text,
  `output_dir` text NOT NULL,
  `active_plan_version` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `company_project_status_idx` ON `company_project` (`status`);
--> statement-breakpoint
CREATE INDEX `company_project_owner_idx` ON `company_project` (`owner_agent_id`);
--> statement-breakpoint
CREATE TABLE `company_plan` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `version` integer NOT NULL,
  `phase` text NOT NULL,
  `status` text NOT NULL,
  `summary` text NOT NULL,
  `assumptions_json` text NOT NULL,
  `acceptance_criteria_json` text NOT NULL,
  `change_reason` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_plan_project_version_idx` ON `company_plan` (`project_id`, `version`);
--> statement-breakpoint
CREATE INDEX `company_plan_project_idx` ON `company_plan` (`project_id`);
--> statement-breakpoint
CREATE TABLE `company_work_item` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `plan_id` text NOT NULL REFERENCES `company_plan`(`id`) ON DELETE CASCADE,
  `parent_id` text,
  `title` text NOT NULL,
  `description` text NOT NULL,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `owner_agent_id` text,
  `acceptance_criteria_json` text NOT NULL,
  `attempt` integer NOT NULL DEFAULT 0,
  `max_attempts` integer NOT NULL DEFAULT 3,
  `error` text,
  `started_at` integer,
  `completed_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `company_work_item_project_status_idx` ON `company_work_item` (`project_id`, `status`);
--> statement-breakpoint
CREATE INDEX `company_work_item_owner_idx` ON `company_work_item` (`owner_agent_id`, `status`);
--> statement-breakpoint
CREATE TABLE `company_work_item_dependency` (
  `work_item_id` text NOT NULL REFERENCES `company_work_item`(`id`) ON DELETE CASCADE,
  `depends_on_id` text NOT NULL REFERENCES `company_work_item`(`id`) ON DELETE CASCADE,
  PRIMARY KEY (`work_item_id`, `depends_on_id`)
);
--> statement-breakpoint
CREATE TABLE `company_artifact` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `work_item_id` text REFERENCES `company_work_item`(`id`) ON DELETE SET NULL,
  `kind` text NOT NULL,
  `title` text NOT NULL,
  `path` text,
  `content` text,
  `evidence_json` text NOT NULL,
  `created_by_agent_id` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `company_artifact_project_idx` ON `company_artifact` (`project_id`);
--> statement-breakpoint
CREATE INDEX `company_artifact_work_item_idx` ON `company_artifact` (`work_item_id`);
--> statement-breakpoint
CREATE TABLE `company_approval_gate` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `title` text NOT NULL,
  `summary` text NOT NULL,
  `requested_by_agent_id` text,
  `decision_note` text,
  `requested_at` integer NOT NULL,
  `decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `company_approval_gate_project_idx` ON `company_approval_gate` (`project_id`, `status`);
--> statement-breakpoint
CREATE INDEX `company_approval_gate_project_kind_status_idx` ON `company_approval_gate` (`project_id`, `kind`, `status`);
--> statement-breakpoint
CREATE TABLE `company_project_event` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `type` text NOT NULL,
  `actor_id` text,
  `data_json` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `company_project_event_project_idx` ON `company_project_event` (`project_id`, `created_at`);
