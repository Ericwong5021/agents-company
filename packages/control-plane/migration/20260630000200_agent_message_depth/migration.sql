ALTER TABLE `agent_message` ADD `depth` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_message` ADD `spawned_issue_id` text;
--> statement-breakpoint
CREATE INDEX `agent_message_depth_idx` ON `agent_message` (`depth`);
