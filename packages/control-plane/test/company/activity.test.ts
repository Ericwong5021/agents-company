import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AgentRunTable } from "../../src/agent-run/agent-run.sql"
import * as CompanyActivity from "../../src/company/activity"
import { CompanyTable } from "../../src/company/company.sql"
import { CompanyID } from "../../src/company/schema"
import { CompanyAgentTable } from "../../src/company-agent/company-agent.sql"
import { ChannelTable, ConversationThreadTable } from "../../src/conversation/conversation.sql"
import { ChannelID, ConversationThreadID } from "../../src/conversation/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as Database from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"

beforeEach(resetDatabase)
afterEach(resetDatabase)

describe("Company activity projection", () => {
  test("returns employees and assigned instances with evidence-backed public run state", () => {
    const companyID = CompanyID.parse("cmp_activity")
    Database.use((db) => {
      db.insert(CompanyTable)
        .values({
          id: companyID,
          name: "Agent Company",
          data_version: 1,
          default_provider_id: ProviderID.zod.parse("test"),
          default_model_id: ModelID.zod.parse("test"),
          bootstrap_request_id: "req_activity",
          bootstrap_input_path: "/tmp/activity",
          time_created: 1,
          time_updated: 1,
        })
        .run()
      db.insert(CompanyAgentTable)
        .values([
          {
            id: "agent_active_employee",
            company_id: companyID,
            name: "Active Employee",
            lifecycle: "employee",
            time_created: 1,
            time_updated: 2,
          },
          {
            id: "agent_employee",
            company_id: companyID,
            name: "Researcher",
            lifecycle: "employee",
            role_key: "researcher",
            responsibilities: JSON.stringify(["核验证据"]),
            time_created: 1,
            time_updated: 1,
          },
          {
            id: "agent_candidate",
            company_id: companyID,
            name: "Candidate",
            lifecycle: "candidate",
            time_created: 1,
            time_updated: 1,
          },
          {
            id: "agent_idle_employee",
            company_id: companyID,
            name: "Idle Employee",
            lifecycle: "employee",
            time_created: 1,
            time_updated: 4,
          },
          {
            id: "agent_assigned",
            company_id: companyID,
            name: "Assigned Candidate",
            lifecycle: "assigned",
            time_created: 1,
            time_updated: 1,
          },
          {
            id: "agent_archived",
            company_id: companyID,
            name: "Archived Employee",
            lifecycle: "archived",
            time_created: 1,
            time_updated: 1,
          },
        ])
        .run()
      db.insert(AgentRunTable)
        .values([
          {
            id: "run_running",
            agent_id: "agent_active_employee",
            runtime: "pi",
            lifecycle: "on_demand",
            permission_mode: "workspace_write",
            state: "running",
            cwd: "/tmp/activity",
            runtime_home_path: "/tmp/activity/runtime-active",
            time_started: 3,
            time_created: 2,
            time_updated: 4,
          },
          {
            id: "run_failed",
            agent_id: "agent_employee",
            runtime: "pi",
            lifecycle: "on_demand",
            permission_mode: "workspace_write",
            state: "failed",
            cwd: "/tmp/activity",
            runtime_home_path: "/tmp/activity/runtime",
            safe_error_summary: "上游证据不可达",
            time_started: 2,
            time_created: 2,
            time_updated: 3,
          },
        ])
        .run()
    })

    const projection = CompanyActivity.list(companyID)
    expect(projection.filter((item) => item.presence === "online")).toHaveLength(1)
    expect(projection).toEqual([
      {
        agent: {
          id: "agent_active_employee",
          name: "Active Employee",
          lifecycle: "employee",
          responsibilities: [],
        },
        employment: "employee",
        presence: "online",
        attention: "focused",
        activity: "working",
        since: 3,
        interruptibility: "coordinate_first",
        collaborators: [],
        workload: { active: 0, blocked: 0 },
        evidence: { kind: "agent_run", runID: "run_running", timeUpdated: 4 },
      },
      // TEAM-01：在岗临时实例也进入团队视图，用 employment 区分组织身份。
      {
        agent: {
          id: "agent_assigned",
          name: "Assigned Candidate",
          lifecycle: "assigned",
          responsibilities: [],
        },
        employment: "temporary",
        presence: "offline",
        attention: "none",
        activity: "idle",
        since: 1,
        interruptibility: "interruptible",
        collaborators: [],
        workload: { active: 0, blocked: 0 },
      },
      {
        agent: {
          id: "agent_employee",
          name: "Researcher",
          role: "researcher",
          lifecycle: "employee",
          responsibilities: ["核验证据"],
        },
        employment: "employee",
        presence: "offline",
        attention: "none",
        activity: "failed",
        since: 2,
        interruptibility: "interruptible",
        risk: "上游证据不可达",
        collaborators: [],
        workload: { active: 0, blocked: 0 },
        evidence: { kind: "agent_run", runID: "run_failed", timeUpdated: 3 },
      },
      {
        agent: {
          id: "agent_idle_employee",
          name: "Idle Employee",
          lifecycle: "employee",
          responsibilities: [],
        },
        employment: "employee",
        presence: "offline",
        attention: "none",
        activity: "idle",
        since: 4,
        interruptibility: "interruptible",
        collaborators: [],
        workload: { active: 0, blocked: 0 },
      },
    ])
  })

  test("marks only attached run states online and keeps awaiting recovery offline", () => {
    const companyID = CompanyID.parse("cmp_activity_states")
    const states = [
      "queued",
      "starting",
      "running",
      "interrupting",
      "awaiting_recovery",
      "completed",
      "failed",
      "stopped",
      "unknown",
    ]
    Database.Client().$client.exec("PRAGMA ignore_check_constraints = ON")
    Database.use((db) => {
      db.insert(CompanyTable)
        .values({
          id: companyID,
          name: "Agent Company",
          data_version: 1,
          default_provider_id: ProviderID.zod.parse("test"),
          default_model_id: ModelID.zod.parse("test"),
          bootstrap_request_id: "req_activity_states",
          bootstrap_input_path: "/tmp/activity-states",
          time_created: 1,
          time_updated: 1,
        })
        .run()
      db.insert(CompanyAgentTable)
        .values(
          [...states, "no_run"].map((state, index) => ({
            id: `agent_${state}`,
            company_id: companyID,
            name: state,
            lifecycle: "employee",
            time_created: 1,
            time_updated: index + 1,
          })),
        )
        .run()
      db.insert(AgentRunTable)
        .values([
          ...states.map((state, index) => ({
            id: `run_${state}`,
            agent_id: `agent_${state}`,
            runtime: "pi",
            lifecycle: "on_demand",
            permission_mode: "workspace_write",
            state,
            cwd: "/tmp/activity-states",
            runtime_home_path: `/tmp/activity-states/${state}`,
            time_created: index + 2,
            time_updated: index + 2,
          })),
          {
            id: "run_awaiting_recovery_previous",
            agent_id: "agent_awaiting_recovery",
            runtime: "pi",
            lifecycle: "on_demand",
            permission_mode: "workspace_write",
            state: "running",
            cwd: "/tmp/activity-states",
            runtime_home_path: "/tmp/activity-states/awaiting-recovery-previous",
            time_created: 1,
            time_updated: 1,
          },
        ])
        .run()
    })
    Database.Client().$client.exec("PRAGMA ignore_check_constraints = OFF")

    const projections = Object.fromEntries(CompanyActivity.list(companyID).map((item) => [item.agent.id, item]))
    expect(states.filter((state) => projections[`agent_${state}`]?.presence === "online")).toEqual([
      "queued",
      "starting",
      "running",
      "interrupting",
    ])
    expect(projections.agent_awaiting_recovery).toMatchObject({
      presence: "offline",
      attention: "urgent",
      activity: "recovering",
      interruptibility: "needs_intervention",
      evidence: { runID: "run_awaiting_recovery" },
    })
    expect(
      ["completed", "failed", "stopped", "no_run"].map((state) => ({
        state,
        presence: projections[`agent_${state}`]?.presence,
        attention: projections[`agent_${state}`]?.attention,
      })),
    ).toEqual(
      ["completed", "failed", "stopped", "no_run"].map((state) => ({
        state,
        presence: "offline",
        attention: "none",
      })),
    )
    expect(projections.agent_unknown).toMatchObject({
      presence: "offline",
      attention: "urgent",
      activity: "interrupted",
      interruptibility: "needs_intervention",
      risk: "运行状态不可识别",
      evidence: { runID: "run_unknown" },
    })
  })

  test("projects public profile and conversation evidence from persisted facts", () => {
    const companyID = CompanyID.parse("cmp_activity_context")
    const channelID = ChannelID.parse("chn_activity_context")
    const threadID = ConversationThreadID.parse("cth_activity_context")
    Database.use((db) => {
      db.insert(CompanyTable)
        .values({
          id: companyID,
          name: "Agent Company",
          data_version: 1,
          default_provider_id: ProviderID.zod.parse("test"),
          default_model_id: ModelID.zod.parse("test"),
          bootstrap_request_id: "req_activity_context",
          bootstrap_input_path: "/tmp/activity-context",
          time_created: 1,
          time_updated: 1,
        })
        .run()
      db.insert(ChannelTable)
        .values({
          id: channelID,
          company_id: companyID,
          kind: "project",
          scope_id: "project-context",
          title: "Project Context",
          time_created: 1,
          time_updated: 1,
        })
        .run()
      db.insert(ConversationThreadTable)
        .values({
          id: threadID,
          company_id: companyID,
          channel_id: channelID,
          title: "Evidence Review",
          time_created: 1,
          time_updated: 1,
        })
        .run()
      db.insert(CompanyAgentTable)
        .values({
          id: "agent_context",
          company_id: companyID,
          name: "Context Agent",
          lifecycle: "employee",
          description: "Reviews evidence",
          department: "Quality",
          responsibilities: "{",
          time_created: 1,
          time_updated: 2,
        })
        .run()
      db.insert(AgentRunTable)
        .values({
          id: "run_context",
          agent_id: "agent_context",
          conversation_thread_id: threadID,
          runtime: "pi",
          lifecycle: "on_demand",
          permission_mode: "workspace_write",
          state: "queued",
          cwd: "/tmp/activity-context",
          runtime_home_path: "/tmp/activity-context/runtime",
          time_created: 2,
          time_updated: 3,
        })
        .run()
    })

    expect(CompanyActivity.list(companyID)).toEqual([
      {
        agent: {
          id: "agent_context",
          name: "Context Agent",
          description: "Reviews evidence",
          lifecycle: "employee",
          department: "Quality",
          responsibilities: [],
        },
        employment: "employee",
        presence: "online",
        attention: "focused",
        activity: "waiting",
        location: "Project Context",
        subject: "Evidence Review",
        since: 3,
        interruptibility: "interruptible",
        collaborators: [],
        workload: { active: 0, blocked: 0 },
        evidence: {
          kind: "agent_run",
          runID: "run_context",
          threadID,
          timeUpdated: 3,
        },
      },
    ])
  })
})
