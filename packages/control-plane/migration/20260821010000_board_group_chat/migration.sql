ALTER TABLE `channel_message` ADD `sequence` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `channel_message` ADD `kind` text NOT NULL DEFAULT 'text';
--> statement-breakpoint
ALTER TABLE `channel_message` ADD `poll` text;
--> statement-breakpoint

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY time_created, id) AS seq
  FROM channel_message
)
UPDATE channel_message
SET sequence = (SELECT seq FROM ranked WHERE ranked.id = channel_message.id);
--> statement-breakpoint

CREATE UNIQUE INDEX `channel_message_channel_sequence_idx` ON `channel_message` (`channel_id`, `sequence`);
--> statement-breakpoint

CREATE TABLE `channel_counter` (
  `channel_id` text PRIMARY KEY NOT NULL REFERENCES `channel`(`id`) ON DELETE CASCADE,
  `next_sequence` integer NOT NULL DEFAULT 1,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
--> statement-breakpoint

INSERT INTO channel_counter (channel_id, next_sequence, time_created, time_updated)
SELECT id, COALESCE((SELECT MAX(sequence) + 1 FROM channel_message WHERE channel_id = channel.id), 1), unixepoch() * 1000, unixepoch() * 1000
FROM channel;
--> statement-breakpoint

WITH legacy_board_message AS (
  SELECT
    group_message.id,
    conversation_thread.channel_id,
    conversation_thread.root_need_id,
    conversation_thread.id AS source_thread_id,
    group_message.external_message_id AS reply_to_id,
    group_message.company_agent_id AS author_id,
    group_message.content AS body,
    group_message.time_created,
    group_message.time_updated,
    ROW_NUMBER() OVER (PARTITION BY conversation_thread.channel_id ORDER BY group_message.time_created, group_message.id) AS ordinal
  FROM group_message
  INNER JOIN conversation_run ON conversation_run.runtime_id = group_message.group_session_id
  INNER JOIN conversation_thread ON conversation_thread.id = conversation_run.conversation_thread_id
  INNER JOIN channel ON channel.id = conversation_thread.channel_id
  WHERE channel.kind = 'board'
    AND group_message.role = 'agent'
    AND group_message.company_agent_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM signal_projection_source
      WHERE signal_projection_source.source_kind = 'group_message'
        AND signal_projection_source.source_id = group_message.id
    )
)
INSERT INTO channel_message (
  id, channel_id, sequence, kind, poll, root_need_id, source_thread_id, reply_to_id, request_id,
  author_kind, author_id, body, signal_type, dri_principal_kind, dri_principal_id, visibility,
  mentions, resources, time_created, time_updated
)
SELECT
  'cmsg_migrated_' || legacy_board_message.id,
  legacy_board_message.channel_id,
  channel_counter.next_sequence + legacy_board_message.ordinal - 1,
  'text', NULL, legacy_board_message.root_need_id, legacy_board_message.source_thread_id,
  legacy_board_message.reply_to_id, NULL, 'agent', legacy_board_message.author_id,
  legacy_board_message.body, NULL, NULL, NULL, 'channel', '[]', '[]',
  legacy_board_message.time_created, legacy_board_message.time_updated
FROM legacy_board_message
INNER JOIN channel_counter ON channel_counter.channel_id = legacy_board_message.channel_id;
--> statement-breakpoint

UPDATE channel_counter
SET next_sequence = COALESCE((SELECT MAX(sequence) + 1 FROM channel_message WHERE channel_id = channel_counter.channel_id), 1),
    time_updated = unixepoch() * 1000;
--> statement-breakpoint

