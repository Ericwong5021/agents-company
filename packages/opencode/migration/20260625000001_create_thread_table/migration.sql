CREATE TABLE IF NOT EXISTS `thread` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `session_id` text,
  `description` text,
  `budget_tokens` integer,
  `spent_tokens` integer DEFAULT 0,
  `time_started` integer,
  `time_completed` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `thread_agent_idx` ON `thread` (`agent_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `thread_agent_kind_idx` ON `thread` (`agent_id`, `kind`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `thread_status_idx` ON `thread` (`status`);
--> statement-breakpoint

ALTER TABLE `session` ADD COLUMN `thread_id` text REFERENCES thread(id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `session_thread_idx` ON `session` (`thread_id`);
