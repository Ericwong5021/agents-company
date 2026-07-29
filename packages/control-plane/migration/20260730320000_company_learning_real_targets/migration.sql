ALTER TABLE company_patch_benchmark ADD COLUMN reviewer_principal_id TEXT REFERENCES company_agent(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE company_patch_benchmark ADD COLUMN report_author_id TEXT REFERENCES company_agent(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE company_patch_target_version ADD COLUMN target_version_ref TEXT;
--> statement-breakpoint

CREATE TABLE company_learning_benchmark_target_version (
  id TEXT PRIMARY KEY NOT NULL,
  patch_id TEXT NOT NULL REFERENCES company_learning_patch(id) ON DELETE RESTRICT,
  company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX company_learning_benchmark_target_patch_idx ON company_learning_benchmark_target_version(patch_id);
--> statement-breakpoint
CREATE UNIQUE INDEX company_learning_benchmark_target_version_idx ON company_learning_benchmark_target_version(company_id, target_id, version);
--> statement-breakpoint

CREATE TABLE company_learning_benchmark_target_selection (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  version_id TEXT REFERENCES company_learning_benchmark_target_version(id) ON DELETE RESTRICT,
  previous_version_id TEXT REFERENCES company_learning_benchmark_target_version(id) ON DELETE RESTRICT,
  selected_by TEXT NOT NULL,
  selected_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX company_learning_benchmark_target_current_idx ON company_learning_benchmark_target_selection(company_id, target_id, selected_at);
--> statement-breakpoint

CREATE TABLE company_learning_interest_target_version (
  id TEXT PRIMARY KEY NOT NULL,
  patch_id TEXT NOT NULL REFERENCES company_learning_patch(id) ON DELETE RESTRICT,
  company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES company_agent(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX company_learning_interest_target_patch_idx ON company_learning_interest_target_version(patch_id);
--> statement-breakpoint
CREATE UNIQUE INDEX company_learning_interest_target_version_idx ON company_learning_interest_target_version(company_id, agent_id, version);
--> statement-breakpoint

CREATE TABLE company_learning_interest_target_selection (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES company_agent(id) ON DELETE RESTRICT,
  version_id TEXT REFERENCES company_learning_interest_target_version(id) ON DELETE RESTRICT,
  previous_version_id TEXT REFERENCES company_learning_interest_target_version(id) ON DELETE RESTRICT,
  selected_by TEXT NOT NULL,
  selected_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX company_learning_interest_target_current_idx ON company_learning_interest_target_selection(company_id, agent_id, selected_at);
--> statement-breakpoint

CREATE TABLE company_learning_workflow_target_version (
  id TEXT PRIMARY KEY NOT NULL,
  patch_id TEXT NOT NULL REFERENCES company_learning_patch(id) ON DELETE RESTRICT,
  company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX company_learning_workflow_target_patch_idx ON company_learning_workflow_target_version(patch_id);
--> statement-breakpoint
CREATE UNIQUE INDEX company_learning_workflow_target_version_idx ON company_learning_workflow_target_version(company_id, target_id, version);
--> statement-breakpoint

CREATE TABLE company_learning_workflow_target_selection (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  version_id TEXT REFERENCES company_learning_workflow_target_version(id) ON DELETE RESTRICT,
  previous_version_id TEXT REFERENCES company_learning_workflow_target_version(id) ON DELETE RESTRICT,
  selected_by TEXT NOT NULL,
  selected_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX company_learning_workflow_target_current_idx ON company_learning_workflow_target_selection(company_id, target_id, selected_at);
--> statement-breakpoint

CREATE TABLE company_work_receipt_learning_target_ref (
  receipt_id TEXT NOT NULL REFERENCES company_work_receipt(id) ON DELETE CASCADE,
  target_version_id TEXT NOT NULL REFERENCES company_patch_target_version(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL CHECK(target_type IN ('governance_asset','delegation_policy','skill','benchmark','agent_interest','workflow')),
  target_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX company_work_receipt_learning_target_ref_idx ON company_work_receipt_learning_target_ref(receipt_id, target_version_id);
--> statement-breakpoint
CREATE INDEX company_work_receipt_learning_target_version_idx ON company_work_receipt_learning_target_ref(target_version_id, receipt_id);
--> statement-breakpoint
