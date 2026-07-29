import { afterEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Instance } from "../../src/project/instance"
import { CompanyID } from "../../src/company/schema"
import { CompanyWorkItemTable } from "../../src/company-project/company-project.sql"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"
import {
  identitySnapshot,
  runAgents,
  runRecruitment,
  seedB0Project,
  writeB0Artifact,
} from "./b0-fixture"

afterEach(async () => {
  await resetDatabase()
})

describe("B0 assignment lifecycle", () => {
  test("b0-assignment-lifecycle traces company and standalone work without permanent identity mutation", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const companyID = CompanyID.parse("cmp_b0_assignment")
        seedB0Project({
          companyID,
          projectID: "cprj_b0_assignment_company",
          workItemID: "cwi_b0_assignment_company",
        })
        const employee = await runAgents((service) =>
          service.create({
            id: "b0-permanent-analyst",
            company_id: companyID,
            name: "Permanent Analyst",
            lifecycle: "employee",
            role_key: "permanent-analyst",
            preferred_runtime: "codex",
            department: "assurance",
            reports_to: "board-cto",
            responsibilities: ["evidence analyst", "analysis", "research"],
          }),
        )
        const before = identitySnapshot(employee.id)
        const need = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_b0_assignment_company",
            work_item_id: "cwi_b0_assignment_company",
            need_key: "company-evidence",
            role: "evidence analyst",
            work_type: "analysis",
            capability_packs: ["research-analysis@1"],
            risk_level: "medium",
            demand_horizon: "project",
            required_runtime_capabilities: ["structuredOutput", "workspaceRead"],
            required_tools: ["read"],
            allowed_permission_modes: ["read_only"],
            workspace_scopes: ["artifacts/cwi_b0_assignment_company"],
            independent_from_agent_ids: [],
          }),
        )
        const companyResult = await runRecruitment((service) =>
          service.selectAndAssign({
            capability_need_id: need.id,
            exclude_agent_ids: [],
          }),
        )
        expect(companyResult).toMatchObject({
          need: {
            id: need.id,
            work_item_id: "cwi_b0_assignment_company",
          },
          agent: {
            id: employee.id,
            lifecycle: "employee",
            role_key: "permanent-analyst",
          },
          assignment: {
            work_item_id: "cwi_b0_assignment_company",
            capability_need_id: need.id,
            selection_id: companyResult.assignment.selection_id,
            agent_id: employee.id,
            temporary_role: "evidence analyst",
            status: "assigned",
            version: 1,
          },
        })
        expect(
          Database.use((db) =>
            db
              .select({ owner_agent_id: CompanyWorkItemTable.owner_agent_id })
              .from(CompanyWorkItemTable)
              .where(eq(CompanyWorkItemTable.id, "cwi_b0_assignment_company"))
              .get(),
          ),
        ).toEqual({ owner_agent_id: employee.id })
        expect(identitySnapshot(employee.id)).toEqual(before)

        await runRecruitment((service) =>
          service.releaseProject({
            company_id: companyID,
            project_id: "cprj_b0_assignment_company",
          }),
        )
        expect(
          await runRecruitment((service) =>
            service.listAssignments({ project_id: "cprj_b0_assignment_company" }),
          ),
        ).toEqual([
          expect.objectContaining({
            id: companyResult.assignment.id,
            status: "released",
            release_reason: "project_terminal",
          }),
        ])
        expect(identitySnapshot(employee.id)).toEqual(before)

        seedB0Project({
          projectID: "cprj_b0_assignment_standalone",
          workItemID: "cwi_b0_assignment_standalone",
          role: "standalone evidence specialist",
        })
        const employeeCount = (await runAgents((service) => service.list())).filter(
          (agent) => agent.lifecycle === "employee",
        ).length
        const standaloneNeed = await runRecruitment((service) =>
          service.createNeed({
            project_id: "cprj_b0_assignment_standalone",
            work_item_id: "cwi_b0_assignment_standalone",
            need_key: "standalone-evidence",
            role: "standalone evidence specialist",
            work_type: "analysis",
            capability_packs: ["research-analysis@1"],
            risk_level: "medium",
            demand_horizon: "project",
            required_runtime_capabilities: ["structuredOutput", "workspaceRead"],
            required_tools: ["read"],
            allowed_permission_modes: ["read_only"],
            workspace_scopes: ["artifacts/cwi_b0_assignment_standalone"],
            independent_from_agent_ids: [],
          }),
        )
        const standalone = await runRecruitment((service) =>
          service.selectAndAssign({
            capability_need_id: standaloneNeed.id,
            exclude_agent_ids: [],
          }),
        )
        expect(standalone.agent).toMatchObject({
          lifecycle: "candidate",
        })
        expect(standalone.agent.company_id).toBeUndefined()
        expect(standalone.agent.role_key).toBeUndefined()
        expect(standalone.assignment).toMatchObject({
          work_item_id: "cwi_b0_assignment_standalone",
          agent_id: standalone.agent.id,
          version: 1,
          status: "assigned",
        })
        expect(
          (await runAgents((service) => service.list())).filter((agent) => agent.lifecycle === "employee"),
        ).toHaveLength(employeeCount)

        await writeB0Artifact("assignment-lifecycle", {
          schemaVersion: 1,
          scenarios: {
            company: {
              needId: need.id,
              selectionId: companyResult.assignment.selection_id,
              assignmentId: companyResult.assignment.id,
              identityUnchanged: true,
              released: true,
            },
            standalone: {
              needId: standaloneNeed.id,
              selectionId: standalone.assignment.selection_id,
              assignmentId: standalone.assignment.id,
              candidateOnly: true,
            },
          },
        })
      },
    })
  })
})
