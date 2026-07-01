CREATE TABLE `audit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`root_need_id` text,
	`kind` text NOT NULL,
	`action` text NOT NULL,
	`actor_agent_id` text,
	`target_agent_id` text,
	`subject_id` text,
	`subject_type` text,
	`granted` integer,
	`metadata` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_event_root_need_idx` ON `audit_event` (`root_need_id`);
--> statement-breakpoint
CREATE INDEX `audit_event_kind_idx` ON `audit_event` (`kind`);
--> statement-breakpoint
CREATE INDEX `audit_event_actor_idx` ON `audit_event` (`actor_agent_id`);
--> statement-breakpoint
CREATE INDEX `audit_event_target_idx` ON `audit_event` (`target_agent_id`);
--> statement-breakpoint
CREATE INDEX `audit_event_subject_idx` ON `audit_event` (`subject_type`,`subject_id`);
