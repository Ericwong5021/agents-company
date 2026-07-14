CREATE TABLE channel (
  id text PRIMARY KEY NOT NULL,
  company_id text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  kind text NOT NULL,
  scope_id text,
  title text NOT NULL,
  retention_days integer NOT NULL DEFAULT 0,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_archived integer,
  CONSTRAINT channel_kind_check CHECK (kind IN ('company', 'board', 'department', 'project', 'direct')),
  CONSTRAINT channel_project_scope_check CHECK (kind != 'project' OR scope_id IS NOT NULL),
  CONSTRAINT channel_retention_days_check CHECK (retention_days >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX channel_company_singleton_idx ON channel(company_id, kind) WHERE kind IN ('company', 'board');
--> statement-breakpoint
CREATE UNIQUE INDEX channel_project_scope_idx ON channel(company_id, scope_id) WHERE kind = 'project';
--> statement-breakpoint
CREATE INDEX channel_company_idx ON channel(company_id, time_created);
--> statement-breakpoint
CREATE TABLE channel_member (
  channel_id text NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  principal_kind text NOT NULL,
  principal_id text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  time_joined integer NOT NULL,
  time_left integer,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  PRIMARY KEY (channel_id, principal_kind, principal_id),
  CONSTRAINT channel_member_principal_kind_check CHECK (principal_kind IN ('user', 'agent')),
  CONSTRAINT channel_member_role_check CHECK (role IN ('member', 'owner'))
);
--> statement-breakpoint
CREATE INDEX channel_member_principal_idx ON channel_member(principal_kind, principal_id, channel_id);
--> statement-breakpoint
CREATE TABLE root_need (
  id text PRIMARY KEY NOT NULL,
  company_id text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  channel_id text NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  time_resolved integer,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT root_need_status_check CHECK (status IN ('open', 'in_progress', 'resolved', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX root_need_company_status_idx ON root_need(company_id, status, time_created);
--> statement-breakpoint
CREATE INDEX root_need_channel_idx ON root_need(channel_id, time_created);
--> statement-breakpoint
CREATE TABLE conversation_thread (
  id text PRIMARY KEY NOT NULL,
  company_id text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  channel_id text NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  root_need_id text REFERENCES root_need(id) ON DELETE SET NULL,
  project_scope_id text,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  time_archived integer,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT conversation_thread_status_check CHECK (status IN ('active', 'completed', 'interrupted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX conversation_thread_root_need_idx ON conversation_thread(root_need_id);
--> statement-breakpoint
CREATE INDEX conversation_thread_channel_updated_idx ON conversation_thread(channel_id, time_updated, id);
--> statement-breakpoint
CREATE INDEX conversation_thread_project_scope_idx ON conversation_thread(company_id, project_scope_id);
--> statement-breakpoint
CREATE TABLE conversation_thread_member (
  conversation_thread_id text NOT NULL REFERENCES conversation_thread(id) ON DELETE CASCADE,
  principal_kind text NOT NULL,
  principal_id text NOT NULL,
  time_joined integer NOT NULL,
  time_left integer,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  PRIMARY KEY (conversation_thread_id, principal_kind, principal_id),
  CONSTRAINT conversation_thread_member_principal_kind_check CHECK (principal_kind IN ('user', 'agent'))
);
--> statement-breakpoint
CREATE INDEX conversation_thread_member_principal_idx ON conversation_thread_member(principal_kind, principal_id, conversation_thread_id);
--> statement-breakpoint
CREATE TABLE channel_message (
  id text PRIMARY KEY NOT NULL,
  channel_id text NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  root_need_id text REFERENCES root_need(id) ON DELETE SET NULL,
  source_thread_id text REFERENCES conversation_thread(id) ON DELETE SET NULL,
  reply_to_id text REFERENCES channel_message(id) ON DELETE SET NULL,
  request_id text,
  author_kind text NOT NULL,
  author_id text NOT NULL,
  body text NOT NULL,
  signal_type text,
  dri_principal_kind text,
  dri_principal_id text,
  visibility text NOT NULL DEFAULT 'channel',
  mentions text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT channel_message_author_kind_check CHECK (author_kind IN ('user', 'agent', 'system')),
  CONSTRAINT channel_message_signal_type_check CHECK (signal_type IS NULL OR signal_type IN ('conclusion', 'decision', 'plan', 'status', 'risk', 'approval', 'delivery', 'intervention')),
  CONSTRAINT channel_message_dri_pair_check CHECK ((dri_principal_kind IS NULL) = (dri_principal_id IS NULL)),
  CONSTRAINT channel_message_decision_dri_check CHECK (signal_type != 'decision' OR dri_principal_id IS NOT NULL),
  CONSTRAINT channel_message_visibility_check CHECK (visibility IN ('channel', 'company'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX channel_message_request_idx ON channel_message(channel_id, request_id);
--> statement-breakpoint
CREATE INDEX channel_message_channel_time_created_id_idx ON channel_message(channel_id, time_created, id);
--> statement-breakpoint
CREATE INDEX channel_message_source_thread_idx ON channel_message(source_thread_id, time_created, id);
--> statement-breakpoint
CREATE INDEX channel_message_root_need_idx ON channel_message(root_need_id, time_created);
--> statement-breakpoint
CREATE TABLE conversation_run (
  id text PRIMARY KEY NOT NULL,
  conversation_thread_id text NOT NULL REFERENCES conversation_thread(id) ON DELETE CASCADE,
  channel_message_id text NOT NULL REFERENCES channel_message(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'queued',
  attempt integer NOT NULL DEFAULT 0,
  runtime_id text,
  runtime_round_num integer,
  source_watermark text,
  safe_error_summary text,
  retryable integer NOT NULL DEFAULT 0,
  time_started integer,
  time_finished integer,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT conversation_run_state_check CHECK (state IN ('queued', 'running', 'projecting', 'completed', 'failed', 'interrupted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX conversation_run_channel_message_idx ON conversation_run(channel_message_id);
--> statement-breakpoint
CREATE INDEX conversation_run_thread_state_idx ON conversation_run(conversation_thread_id, state, time_updated);
--> statement-breakpoint
CREATE INDEX conversation_run_runtime_idx ON conversation_run(runtime_id);
--> statement-breakpoint
CREATE TABLE signal_projection (
  id text PRIMARY KEY NOT NULL,
  channel_message_id text NOT NULL REFERENCES channel_message(id) ON DELETE CASCADE,
  conversation_thread_id text NOT NULL REFERENCES conversation_thread(id) ON DELETE CASCADE,
  conversation_run_id text REFERENCES conversation_run(id) ON DELETE SET NULL,
  projector_version integer NOT NULL,
  source_watermark text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX signal_projection_channel_message_idx ON signal_projection(channel_message_id);
--> statement-breakpoint
CREATE UNIQUE INDEX signal_projection_thread_version_watermark_idx ON signal_projection(conversation_thread_id, projector_version, source_watermark);
--> statement-breakpoint
CREATE INDEX signal_projection_run_idx ON signal_projection(conversation_run_id);
--> statement-breakpoint
CREATE TABLE signal_projection_source (
  signal_projection_id text NOT NULL REFERENCES signal_projection(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  PRIMARY KEY (signal_projection_id, ordinal),
  CONSTRAINT signal_projection_source_kind_check CHECK (source_kind IN ('group_message', 'message', 'part', 'agent_message', 'decision', 'artifact', 'gate'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX signal_projection_source_unique_idx ON signal_projection_source(signal_projection_id, source_kind, source_id);
--> statement-breakpoint
ALTER TABLE group_session ADD COLUMN context_policy text;
--> statement-breakpoint
ALTER TABLE group_message ADD COLUMN external_message_id text REFERENCES channel_message(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE group_message ADD COLUMN runtime_message_id text REFERENCES message(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX group_message_group_external_message_idx ON group_message(group_session_id, external_message_id);
--> statement-breakpoint
CREATE UNIQUE INDEX group_message_runtime_message_idx ON group_message(runtime_message_id);
--> statement-breakpoint
INSERT INTO channel (id, company_id, kind, scope_id, title, retention_days, time_created, time_updated)
SELECT 'chn_company', company.id, 'company', NULL, 'Company', 0, company.time_created, company.time_created
FROM company
WHERE NOT EXISTS (
  SELECT 1
  FROM channel
  WHERE channel.company_id = company.id
    AND channel.kind = 'company'
);
--> statement-breakpoint
INSERT INTO channel (id, company_id, kind, scope_id, title, retention_days, time_created, time_updated)
SELECT 'chn_board', company.id, 'board', NULL, 'Board', 0, company.time_created, company.time_created
FROM company
WHERE NOT EXISTS (
  SELECT 1
  FROM channel
  WHERE channel.company_id = company.id
    AND channel.kind = 'board'
);
--> statement-breakpoint
INSERT INTO channel_member (channel_id, principal_kind, principal_id, role, time_joined, time_created, time_updated)
SELECT channel.id, 'user', 'usr_local', 'owner', company.time_created, company.time_created, company.time_created
FROM channel
JOIN company ON company.id = channel.company_id
WHERE channel.id IN ('chn_company', 'chn_board')
  AND NOT EXISTS (
    SELECT 1
    FROM channel_member
    WHERE channel_member.channel_id = channel.id
      AND channel_member.principal_kind = 'user'
      AND channel_member.principal_id = 'usr_local'
  );
--> statement-breakpoint
INSERT INTO channel_member (channel_id, principal_kind, principal_id, role, time_joined, time_created, time_updated)
SELECT channel.id, 'agent', company_agent.id, 'member', company.time_created, company.time_created, company.time_created
FROM channel
JOIN company ON company.id = channel.company_id
JOIN company_agent ON company_agent.company_id = company.id
WHERE channel.id IN ('chn_company', 'chn_board')
  AND company_agent.id IN ('board-ceo', 'board-cto', 'board-product-lead')
  AND NOT EXISTS (
    SELECT 1
    FROM channel_member
    WHERE channel_member.channel_id = channel.id
      AND channel_member.principal_kind = 'agent'
      AND channel_member.principal_id = company_agent.id
  );
