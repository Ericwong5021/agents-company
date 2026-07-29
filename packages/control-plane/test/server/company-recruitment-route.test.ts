import { afterEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { CompanyAgent } from "../../src/company-agent"
import { CompanyProjectTable } from "../../src/company-project/company-project.sql"
import { CompanyID } from "../../src/company/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Server } from "../../src/server/server"
import { Database } from "../../src/storage"
import { seedB0Project } from "../company-recruitment/b0-fixture"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await resetDatabase()
})

describe.serial("/company/recruitment", () => {
  test.serial("returns a product conflict when recurring department demand is not proven", async () => {
    const app = Server.Default().app
    const company = await (await app.request("/company")).json()
    const companyID = CompanyID.parse(company.company.id)
    const response = await app.request("/company/recruitment/departments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company_id: companyID,
        department_key: "research",
        name: "Research",
        purpose: "Sustain recurring evidence work",
      }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      name: "CompanyDepartmentRecurringDemandNotProven",
      data: {
        company_id: companyID,
        department_key: "research",
        recurring_project_count: 0,
        required_project_count: 2,
        message: "Department research requires recurring demand evidence from at least two projects",
      },
    })
  })

  test.serial("exposes durable team decisions without leaking private identity files", async () => {
    const app = Server.Default().app
    const company = await (await app.request("/company")).json()
    const companyID = CompanyID.parse(company.company.id)
    seedB0Project({
      companyID,
      projectID: "cprj_recruitment_route",
      workItemID: "cwi_recruitment_route",
      role: "evidence analyst",
      capabilityPacks: ["research-analysis@1"],
    })
    await AppRuntime.runPromise(
      CompanyAgent.Service.use((service) =>
        service.create({
          id: "route-evidence-analyst",
          company_id: companyID,
          name: "Route Evidence Analyst",
          lifecycle: "candidate",
          description: "Evidence analysis and source validation",
          system_prompt: "PRIVATE_SOUL_SENTINEL",
          instruct: "PRIVATE_INSTRUCT_SENTINEL",
          responsibilities: ["evidence analyst", "analysis", "research-analysis"],
        }),
      ),
    )

    const needResponse = await app.request("/company/recruitment/needs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company_id: companyID,
        project_id: "cprj_recruitment_route",
        work_item_id: "cwi_recruitment_route",
        need_key: "evidence-analysis",
        role: "evidence analyst",
        work_type: "analysis",
        capability_packs: ["research-analysis@1"],
        risk_level: "medium",
        demand_horizon: "project",
      }),
    })
    expect(needResponse.status).toBe(200)
    const need = await needResponse.json()
    const selectionResponse = await app.request(`/company/recruitment/needs/${need.id}/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exclude_agent_ids: [] }),
    })
    expect(selectionResponse.status).toBe(200)
    const selection = await selectionResponse.json()
    expect(selection.agent).toMatchObject({
      id: "route-evidence-analyst",
      company_id: companyID,
      lifecycle: "candidate",
    })
    expect(selection.assignment).toMatchObject({
      work_item_id: "cwi_recruitment_route",
      agent_id: "route-evidence-analyst",
      status: "assigned",
    })
    expect(JSON.stringify(selection)).not.toContain("PRIVATE_SOUL_SENTINEL")
    expect(JSON.stringify(selection)).not.toContain("PRIVATE_INSTRUCT_SENTINEL")
    expect(selection.selections.map((item: { decision: string }) => item.decision)).toEqual(
      expect.arrayContaining(["selected", "rejected"]),
    )
    const selected = selection.selections.find((item: { decision: string }) => item.decision === "selected")!
    Database.use((db) =>
      db
        .update(CompanyProjectTable)
        .set({ status: "blocked", updated_at: Date.now() })
        .where(eq(CompanyProjectTable.id, "cprj_recruitment_route"))
        .run(),
    )
    const performanceResponse = await app.request(
      `/company/recruitment/selections/${selected.id}/performance`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outcome: "success",
          quality_score: 99,
          reliability_score: 99,
          cost_score: 99,
          speed_score: 99,
          review_summary: "This score must not count before project completion.",
        }),
      },
    )
    expect(performanceResponse.status).toBe(409)
    expect(await performanceResponse.json()).toEqual({
      name: "CompanyPerformanceProjectNotCompleted",
      data: {
        selection_id: selected.id,
        project_id: "cprj_recruitment_route",
        project_status: "blocked",
        required_project_status: "completed",
        message: `Performance for selection ${selected.id} requires completed project cprj_recruitment_route`,
      },
    })

    const snapshot = await (
      await app.request(`/company/recruitment?company_id=${companyID}&project_id=cprj_recruitment_route`)
    ).json()
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_SOUL_SENTINEL")
    expect(snapshot.assigned_candidates).toEqual([
      expect.objectContaining({ id: "route-evidence-analyst", lifecycle: "candidate" }),
    ])
    const agents = await (await app.request(`/company/agents?company_id=${companyID}`)).json()
    expect(agents).toContainEqual(
      expect.objectContaining({
        employment: "temporary",
        agent: expect.objectContaining({ id: "route-evidence-analyst", lifecycle: "assigned" }),
      }),
    )
  })
})
