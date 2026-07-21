import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const AgentRunTable = sqliteTable(
  "agent_run",
  {
    id: text().primaryKey(),
    agent_id: text().notNull(),
    runtime: text().notNull(),
    runtime_version: text(),
    workflow_version: text(),
    capability_checksum: text(),
    lifecycle: text().notNull(),
    permission_mode: text().notNull(),
    state: text().notNull(),
    session_id: text(),
    group_session_id: text(),
    workflow_run_id: text(),
    conversation_thread_id: text(),
    company_project_id: text(),
    work_item_id: text(),
    worktree_run_id: text(),
    model: text(),
    reasoning_effort: text(),
    cwd: text().notNull(),
    runtime_home_path: text().notNull(),
    resume_session_id: text(),
    exit_code: integer(),
    safe_error_summary: text(),
    time_started: integer(),
    time_finished: integer(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("agent_run_state_idx").on(table.state, table.time_updated),
    index("agent_run_agent_idx").on(table.agent_id, table.time_created),
    index("agent_run_thread_idx").on(table.conversation_thread_id, table.time_created),
    index("agent_run_worktree_idx").on(table.worktree_run_id, table.state),
  ],
)

export const AgentRunEventTable = sqliteTable(
  "agent_run_event",
  {
    id: text().primaryKey(),
    agent_run_id: text()
      .notNull()
      .references(() => AgentRunTable.id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    type: text().notNull(),
    payload_json: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("agent_run_event_sequence_idx").on(table.agent_run_id, table.sequence),
    index("agent_run_event_time_idx").on(table.agent_run_id, table.time_created),
  ],
)

export const AgentRunUsageTable = sqliteTable("agent_run_usage", {
  agent_run_id: text()
    .primaryKey()
    .references(() => AgentRunTable.id, { onDelete: "cascade" }),
  source: text().notNull(),
  input_tokens: integer(),
  output_tokens: integer(),
  reasoning_tokens: integer(),
  cache_read_tokens: integer(),
  cache_write_tokens: integer(),
  time_updated: integer().notNull(),
})

export const InternalExecutionMessageTable = sqliteTable(
  "internal_execution_message",
  {
    id: text().primaryKey(),
    from_agent_id: text().notNull(),
    to_agent_id: text().notNull(),
    target_run_id: text().references(() => AgentRunTable.id, { onDelete: "set null" }),
    priority: text().notNull(),
    body: text().notNull(),
    idempotency_key: text(),
    delivered_at: integer(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("internal_execution_message_idempotency_idx").on(table.idempotency_key),
    index("internal_execution_message_pending_idx").on(table.to_agent_id, table.delivered_at, table.priority, table.time_created),
  ],
)

export const RuntimeHomeTable = sqliteTable(
  "runtime_home",
  {
    id: text().primaryKey(),
    agent_run_id: text()
      .notNull()
      .references(() => AgentRunTable.id, { onDelete: "cascade" }),
    path: text().notNull(),
    state: text().notNull(),
    credential_mode: text().notNull(),
    disposition: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("runtime_home_run_idx").on(table.agent_run_id),
    uniqueIndex("runtime_home_path_idx").on(table.path),
    index("runtime_home_state_idx").on(table.state, table.time_updated),
  ],
)

export const SkillSnapshotTable = sqliteTable(
  "skill_snapshot",
  {
    id: text().primaryKey(),
    agent_run_id: text()
      .notNull()
      .references(() => AgentRunTable.id, { onDelete: "cascade" }),
    skill_id: text().notNull(),
    version: text().notNull(),
    checksum: text().notNull(),
    source_path: text().notNull(),
    snapshot_path: text().notNull(),
    activation_reason: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("skill_snapshot_run_skill_idx").on(table.agent_run_id, table.skill_id, table.checksum),
    index("skill_snapshot_run_idx").on(table.agent_run_id, table.time_created),
  ],
)
