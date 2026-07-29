import { Effect } from "effect"
import { Auth } from "@/auth"
import { AgentRun, AgentRunSupervisor } from "@/agent-run"
import { Config } from "@/config"
import * as Database from "@/storage/db"
import * as CompanySetupInstance from "./setup-instance"
import { CompanyResetInput, type CompanyResetInput as CompanyResetInputType } from "./schema"

const companyTables = [
  "signal_projection_source",
  "signal_projection",
  "conversation_run",
  "group_message",
  "group_session_member",
  "group_session",
  "channel_message",
  "conversation_thread_member",
  "conversation_thread",
  "root_need",
  "channel_member",
  "channel",
  "company_work_item_dependency",
  "company_approval_gate",
  "company_worktree_run",
  "company_validation_repair",
  "company_validation_gate",
  "company_graph_mutation",
  "company_work_receipt",
  "company_work_attempt",
  "company_artifact",
  "company_work_item",
  "company_plan",
  "company_project_charter",
  "company_project_event",
  "goal_brief_generation_request",
  "goal_brief_version",
  "goal_brief",
  "company_project",
  "agent_run_usage",
  "agent_run_event",
  "internal_execution_message",
  "skill_snapshot",
  "runtime_home",
  "agent_run",
  "workflow_run",
  "reputation_history",
  "reputation",
  "agent_message",
  "audit_event",
  "inbox",
  "task_event",
  "task",
  "actor_registry",
  "session_share",
  "external_import",
  "permission",
  "todo",
  "part",
  "message",
  "thread",
  "session",
  "history_fts",
  "memory_fts",
  "company_setup_goal",
  "repository_binding",
  "approval_policy",
  "company_agent",
  "company",
] as const

function clearCompanyDatabase() {
  Database.transaction((db) => {
    for (const table of companyTables) db.run(`DELETE FROM \`${table}\``)
  }, { behavior: "immediate" })
}

export const reset = Effect.fn("Company.reset")(function* (raw: CompanyResetInputType) {
  const input = CompanyResetInput.parse(raw)
  const runs = yield* AgentRun.Service
  const supervisor = yield* AgentRunSupervisor.Service
  const active = yield* runs.list()
  yield* Effect.forEach(
    active.filter((run) => ["queued", "starting", "running", "interrupting", "awaiting_recovery"].includes(run.state)),
    (run) => supervisor.interrupt(run.id).pipe(Effect.ignore),
    { discard: true },
  )

  if (input.clear_provider_config) {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    yield* Effect.forEach(Object.keys(yield* auth.all()), (providerID) => auth.remove(providerID), { discard: true })
    yield* config.resetProviderSettings()
  }

  yield* Effect.sync(clearCompanyDatabase)
  yield* CompanySetupInstance.dispose
})
