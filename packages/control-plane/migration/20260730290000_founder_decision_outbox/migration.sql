CREATE TABLE founder_decision_dispatch_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES founder_decision_record(id) ON DELETE CASCADE,
  transition_id TEXT REFERENCES founder_decision_transition(id) ON DELETE RESTRICT,
  consumer TEXT NOT NULL,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX founder_decision_dispatch_outbox_idempotency_idx
ON founder_decision_dispatch_outbox(decision_id, idempotency_key);

CREATE UNIQUE INDEX founder_decision_dispatch_outbox_execution_idx
ON founder_decision_dispatch_outbox(execution_key);

CREATE INDEX founder_decision_dispatch_outbox_consumer_idx
ON founder_decision_dispatch_outbox(consumer, created_at);

CREATE TABLE founder_decision_dispatch_event (
  id TEXT PRIMARY KEY NOT NULL,
  outbox_id TEXT NOT NULL REFERENCES founder_decision_dispatch_outbox(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  consumer_id TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  execution_receipt TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX founder_decision_dispatch_event_sequence_idx
ON founder_decision_dispatch_event(outbox_id, sequence);

CREATE UNIQUE INDEX founder_decision_dispatch_event_idempotency_idx
ON founder_decision_dispatch_event(outbox_id, idempotency_key);

CREATE INDEX founder_decision_dispatch_event_status_idx
ON founder_decision_dispatch_event(status, created_at);

CREATE TABLE founder_decision_dispatch_current (
  outbox_id TEXT PRIMARY KEY NOT NULL REFERENCES founder_decision_dispatch_outbox(id) ON DELETE CASCADE,
  current_status TEXT NOT NULL,
  latest_event_id TEXT NOT NULL REFERENCES founder_decision_dispatch_event(id) ON DELETE RESTRICT,
  event_count INTEGER NOT NULL,
  consumer_id TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  execution_receipt TEXT,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX founder_decision_dispatch_current_status_idx
ON founder_decision_dispatch_current(current_status, lease_expires_at, updated_at);
