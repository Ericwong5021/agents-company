CREATE TABLE IF NOT EXISTS `agent_message` (
  `id` text PRIMARY KEY NOT NULL,
  `from_agent_id` text NOT NULL,
  `to_agent_id` text NOT NULL,
  `thread_id` text,
  `root_need_id` text,
  `in_reply_to` text,
  `kind` text NOT NULL,
  `body` text NOT NULL,
  `task_summary` text,
  `outcome` text,
  `read` integer DEFAULT false NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `agent_message_from_idx` ON `agent_message` (`from_agent_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `agent_message_to_idx` ON `agent_message` (`to_agent_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `agent_message_thread_idx` ON `agent_message` (`thread_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `agent_message_root_need_idx` ON `agent_message` (`root_need_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `agent_message_kind_idx` ON `agent_message` (`kind`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `agent_message_to_read_idx` ON `agent_message` (`to_agent_id`, `read`);
