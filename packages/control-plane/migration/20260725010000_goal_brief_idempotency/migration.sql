CREATE TABLE `goal_brief_generation_request` (
  `request_id` text PRIMARY KEY NOT NULL,
  `payload_hash` text NOT NULL,
  `owner_token` text NOT NULL,
  `lease_expires_at` integer NOT NULL,
  `brief_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`brief_id`) REFERENCES `goal_brief`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_brief_generation_request_brief_idx` ON `goal_brief_generation_request` (`brief_id`);
