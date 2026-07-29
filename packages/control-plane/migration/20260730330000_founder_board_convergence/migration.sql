ALTER TABLE founder_advisor_convergence
ADD COLUMN current_request_key TEXT NOT NULL DEFAULT '';
--> statement-breakpoint

WITH ranked AS (
  SELECT
    founder_advisor_convergence.id,
    COALESCE(channel_message.request_id, founder_advisor_convergence.channel_message_id) AS request_key,
    ROW_NUMBER() OVER (
      PARTITION BY
        founder_advisor_convergence.company_id,
        founder_advisor_convergence.board_thread_id,
        COALESCE(channel_message.request_id, founder_advisor_convergence.channel_message_id)
      ORDER BY founder_advisor_convergence.created_at DESC, founder_advisor_convergence.id DESC
    ) AS request_rank
  FROM founder_advisor_convergence
  LEFT JOIN channel_message
    ON channel_message.id = founder_advisor_convergence.channel_message_id
)
UPDATE founder_advisor_convergence
SET current_request_key = (
  SELECT CASE
    WHEN ranked.request_rank = 1 THEN ranked.request_key
    ELSE ranked.request_key || ':historical:' || ranked.id
  END
  FROM ranked
  WHERE ranked.id = founder_advisor_convergence.id
);
--> statement-breakpoint

CREATE UNIQUE INDEX founder_advisor_convergence_current_request_idx
ON founder_advisor_convergence(company_id, board_thread_id, current_request_key);
--> statement-breakpoint

CREATE TABLE founder_advisor_convergence_event (
  id TEXT PRIMARY KEY NOT NULL,
  convergence_id TEXT NOT NULL REFERENCES founder_advisor_convergence(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX founder_advisor_convergence_event_sequence_idx
ON founder_advisor_convergence_event(convergence_id, sequence);
--> statement-breakpoint

CREATE UNIQUE INDEX founder_advisor_convergence_event_idempotency_idx
ON founder_advisor_convergence_event(convergence_id, idempotency_key);
--> statement-breakpoint

CREATE INDEX founder_advisor_convergence_event_created_idx
ON founder_advisor_convergence_event(convergence_id, created_at);
--> statement-breakpoint

INSERT INTO founder_advisor_convergence_event (
  id,
  convergence_id,
  sequence,
  idempotency_key,
  status,
  reason,
  created_at
)
SELECT
  'fadve_migrated_' || id,
  id,
  1,
  'migration',
  status,
  authority_reason,
  created_at
FROM founder_advisor_convergence;
