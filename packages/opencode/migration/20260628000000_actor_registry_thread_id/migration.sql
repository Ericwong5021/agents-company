ALTER TABLE `actor_registry` ADD `thread_id` text REFERENCES `thread`(`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `actor_registry_thread_idx` ON `actor_registry` (`thread_id`);
