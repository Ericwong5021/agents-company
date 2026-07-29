import { afterEach, describe, expect, test } from "bun:test"
import { CompanyID } from "../../src/company/schema"
import { Instance } from "../../src/project/instance"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"
import {
  runAgents,
  runRecruitment,
  seedB0Project,
  writeB0Artifact,
} from "./b0-fixture"

afterEach(async () => {
  await resetDatabase()
})

describe("B0 selection constraints", () => {
  test("b0-selection-constraints rejects runtime, tool, permission, workspace and independence conflicts", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const companyID = CompanyID.parse("cmp_b0_constraints")
        seedB0Project({
          companyID,
          projectID: "cprj_b0_runtime",
          workItemID: "cwi_b0_runtime",
          role: "subagent coordinator",
        })
        await runAgents((service) =>
          service.create({
            id: "b0-runtime-pi",
            company_id: companyID,
            name: "PI Coordinator",
            lifecycle: "candidate",
            preferred_runtime: "pi",
            responsibilities: ["subagent coordinator", "analysis"],
          }),
        )
        await runAgents((service) =>
          service.create({
            id: "b0-runtime-codex",
            company_id: companyID,
            name: "Codex Coordinator",
            lifecycle: "candidate",
            preferred_runtime: "codex",
            responsibilities: ["subagent coordinator", "analysis"],
          }),
        )
        const runtimeNeed = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_b0_runtime",
            work_item_id: "cwi_b0_runtime",
            need_key: "runtime",
            role: "subagent coordinator",
            work_type: "analysis",
            capability_packs: ["research-analysis@1"],
            risk_level: "medium",
            demand_horizon: "project",
            required_runtime_capabilities: ["subagents", "structuredOutput", "workspaceRead"],
            required_tools: ["read", "websearch"],
            allowed_permission_modes: ["read_only"],
            workspace_scopes: ["artifacts/runtime"],
            independent_from_agent_ids: [],
          }),
        )
        const runtime = await runRecruitment((service) =>
          service.selectAndAssign({
            capability_need_id: runtimeNeed.id,
            exclude_agent_ids: [],
          }),
        )
        expect(String(runtime.agent.id)).toBe("b0-runtime-codex")
        expect(
          runtime.selections.find((selection) => selection.agent_id === "b0-runtime-pi"),
        ).toMatchObject({
          decision: "rejected",
          constraint_results: expect.arrayContaining([
            expect.objectContaining({ kind: "runtime", passed: false }),
          ]),
        })
        expect(
          runtime.selections.find((selection) => selection.agent_id === "b0-runtime-codex"),
        ).toMatchObject({
          decision: "selected",
          constraint_results: expect.arrayContaining([
            expect.objectContaining({ kind: "runtime", passed: true }),
            expect.objectContaining({ kind: "tool", passed: true }),
            expect.objectContaining({ kind: "permission", passed: true }),
            expect.objectContaining({ kind: "workspace", passed: true }),
            expect.objectContaining({ kind: "independence", passed: true }),
          ]),
        })

        seedB0Project({
          companyID,
          projectID: "cprj_b0_independence",
          workItemID: "cwi_b0_independence",
          role: "independent evidence reviewer",
        })
        await runAgents((service) =>
          service.create({
            id: "b0-review-conflict",
            company_id: companyID,
            name: "Conflicted Reviewer",
            lifecycle: "candidate",
            preferred_runtime: "codex",
            responsibilities: ["independent evidence reviewer", "analysis"],
          }),
        )
        await runAgents((service) =>
          service.create({
            id: "b0-review-independent",
            company_id: companyID,
            name: "Independent Reviewer",
            lifecycle: "candidate",
            preferred_runtime: "codex",
            responsibilities: ["independent evidence reviewer", "analysis"],
          }),
        )
        const independentNeed = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_b0_independence",
            work_item_id: "cwi_b0_independence",
            need_key: "independence",
            role: "independent evidence reviewer",
            work_type: "analysis",
            capability_packs: ["independent-review@1"],
            risk_level: "high",
            demand_horizon: "project",
            required_runtime_capabilities: ["toolCalls", "structuredOutput", "workspaceRead"],
            required_tools: ["read", "bash"],
            allowed_permission_modes: ["read_only"],
            workspace_scopes: ["artifacts/review"],
            independent_from_agent_ids: ["b0-review-conflict"],
          }),
        )
        const independent = await runRecruitment((service) =>
          service.selectAndAssign({
            capability_need_id: independentNeed.id,
            exclude_agent_ids: [],
          }),
        )
        expect(String(independent.agent.id)).toBe("b0-review-independent")
        expect(
          independent.selections.find((selection) => selection.agent_id === "b0-review-conflict"),
        ).toMatchObject({
          decision: "rejected",
          constraint_results: expect.arrayContaining([
            expect.objectContaining({ kind: "independence", passed: false }),
          ]),
        })

        seedB0Project({
          companyID,
          projectID: "cprj_b0_permission",
          workItemID: "cwi_b0_permission",
          role: "workspace implementation engineer",
          capabilityPacks: ["software-implementation@1"],
        })
        const permissionNeed = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_b0_permission",
            work_item_id: "cwi_b0_permission",
            need_key: "permission",
            role: "workspace implementation engineer",
            work_type: "coding",
            capability_packs: ["software-implementation@1"],
            risk_level: "high",
            demand_horizon: "project",
            required_runtime_capabilities: ["workspaceWrite"],
            required_tools: ["write"],
            allowed_permission_modes: ["read_only"],
            workspace_scopes: ["src"],
            independent_from_agent_ids: [],
          }),
        )
        const permissionFailure = await runRecruitment((service) =>
          service.selectAndAssign({
            capability_need_id: permissionNeed.id,
            exclude_agent_ids: [],
          }),
        ).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(permissionFailure).toBeInstanceOf(Error)
        expect(
          await runRecruitment((service) =>
            service.listAssignments({ project_id: "cprj_b0_permission" }),
          ),
        ).toEqual([])

        seedB0Project({
          companyID,
          projectID: "cprj_b0_tool",
          workItemID: "cwi_b0_tool",
          role: "unavailable tool operator",
        })
        const toolNeed = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_b0_tool",
            work_item_id: "cwi_b0_tool",
            need_key: "tool",
            role: "unavailable tool operator",
            work_type: "analysis",
            capability_packs: ["research-analysis@1"],
            risk_level: "medium",
            demand_horizon: "project",
            required_runtime_capabilities: ["toolCalls"],
            required_tools: ["missing-tool"],
            allowed_permission_modes: ["read_only"],
            workspace_scopes: ["artifacts/tool"],
            independent_from_agent_ids: [],
          }),
        )
        const toolFailure = await runRecruitment((service) =>
          service.selectAndAssign({
            capability_need_id: toolNeed.id,
            exclude_agent_ids: [],
          }),
        ).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(toolFailure).toBeInstanceOf(Error)
        expect(
          await runRecruitment((service) =>
            service.listAssignments({ project_id: "cprj_b0_tool" }),
          ),
        ).toEqual([])

        const otherCompanyID = CompanyID.parse("cmp_b0_constraints_other")
        seedB0Project({
          companyID: otherCompanyID,
          projectID: "cprj_b0_other",
          workItemID: "cwi_b0_other",
          role: "private workspace analyst",
        })
        await runAgents((service) =>
          service.create({
            id: "b0-other-company-agent",
            company_id: otherCompanyID,
            name: "Other Company Analyst",
            lifecycle: "candidate",
            preferred_runtime: "codex",
            responsibilities: ["private workspace analyst", "analysis"],
          }),
        )
        seedB0Project({
          companyID,
          projectID: "cprj_b0_workspace",
          workItemID: "cwi_b0_workspace",
          role: "private workspace analyst",
        })
        const workspaceNeed = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_b0_workspace",
            work_item_id: "cwi_b0_workspace",
            need_key: "workspace",
            role: "private workspace analyst",
            work_type: "analysis",
            capability_packs: ["research-analysis@1"],
            risk_level: "medium",
            demand_horizon: "project",
            required_runtime_capabilities: ["workspaceRead"],
            required_tools: ["read"],
            allowed_permission_modes: ["read_only"],
            workspace_scopes: ["private/company"],
            independent_from_agent_ids: [],
          }),
        )
        const workspace = await runRecruitment((service) =>
          service.selectAndAssign({
            capability_need_id: workspaceNeed.id,
            exclude_agent_ids: [],
          }),
        )
        expect(workspace.agent.company_id).toBe(companyID)
        expect(workspace.agent.id).not.toBe("b0-other-company-agent")

        await writeB0Artifact("selection-constraints", {
          schemaVersion: 1,
          scenarios: {
            runtime: { rejectedAgentId: "b0-runtime-pi", selectedAgentId: runtime.agent.id },
            tool: { blocked: toolFailure instanceof Error },
            permission: { blocked: permissionFailure instanceof Error },
            workspace: { selectedAgentId: workspace.agent.id, companyIsolated: true },
            independence: {
              rejectedAgentId: "b0-review-conflict",
              selectedAgentId: independent.agent.id,
            },
          },
        })
      },
    })
  })
})
