ALTER TABLE `group_session_bidding` ADD COLUMN `state` text NOT NULL DEFAULT 'bidding';
--> statement-breakpoint
UPDATE `group_session_bidding` SET `state` = 'decided';
