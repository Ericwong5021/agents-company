CREATE TABLE agent_run (
  id text PRIMARY KEY NOT NULL,
  agent_id text NOT NULL,
  runtime text NOT NULL,
  runtime_version text,
  workflow_version text,
  capability_checksum text,
  lifecycle text NOT NULL,
  permission_mode text NOT NULL,
  state text NOT NULL,
  session_id text,
  group_session_id text,
  workflow_run_id text,
  conversation_thread_id text,
  company_project_id text,
  work_item_id text,
  worktree_run_id text,
  model text,
  reasoning_effort text,
  cwd text NOT NULL,
  runtime_home_path text NOT NULL,
  resume_session_id text,
  exit_code integer,
  safe_error_summary text,
  time_started integer,
  time_finished integer,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT agent_run_runtime_check CHECK (runtime IN ('pi', 'claude-code', 'codex')),
  CONSTRAINT agent_run_lifecycle_check CHECK (lifecycle IN ('on_demand', 'idle_cached')),
  CONSTRAINT agent_run_permission_mode_check CHECK (permission_mode IN ('read_only', 'workspace_write', 'full_access')),
  CONSTRAINT agent_run_state_check CHECK (state IN ('queued', 'starting', 'running', 'interrupting', 'awaiting_recovery', 'completed', 'failed', 'stopped'))
);
--> statement-breakpoint
CREATE INDEX agent_run_state_idx ON agent_run(state, time_updated);
--> statement-breakpoint
CREATE INDEX agent_run_agent_idx ON agent_run(agent_id, time_created);
--> statement-breakpoint
CREATE INDEX agent_run_thread_idx ON agent_run(conversation_thread_id, time_created);
--> statement-breakpoint
CREATE INDEX agent_run_worktree_idx ON agent_run(worktree_run_id, state);
--> statement-breakpoint
CREATE TABLE agent_run_event (
  id text PRIMARY KEY NOT NULL,
  agent_run_id text NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  type text NOT NULL,
  payload_json text NOT NULL,
  time_created integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_run_event_sequence_idx ON agent_run_event(agent_run_id, sequence);
--> statement-breakpoint
CREATE INDEX agent_run_event_time_idx ON agent_run_event(agent_run_id, time_created);
--> statement-breakpoint
CREATE TABLE internal_execution_message (
  id text PRIMARY KEY NOT NULL,
  from_agent_id text NOT NULL,
  to_agent_id text NOT NULL,
  target_run_id text REFERENCES agent_run(id) ON DELETE SET NULL,
  priority text NOT NULL,
  body text NOT NULL,
  idempotency_key text,
  delivered_at integer,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT internal_execution_message_priority_check CHECK (priority IN ('steer', 'follow_up'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX internal_execution_message_idempotency_idx ON internal_execution_message(idempotency_key);
--> statement-breakpoint
CREATE INDEX internal_execution_message_pending_idx ON internal_execution_message(to_agent_id, delivered_at, priority, time_created);
--> statement-breakpoint
CREATE TABLE runtime_home (
  id text PRIMARY KEY NOT NULL,
  agent_run_id text NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  path text NOT NULL,
  state text NOT NULL,
  credential_mode text NOT NULL,
  disposition text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT runtime_home_state_check CHECK (state IN ('active', 'orphaned', 'destroyed')),
  CONSTRAINT runtime_home_credential_mode_check CHECK (credential_mode IN ('keychain', 'ephemeral'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX runtime_home_run_idx ON runtime_home(agent_run_id);
--> statement-breakpoint
CREATE UNIQUE INDEX runtime_home_path_idx ON runtime_home(path);
--> statement-breakpoint
CREATE INDEX runtime_home_state_idx ON runtime_home(state, time_updated);
--> statement-breakpoint
CREATE TABLE skill_snapshot (
  id text PRIMARY KEY NOT NULL,
  agent_run_id text NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  skill_id text NOT NULL,
  version text NOT NULL,
  checksum text NOT NULL,
  source_path text NOT NULL,
  snapshot_path text NOT NULL,
  activation_reason text NOT NULL,
  time_created integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX skill_snapshot_run_skill_idx ON skill_snapshot(agent_run_id, skill_id, checksum);
--> statement-breakpoint
CREATE INDEX skill_snapshot_run_idx ON skill_snapshot(agent_run_id, time_created);
--> statement-breakpoint
ALTER TABLE group_message ADD COLUMN agent_run_id text REFERENCES agent_run(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX group_message_agent_run_idx ON group_message(agent_run_id);
