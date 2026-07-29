CREATE TABLE company_agent_capability (
  id text PRIMARY KEY NOT NULL,
  company_id text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES company_agent(id) ON DELETE CASCADE,
  capability_pack text NOT NULL,
  source text NOT NULL,
  declared_at integer NOT NULL,
  last_verified_at integer,
  last_success_selection_id text,
  failure_count integer NOT NULL DEFAULT 0,
  last_failure_at integer,
  last_failure_summary text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT company_agent_capability_source_check CHECK (source IN ('profile', 'selection', 'delivery'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX company_agent_capability_agent_pack_idx ON company_agent_capability(agent_id, capability_pack);
--> statement-breakpoint
CREATE INDEX company_agent_capability_company_agent_idx ON company_agent_capability(company_id, agent_id);
