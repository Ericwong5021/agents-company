ALTER TABLE company_work_receipt ADD COLUMN payload_kind TEXT;
--> statement-breakpoint
ALTER TABLE company_work_receipt ADD COLUMN typed_payload_json TEXT;
--> statement-breakpoint

ALTER TABLE company_outcome_signal ADD COLUMN company_id TEXT;
--> statement-breakpoint
ALTER TABLE company_outcome_signal ADD COLUMN validator_result_kind TEXT;
--> statement-breakpoint
ALTER TABLE company_outcome_signal ADD COLUMN validator_result_id TEXT;
--> statement-breakpoint
ALTER TABLE company_outcome_signal ADD COLUMN work_receipt_id TEXT REFERENCES company_work_receipt(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE company_outcome_signal ADD COLUMN metric_contract_kind TEXT;
--> statement-breakpoint
ALTER TABLE company_outcome_signal ADD COLUMN metric_contract_id TEXT;
--> statement-breakpoint
ALTER TABLE company_outcome_signal ADD COLUMN metric_contract_version INTEGER;
--> statement-breakpoint
ALTER TABLE company_outcome_signal ADD COLUMN observation_window_starts_at INTEGER;
--> statement-breakpoint
ALTER TABLE company_outcome_signal ADD COLUMN observation_window_ends_at INTEGER;
--> statement-breakpoint

UPDATE company_outcome_signal
SET company_id = COALESCE((
  SELECT company_project.company_id
  FROM company_project
  WHERE company_project.id = company_outcome_signal.project_id
), 'cmp_local'),
validator_result_kind = validator_kind,
validator_result_id = validator_id,
work_receipt_id = (
  SELECT json_extract(value, '$.id')
  FROM json_each(company_outcome_signal.source_refs_json)
  WHERE json_extract(value, '$.kind') = 'work_receipt'
  LIMIT 1
),
metric_contract_kind = 'project_metric_contract',
metric_contract_id = 'legacy:' || company_outcome_signal.project_id,
metric_contract_version = 1,
observation_window_starts_at = observed_at,
observation_window_ends_at = observed_at + 1;
--> statement-breakpoint

CREATE TABLE company_outcome_signal_transition (
  id TEXT PRIMARY KEY NOT NULL,
  outcome_signal_id TEXT NOT NULL REFERENCES company_outcome_signal(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  validator_result_kind TEXT,
  validator_result_id TEXT,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX company_outcome_signal_transition_sequence_idx
ON company_outcome_signal_transition(outcome_signal_id, sequence);
--> statement-breakpoint

CREATE UNIQUE INDEX company_outcome_signal_transition_idempotency_idx
ON company_outcome_signal_transition(outcome_signal_id, idempotency_key);
--> statement-breakpoint

INSERT INTO company_outcome_signal_transition (
  id,
  outcome_signal_id,
  sequence,
  idempotency_key,
  from_status,
  to_status,
  reason,
  actor_kind,
  actor_id,
  validator_result_kind,
  validator_result_id,
  occurred_at,
  created_at
)
SELECT
  'outcomeTransition_legacy_' || id,
  id,
  1,
  'legacy-observation:' || id,
  NULL,
  'observed',
  'Migrated legacy outcome as an unvalidated observation',
  'control_plane',
  NULL,
  validator_kind,
  validator_id,
  observed_at,
  created_at
FROM company_outcome_signal;
--> statement-breakpoint

CREATE TABLE company_outcome_signal_current (
  outcome_signal_id TEXT PRIMARY KEY NOT NULL REFERENCES company_outcome_signal(id) ON DELETE CASCADE,
  current_status TEXT NOT NULL,
  latest_transition_id TEXT NOT NULL REFERENCES company_outcome_signal_transition(id) ON DELETE RESTRICT,
  transition_count INTEGER NOT NULL,
  validated_at INTEGER,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint

CREATE INDEX company_outcome_signal_current_status_idx
ON company_outcome_signal_current(current_status, updated_at);
--> statement-breakpoint

INSERT INTO company_outcome_signal_current (
  outcome_signal_id,
  current_status,
  latest_transition_id,
  transition_count,
  validated_at,
  updated_at
)
SELECT
  id,
  'observed',
  'outcomeTransition_legacy_' || id,
  1,
  NULL,
  created_at
FROM company_outcome_signal;
--> statement-breakpoint

ALTER TABLE company_interpretation ADD COLUMN work_receipt_id TEXT REFERENCES company_work_receipt(id) ON DELETE RESTRICT;
--> statement-breakpoint

UPDATE company_interpretation
SET work_receipt_id = (
  SELECT company_work_receipt.id
  FROM company_work_receipt
  WHERE company_work_receipt.idempotency_key = 'knowledge-reading-receipt:' || company_interpretation.id
  LIMIT 1
);
--> statement-breakpoint

CREATE UNIQUE INDEX company_interpretation_work_receipt_idx
ON company_interpretation(work_receipt_id);
--> statement-breakpoint

ALTER TABLE company_commons_source ADD COLUMN capability_status TEXT NOT NULL DEFAULT 'unsupported';
--> statement-breakpoint

UPDATE company_commons_source
SET capability_status = CASE
  WHEN ingestion_status = 'blocked' THEN 'blocked'
  WHEN source_type IN ('text', 'markdown') OR adapter_id IS NOT NULL THEN 'supported'
  ELSE 'unsupported'
END;
