CREATE TABLE `company_agent` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `system_prompt` text,
  `model` text,
  `color` text,
  `icon` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);--> statement-breakpoint

INSERT INTO `company_agent` (`id`, `name`, `description`, `time_created`, `time_updated`)
VALUES ('assistant', 'Assistant', 'General-purpose assistant agent', unixepoch() * 1000, unixepoch() * 1000);--> statement-breakpoint

ALTER TABLE `session` ADD `company_agent_id` text NOT NULL DEFAULT 'assistant';--> statement-breakpoint

CREATE INDEX `session_company_agent_idx` ON `session` (`company_agent_id`, `project_id`);
