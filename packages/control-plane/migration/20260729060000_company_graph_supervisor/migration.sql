ALTER TABLE company_project
ADD COLUMN orchestration_state text NOT NULL DEFAULT 'idle'
CHECK (orchestration_state IN ('idle', 'processing_receipt', 'dispatching', 'paused', 'quiescent', 'blocked'));
--> statement-breakpoint
ALTER TABLE company_project
ADD COLUMN orchestrator_version integer NOT NULL DEFAULT 1
CHECK (orchestrator_version > 0);
--> statement-breakpoint
ALTER TABLE company_project
ADD COLUMN dispatch_paused integer NOT NULL DEFAULT 0
CHECK (dispatch_paused IN (0, 1));
--> statement-breakpoint
ALTER TABLE company_work_receipt
ADD COLUMN processing_claim_id text;
--> statement-breakpoint
ALTER TABLE company_work_receipt
ADD COLUMN claimed_at integer;
--> statement-breakpoint
ALTER TABLE company_work_receipt
ADD COLUMN processed_decision_id text;
--> statement-breakpoint
UPDATE company_work_receipt
SET processing_status = 'pending',
    processing_claim_id = NULL,
    claimed_at = NULL
WHERE processing_status = 'processing';
--> statement-breakpoint
CREATE UNIQUE INDEX company_work_receipt_project_processing_idx
ON company_work_receipt (project_id)
WHERE processing_status = 'processing';
--> statement-breakpoint
CREATE TABLE company_graph_decision (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE,
  receipt_id text NOT NULL REFERENCES company_work_receipt(id) ON DELETE CASCADE,
  mutation_id text REFERENCES company_graph_mutation(id) ON DELETE SET NULL,
  expected_revision integer NOT NULL CHECK (expected_revision >= 0),
  orchestrator_version integer NOT NULL CHECK (orchestrator_version > 0),
  idempotency_key text NOT NULL,
  kind text NOT NULL CHECK (
    kind IN (
      'accept',
      'retry',
      'expand',
      'rewire',
      'supersede',
      'request_capability',
      'request_attention',
      'quiesce'
    )
  ),
  mode text NOT NULL CHECK (mode IN ('shadow', 'active')),
  reason_code text NOT NULL,
  summary text NOT NULL,
  evidence_refs_json text NOT NULL,
  operations_json text NOT NULL,
  automated integer NOT NULL CHECK (automated IN (0, 1)),
  added_node_count integer NOT NULL CHECK (added_node_count BETWEEN 0 AND 3),
  status text NOT NULL CHECK (status IN ('recorded', 'shadowed', 'applied', 'rejected', 'superseded')),
  created_at integer NOT NULL,
  resolved_at integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX company_graph_decision_project_idempotency_idx
ON company_graph_decision (project_id, idempotency_key);
--> statement-breakpoint
CREATE UNIQUE INDEX company_graph_decision_receipt_revision_idx
ON company_graph_decision (receipt_id, expected_revision);
--> statement-breakpoint
CREATE INDEX company_graph_decision_project_status_idx
ON company_graph_decision (project_id, status);
