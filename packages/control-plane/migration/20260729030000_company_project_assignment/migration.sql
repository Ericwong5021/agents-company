PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
ALTER TABLE company_capability_need RENAME TO company_capability_need_b0_legacy;
--> statement-breakpoint
ALTER TABLE company_team_selection RENAME TO company_team_selection_b0_legacy;
--> statement-breakpoint
ALTER TABLE company_agent_performance RENAME TO company_agent_performance_b0_legacy;
--> statement-breakpoint
CREATE TABLE company_capability_need (
  id text PRIMARY KEY NOT NULL,
  company_id text REFERENCES company(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE,
  work_item_id text REFERENCES company_work_item(id) ON DELETE CASCADE,
  source_receipt_id text REFERENCES company_work_receipt(id) ON DELETE SET NULL,
  need_key text NOT NULL,
  role text NOT NULL,
  work_type text NOT NULL,
  capability_packs_json text NOT NULL,
  risk_level text NOT NULL,
  demand_horizon text NOT NULL,
  department_key text,
  required_runtime_capabilities_json text NOT NULL DEFAULT '[]',
  required_tools_json text NOT NULL DEFAULT '[]',
  allowed_permission_modes_json text NOT NULL DEFAULT '["read_only","workspace_write"]',
  workspace_scopes_json text NOT NULL DEFAULT '[]',
  independent_from_agent_ids_json text NOT NULL DEFAULT '[]',
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT company_capability_need_work_type_check CHECK (work_type IN ('coding', 'decision', 'research', 'writing', 'design', 'analysis')),
  CONSTRAINT company_capability_need_risk_check CHECK (risk_level IN ('low', 'medium', 'high')),
  CONSTRAINT company_capability_need_horizon_check CHECK (demand_horizon IN ('project', 'recurring'))
);
--> statement-breakpoint
CREATE TABLE company_team_selection (
  id text PRIMARY KEY NOT NULL,
  company_id text REFERENCES company(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE,
  capability_need_id text NOT NULL REFERENCES company_capability_need(id) ON DELETE CASCADE,
  selection_round integer NOT NULL DEFAULT 1,
  agent_id text NOT NULL REFERENCES company_agent(id),
  decision text NOT NULL,
  source text NOT NULL,
  lifecycle_at_selection text NOT NULL,
  reason text NOT NULL,
  score_json text NOT NULL,
  constraint_results_json text NOT NULL DEFAULT '[]',
  time_released integer,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT company_team_selection_round_check CHECK (selection_round > 0),
  CONSTRAINT company_team_selection_decision_check CHECK (decision IN ('selected', 'rejected')),
  CONSTRAINT company_team_selection_source_check CHECK (source IN ('company_pool', 'new_candidate')),
  CONSTRAINT company_team_selection_lifecycle_check CHECK (lifecycle_at_selection IN ('candidate', 'assigned', 'employee', 'archived'))
);
--> statement-breakpoint
CREATE TABLE company_agent_performance (
  id text PRIMARY KEY NOT NULL,
  company_id text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE,
  selection_id text NOT NULL REFERENCES company_team_selection(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES company_agent(id),
  outcome text NOT NULL,
  quality_score integer NOT NULL,
  reliability_score integer NOT NULL,
  cost_score integer NOT NULL,
  speed_score integer NOT NULL,
  review_summary text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT company_agent_performance_outcome_check CHECK (outcome IN ('success', 'failure')),
  CONSTRAINT company_agent_performance_quality_check CHECK (quality_score BETWEEN 0 AND 100),
  CONSTRAINT company_agent_performance_reliability_check CHECK (reliability_score BETWEEN 0 AND 100),
  CONSTRAINT company_agent_performance_cost_check CHECK (cost_score BETWEEN 0 AND 100),
  CONSTRAINT company_agent_performance_speed_check CHECK (speed_score BETWEEN 0 AND 100)
);
--> statement-breakpoint
INSERT INTO company_capability_need (
  id,
  company_id,
  project_id,
  work_item_id,
  source_receipt_id,
  need_key,
  role,
  work_type,
  capability_packs_json,
  risk_level,
  demand_horizon,
  department_key,
  required_runtime_capabilities_json,
  required_tools_json,
  allowed_permission_modes_json,
  workspace_scopes_json,
  independent_from_agent_ids_json,
  time_created,
  time_updated
)
SELECT
  id,
  company_id,
  project_id,
  NULL,
  NULL,
  need_key,
  role,
  work_type,
  capability_packs_json,
  risk_level,
  demand_horizon,
  department_key,
  '[]',
  '[]',
  '["read_only","workspace_write"]',
  '[]',
  '[]',
  time_created,
  time_updated
FROM company_capability_need_b0_legacy;
--> statement-breakpoint
INSERT INTO company_team_selection (
  id,
  company_id,
  project_id,
  capability_need_id,
  selection_round,
  agent_id,
  decision,
  source,
  lifecycle_at_selection,
  reason,
  score_json,
  constraint_results_json,
  time_released,
  time_created,
  time_updated
)
SELECT
  id,
  company_id,
  project_id,
  capability_need_id,
  1,
  agent_id,
  decision,
  source,
  lifecycle_at_selection,
  reason,
  score_json,
  '[]',
  time_released,
  time_created,
  time_updated
FROM company_team_selection_b0_legacy;
--> statement-breakpoint
INSERT INTO company_agent_performance
SELECT
  id,
  company_id,
  project_id,
  selection_id,
  agent_id,
  outcome,
  quality_score,
  reliability_score,
  cost_score,
  speed_score,
  review_summary,
  time_created,
  time_updated
FROM company_agent_performance_b0_legacy;
--> statement-breakpoint
DROP TABLE company_agent_performance_b0_legacy;
--> statement-breakpoint
DROP TABLE company_team_selection_b0_legacy;
--> statement-breakpoint
DROP TABLE company_capability_need_b0_legacy;
--> statement-breakpoint
CREATE UNIQUE INDEX company_capability_need_project_key_idx ON company_capability_need(project_id, need_key);
--> statement-breakpoint
CREATE INDEX company_capability_need_company_horizon_idx ON company_capability_need(company_id, demand_horizon, department_key);
--> statement-breakpoint
CREATE INDEX company_capability_need_work_item_idx ON company_capability_need(work_item_id);
--> statement-breakpoint
CREATE UNIQUE INDEX company_team_selection_need_round_agent_idx ON company_team_selection(capability_need_id, selection_round, agent_id);
--> statement-breakpoint
CREATE UNIQUE INDEX company_team_selection_current_selected_idx ON company_team_selection(capability_need_id) WHERE decision = 'selected' AND time_released IS NULL;
--> statement-breakpoint
CREATE INDEX company_team_selection_project_decision_idx ON company_team_selection(project_id, decision);
--> statement-breakpoint
CREATE INDEX company_team_selection_agent_idx ON company_team_selection(agent_id, time_created);
--> statement-breakpoint
CREATE UNIQUE INDEX company_agent_performance_selection_idx ON company_agent_performance(selection_id);
--> statement-breakpoint
CREATE INDEX company_agent_performance_agent_idx ON company_agent_performance(agent_id, time_created);
--> statement-breakpoint
CREATE TABLE company_project_assignment (
  id text PRIMARY KEY NOT NULL,
  company_id text REFERENCES company(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE,
  work_item_id text NOT NULL REFERENCES company_work_item(id) ON DELETE CASCADE,
  capability_need_id text NOT NULL REFERENCES company_capability_need(id) ON DELETE CASCADE,
  selection_id text NOT NULL REFERENCES company_team_selection(id),
  agent_id text NOT NULL REFERENCES company_agent(id),
  version integer NOT NULL,
  idempotency_key text NOT NULL,
  supersedes_assignment_id text,
  temporary_role text NOT NULL,
  responsibility text NOT NULL,
  decision_scope_json text NOT NULL,
  resource_scope_json text NOT NULL,
  permission_mode text NOT NULL,
  source_receipt_id text REFERENCES company_work_receipt(id) ON DELETE SET NULL,
  status text NOT NULL,
  assigned_at integer NOT NULL,
  started_at integer,
  released_at integer,
  release_reason text,
  CONSTRAINT company_project_assignment_version_check CHECK (version > 0),
  CONSTRAINT company_project_assignment_permission_check CHECK (permission_mode IN ('read_only', 'workspace_write', 'full_access')),
  CONSTRAINT company_project_assignment_status_check CHECK (status IN ('assigned', 'active', 'released'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX company_project_assignment_current_work_item_idx ON company_project_assignment(work_item_id) WHERE status IN ('assigned', 'active');
--> statement-breakpoint
CREATE INDEX company_project_assignment_project_status_idx ON company_project_assignment(project_id, status);
--> statement-breakpoint
CREATE INDEX company_project_assignment_agent_status_idx ON company_project_assignment(agent_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX company_project_assignment_work_item_version_idx ON company_project_assignment(work_item_id, version);
--> statement-breakpoint
CREATE UNIQUE INDEX company_project_assignment_project_idempotency_idx ON company_project_assignment(project_id, idempotency_key);
--> statement-breakpoint
CREATE UNIQUE INDEX company_project_assignment_selection_idx ON company_project_assignment(selection_id);
