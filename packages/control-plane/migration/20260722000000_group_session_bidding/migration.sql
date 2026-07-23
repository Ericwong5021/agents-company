CREATE TABLE `group_session_bidding` (
  `id` text PRIMARY KEY NOT NULL,
  `group_session_id` text NOT NULL REFERENCES `group_session`(`id`) ON DELETE CASCADE,
  `round_num` integer NOT NULL,
  `winner_agent_id` text,
  `bids_json` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_session_bidding_group_round_idx` ON `group_session_bidding` (`group_session_id`, `round_num`);
--> statement-breakpoint
CREATE INDEX `group_session_bidding_group_created_idx` ON `group_session_bidding` (`group_session_id`, `time_created`);
