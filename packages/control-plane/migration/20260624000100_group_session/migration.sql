CREATE TABLE `group_session` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `title` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_archived` integer
);--> statement-breakpoint
CREATE INDEX `group_session_project_idx` ON `group_session` (`project_id`);--> statement-breakpoint

CREATE TABLE `group_session_member` (
  `group_session_id` text NOT NULL REFERENCES `group_session`(`id`) ON DELETE CASCADE,
  `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `company_agent_id` text NOT NULL REFERENCES `company_agent`(`id`),
  `position` integer NOT NULL DEFAULT 0,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY (`group_session_id`, `session_id`)
);--> statement-breakpoint
CREATE INDEX `group_session_member_group_idx` ON `group_session_member` (`group_session_id`);--> statement-breakpoint
CREATE INDEX `group_session_member_session_idx` ON `group_session_member` (`session_id`);--> statement-breakpoint

CREATE TABLE `group_message` (
  `id` text PRIMARY KEY NOT NULL,
  `group_session_id` text NOT NULL REFERENCES `group_session`(`id`) ON DELETE CASCADE,
  `round_num` integer NOT NULL,
  `role` text NOT NULL,
  `company_agent_id` text,
  `session_id` text,
  `content` text NOT NULL,
  `status_summary` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `group_message_group_round_idx` ON `group_message` (`group_session_id`, `round_num`);