CREATE TABLE `channel_delivery` (
  `id` text PRIMARY KEY NOT NULL,
  `channel_id` text NOT NULL REFERENCES `channel`(`id`) ON DELETE CASCADE,
  `message_id` text NOT NULL REFERENCES `channel_message`(`id`) ON DELETE CASCADE,
  `agent_id` text NOT NULL REFERENCES `company_agent`(`id`) ON DELETE CASCADE,
  `trigger_kind` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `attempt` integer NOT NULL DEFAULT 0,
  `max_attempts` integer NOT NULL DEFAULT 3,
  `reason` text,
  `agent_run_id` text,
  `response_message_id` text,
  `next_attempt_at` integer,
  `time_started` integer,
  `time_finished` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  CONSTRAINT `channel_delivery_trigger_kind_check` CHECK (`trigger_kind` IN ('human', 'mention', 'agent', 'system')),
  CONSTRAINT `channel_delivery_status_check` CHECK (`status` IN ('pending', 'triaging', 'running', 'held', 'responded', 'passed', 'failed', 'cancelled'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX `channel_delivery_message_agent_idx` ON `channel_delivery` (`message_id`, `agent_id`);
--> statement-breakpoint
CREATE INDEX `channel_delivery_agent_status_idx` ON `channel_delivery` (`agent_id`, `status`, `next_attempt_at`, `time_created`);
--> statement-breakpoint
CREATE INDEX `channel_delivery_channel_status_idx` ON `channel_delivery` (`channel_id`, `status`, `time_created`);
--> statement-breakpoint

CREATE TABLE `channel_read_state` (
  `channel_id` text NOT NULL REFERENCES `channel`(`id`) ON DELETE CASCADE,
  `principal_kind` text NOT NULL,
  `principal_id` text NOT NULL,
  `last_read_sequence` integer NOT NULL DEFAULT 0,
  `last_shown_sequence` integer NOT NULL DEFAULT 0,
  `last_processed_sequence` integer NOT NULL DEFAULT 0,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY (`channel_id`, `principal_kind`, `principal_id`),
  CONSTRAINT `channel_read_state_principal_kind_check` CHECK (`principal_kind` IN ('user', 'agent'))
);
--> statement-breakpoint

CREATE INDEX `channel_read_state_principal_idx` ON `channel_read_state` (`principal_kind`, `principal_id`, `channel_id`);
--> statement-breakpoint

CREATE TABLE `channel_message_hold` (
  `channel_id` text NOT NULL REFERENCES `channel`(`id`) ON DELETE CASCADE,
  `agent_id` text NOT NULL REFERENCES `company_agent`(`id`) ON DELETE CASCADE,
  `delivery_id` text NOT NULL REFERENCES `channel_delivery`(`id`) ON DELETE CASCADE,
  `held_to_sequence` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `consumed_at` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY (`channel_id`, `agent_id`)
);
--> statement-breakpoint

CREATE INDEX `channel_message_hold_expiry_idx` ON `channel_message_hold` (`expires_at`);
--> statement-breakpoint

CREATE TABLE `channel_reaction` (
  `message_id` text NOT NULL REFERENCES `channel_message`(`id`) ON DELETE CASCADE,
  `principal_kind` text NOT NULL,
  `principal_id` text NOT NULL,
  `emoji` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY (`message_id`, `principal_kind`, `principal_id`, `emoji`),
  CONSTRAINT `channel_reaction_principal_kind_check` CHECK (`principal_kind` IN ('user', 'agent'))
);
--> statement-breakpoint

CREATE INDEX `channel_reaction_message_idx` ON `channel_reaction` (`message_id`, `time_created`);
--> statement-breakpoint

CREATE TABLE `channel_poll_vote` (
  `message_id` text NOT NULL REFERENCES `channel_message`(`id`) ON DELETE CASCADE,
  `option_id` text NOT NULL,
  `principal_kind` text NOT NULL,
  `principal_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY (`message_id`, `option_id`, `principal_kind`, `principal_id`),
  CONSTRAINT `channel_poll_vote_principal_kind_check` CHECK (`principal_kind` IN ('user', 'agent'))
);
--> statement-breakpoint

CREATE INDEX `channel_poll_vote_message_idx` ON `channel_poll_vote` (`message_id`, `time_created`);
--> statement-breakpoint

UPDATE conversation_run
SET state = 'interrupted', retryable = 0, safe_error_summary = 'Replaced by the persistent board group chat runtime', time_finished = unixepoch() * 1000, time_updated = unixepoch() * 1000
WHERE state IN ('queued', 'running', 'projecting')
  AND conversation_thread_id IN (
    SELECT conversation_thread.id
    FROM conversation_thread
    INNER JOIN channel ON channel.id = conversation_thread.channel_id
    WHERE channel.kind = 'board'
  );
