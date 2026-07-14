CREATE TABLE company (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  data_version integer NOT NULL,
  default_provider_id text NOT NULL,
  default_model_id text NOT NULL,
  bootstrap_request_id text NOT NULL,
  bootstrap_input_path text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX company_bootstrap_request_idx ON company(bootstrap_request_id);
--> statement-breakpoint
CREATE TABLE approval_policy (
  company_id text PRIMARY KEY NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  preset text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE repository_binding (
  id text PRIMARY KEY NOT NULL,
  company_id text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES project(id),
  root_path text NOT NULL,
  default_branch text NOT NULL,
  bootstrap_head_commit text,
  bootstrap_dirty integer NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX repository_binding_company_idx ON repository_binding(company_id);
--> statement-breakpoint
CREATE UNIQUE INDEX repository_binding_project_idx ON repository_binding(project_id);
--> statement-breakpoint
ALTER TABLE company_agent ADD company_id text REFERENCES company(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE company_agent ADD role_key text;
--> statement-breakpoint
ALTER TABLE company_agent ADD lifecycle text DEFAULT 'employee' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX company_agent_company_role_idx ON company_agent(company_id, role_key);
--> statement-breakpoint
CREATE TABLE local_client_credential (
  id text PRIMARY KEY NOT NULL,
  token_hash text NOT NULL,
  label text NOT NULL,
  time_last_used integer,
  time_revoked integer,
  time_created integer NOT NULL,
  time_updated integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX local_client_credential_hash_idx ON local_client_credential(token_hash);
