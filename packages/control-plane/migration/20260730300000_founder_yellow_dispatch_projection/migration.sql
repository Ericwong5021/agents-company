ALTER TABLE `founder_yellow_dispatch_outbox` ADD `decision_dispatch_outbox_id` text REFERENCES `founder_decision_dispatch_outbox`(`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_yellow_dispatch_outbox_decision_dispatch_idx`
ON `founder_yellow_dispatch_outbox` (`decision_dispatch_outbox_id`)
WHERE `decision_dispatch_outbox_id` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `founder_green_delegation_run` ADD `dispatched_at` integer;
