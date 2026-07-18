import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AgentRunTable } from "../../src/agent-run/agent-run.sql"
import * as CompanyActivity from "../../src/company/activity"
import { CompanyTable } from "../../src/company/company.sql"
import { CompanyID } from "../../src/company/schema"
import { CompanyAgentTable } from "../../src/company-agent/company-agent.sql"
import * as Database from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"

beforeEach(resetDatabase)
afterEach(resetDatabase)

describe("Company activity projection", () => {
  test("returns only employees with evidence-backed public run state", () => {
    const companyID = CompanyID.parse("cmp_activity")
    Database.use((db) => {
      db.insert(CompanyTable)
        .values({
          id: companyID,
          name: "Agent Company",
          data_version: 1,
          default_provider_id: "test",
          default_model_id: "test",
          bootstrap_request_id: "req_activity",
          bootstrap_input_path: "/tmp/activity",
          time_created: 1,
          time_updated: 1,
        })
        .run()
      db.insert(CompanyAgentTable)
        .values([
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
        ])
        .run()
      db.insert(AgentRunTable)
        .values({
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
        })
        .run()
    })

    expect(CompanyActivity.list(companyID)).toEqual([
      {
        agent: {
          id: "agent_employee",
          name: "Researcher",
          role: "researcher",
          lifecycle: "employee",
          responsibilities: ["核验证据"],
        },
        presence: "online",
        attention: "urgent",
        activity: "failed",
        location: "runtime",
        since: 2,
        interruptibility: "needs_intervention",
        risk: "上游证据不可达",
        collaborators: [],
        evidence: { kind: "agent_run", runID: "run_failed", timeUpdated: 3 },
      },
    ])
  })
})
