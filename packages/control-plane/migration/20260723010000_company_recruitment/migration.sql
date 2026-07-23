CREATE TABLE company_capability_need (
  id text PRIMARY KEY NOT NULL,
  company_id text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE,
  need_key text NOT NULL,
  role text NOT NULL,
  work_type text NOT NULL,
  capability_packs_json text NOT NULL,
  risk_level text NOT NULL,
  demand_horizon text NOT NULL,
  department_key text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT company_capability_need_work_type_check CHECK (work_type IN ('coding', 'decision', 'research', 'writing', 'design', 'analysis')),
  CONSTRAINT company_capability_need_risk_check CHECK (risk_level IN ('low', 'medium', 'high')),
  CONSTRAINT company_capability_need_horizon_check CHECK (demand_horizon IN ('project', 'recurring'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX company_capability_need_project_key_idx ON company_capability_need(project_id, need_key);
--> statement-breakpoint
CREATE INDEX company_capability_need_company_horizon_idx ON company_capability_need(company_id, demand_horizon, department_key);
--> statement-breakpoint
CREATE TABLE company_team_selection (
  id text PRIMARY KEY NOT NULL,
  company_id text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE,
  capability_need_id text NOT NULL REFERENCES company_capability_need(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES company_agent(id),
  decision text NOT NULL,
  source text NOT NULL,
  lifecycle_at_selection text NOT NULL,
  reason text NOT NULL,
  score_json text NOT NULL,
  time_released integer,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT company_team_selection_decision_check CHECK (decision IN ('selected', 'rejected')),
  CONSTRAINT company_team_selection_source_check CHECK (source IN ('company_pool', 'new_candidate')),
  CONSTRAINT company_team_selection_lifecycle_check CHECK (lifecycle_at_selection IN ('candidate', 'assigned', 'employee', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX company_team_selection_need_agent_idx ON company_team_selection(capability_need_id, agent_id);
--> statement-breakpoint
CREATE INDEX company_team_selection_project_decision_idx ON company_team_selection(project_id, decision);
--> statement-breakpoint
CREATE INDEX company_team_selection_agent_idx ON company_team_selection(agent_id, time_created);
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
CREATE UNIQUE INDEX company_agent_performance_selection_idx ON company_agent_performance(selection_id);
--> statement-breakpoint
CREATE INDEX company_agent_performance_agent_idx ON company_agent_performance(agent_id, time_created);
--> statement-breakpoint
CREATE TABLE company_employment_review (
  id text PRIMARY KEY NOT NULL,
  company_id text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES company_agent(id),
  status text NOT NULL,
  selected_project_count integer NOT NULL,
  successful_project_count integer NOT NULL,
  average_quality_score integer NOT NULL,
  average_reliability_score integer NOT NULL,
  recurring_need_count integer NOT NULL,
  rationale text NOT NULL,
  decision_note text,
  time_decided integer,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT company_employment_review_status_check CHECK (status IN ('proposed', 'approved', 'rejected')),
  CONSTRAINT company_employment_review_counts_check CHECK (
    selected_project_count >= 0 AND successful_project_count >= 0 AND recurring_need_count >= 0
  ),
  CONSTRAINT company_employment_review_quality_check CHECK (
    average_quality_score BETWEEN 0 AND 100 AND average_reliability_score BETWEEN 0 AND 100
  )
);
--> statement-breakpoint
CREATE INDEX company_employment_review_agent_status_idx ON company_employment_review(agent_id, status, time_created);
--> statement-breakpoint
CREATE TABLE company_department (
  id text PRIMARY KEY NOT NULL,
  company_id text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  department_key text NOT NULL,
  name text NOT NULL,
  purpose text NOT NULL,
  status text NOT NULL,
  recurring_project_count integer NOT NULL,
  evidence_json text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT company_department_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT company_department_recurring_count_check CHECK (recurring_project_count >= 2)
);
--> statement-breakpoint
CREATE UNIQUE INDEX company_department_company_key_idx ON company_department(company_id, department_key);
--> statement-breakpoint
CREATE INDEX company_department_company_status_idx ON company_department(company_id, status);
