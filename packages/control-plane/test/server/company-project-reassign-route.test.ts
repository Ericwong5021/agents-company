import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CompanyAgentTable } from "../../src/company-agent/company-agent.sql"
import {
  CompanyCapabilityNeedTable,
  CompanyProjectAssignmentTable,
  CompanyTeamSelectionTable,
} from "../../src/company-recruitment/company-recruitment.sql"
import { CompanyProject } from "../../src/company-project"
import { CompanyProjectEventTable } from "../../src/company-project/company-project.sql"
import { CompanyID } from "../../src/company/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Server } from "../../src/server/server"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await resetDatabase()
})

describe.serial("POST /company/projects/:projectID/work-items/:workItemID/reassign", () => {
  test.serial("enforces rejected-review recruitment boundaries and only changes audited ownership", async () => {
    const app = Server.Default().app
    const companyID = CompanyID.parse((await (await app.request("/company")).json()).company.id)
    const setup = await AppRuntime.runPromise(
      CompanyProject.Service.use((service) =>
        Effect.gen(function* () {
          const project = yield* service.create({
            company_id: companyID,
            goal: "Correct a rejected worker assignment",
          })
          yield* service.transition({ id: project.id, status: "planning" })
          const plan = yield* service.createPlan({
            project_id: project.id,
            phase: "planning",
            summary: "Reassignment route",
            acceptance_criteria: ["Replacement is selected and independent"],
          })
          const worker = yield* service.createWorkItem({
            project_id: project.id,
            plan_id: plan.id,
            title: "Produce evidence",
            description: "Produce independently reviewable evidence",
            kind: "worker",
            work_type: "analysis",
            role: "analyst",
            model_group: "standard",
            owner_agent_id: "route-original-worker",
            acceptance_criteria: ["Evidence is complete"],
          })
          const reviewer = yield* service.createWorkItem({
            project_id: project.id,
            plan_id: plan.id,
            parent_id: worker.id,
            title: "Review evidence",
            description: "Review worker evidence",
            kind: "reviewer",
            work_type: "analysis",
            role: "independent reviewer",
            model_group: "standard",
            owner_agent_id: "route-reviewer",
            acceptance_criteria: ["Evidence is complete"],
            depends_on: [worker.id],
          })
          yield* service.startWorkItem(worker.id)
          yield* service.addArtifact({
            project_id: project.id,
            work_item_id: worker.id,
            kind: "analysis",
            title: "Rejected worker evidence",
            content: "{}",
          })
          yield* service.completeWorkItem(worker.id)
          yield* service.setWorkItemReview({ id: worker.id, review_status: "rejected" })
          yield* service.startWorkItem(reviewer.id)
          yield* service.addArtifact({
            project_id: project.id,
            work_item_id: reviewer.id,
            kind: "independent_review",
            title: "Rejected review",
            content: "{}",
          })
          yield* service.blockWorkItem({ id: reviewer.id, error: "Worker reused the reviewer identity" })
          return { project, worker, reviewer }
        }),
      ),
    )
    const now = Date.now()
    Database.transaction((db) => {
      db.insert(CompanyAgentTable)
        .values([
          {
            id: "route-original-worker",
            company_id: companyID,
            lifecycle: "assigned",
            name: "Original Worker",
            responsibilities: JSON.stringify(["replacement analyst", "analysis"]),
            time_created: now,
            time_updated: now,
          },
          {
            id: "route-replacement-worker",
            company_id: companyID,
            lifecycle: "assigned",
            name: "Replacement Worker",
            responsibilities: JSON.stringify(["replacement analyst", "analysis"]),
            time_created: now,
            time_updated: now,
          },
          {
            id: "route-reviewer",
            company_id: companyID,
            lifecycle: "assigned",
            name: "Reviewer",
            time_created: now,
            time_updated: now,
          },
          {
            id: "route-unselected-worker",
            company_id: companyID,
            lifecycle: "assigned",
            name: "Unselected Worker",
            responsibilities: JSON.stringify(["unrelated work"]),
            time_created: now,
            time_updated: now,
          },
          {
            id: "route-external-worker",
            company_id: null,
            lifecycle: "candidate",
            name: "External Worker",
            time_created: now,
            time_updated: now,
          },
        ])
        .run()
      db.insert(CompanyCapabilityNeedTable)
        .values({
          id: "need-route-replacement",
          company_id: companyID,
          project_id: setup.project.id,
          work_item_id: setup.worker.id,
          need_key: "replacement-analysis",
          role: "replacement analyst",
          work_type: "analysis",
          capability_packs_json: JSON.stringify(["independent-review@1"]),
          risk_level: "medium",
          demand_horizon: "project",
          department_key: null,
          time_created: now,
          time_updated: now,
        })
        .run()
      db.insert(CompanyTeamSelectionTable)
        .values({
          id: "selection-route-replacement",
          company_id: companyID,
          project_id: setup.project.id,
          capability_need_id: "need-route-replacement",
          agent_id: "route-original-worker",
          decision: "selected",
          source: "company_pool",
          lifecycle_at_selection: "assigned",
          reason: "Selected as the original project owner",
          score_json: JSON.stringify({
            capability_match: 2,
            availability: 100,
            historical_quality: 50,
            historical_reliability: 50,
            cost_efficiency: 50,
            speed: 50,
            risk_fit: 80,
            reuse_value: 40,
            total: 200,
          }),
          time_released: null,
          time_created: now,
          time_updated: now,
        })
        .run()
      db.insert(CompanyProjectAssignmentTable)
        .values({
          id: "assignment-route-original",
          company_id: companyID,
          project_id: setup.project.id,
          work_item_id: setup.worker.id,
          capability_need_id: "need-route-replacement",
          selection_id: "selection-route-replacement",
          agent_id: "route-original-worker",
          version: 1,
          idempotency_key: "route-original",
          supersedes_assignment_id: null,
          temporary_role: "replacement analyst",
          responsibility: "Produce independently reviewable evidence",
          decision_scope_json: "[]",
          resource_scope_json: "[]",
          permission_mode: "read_only",
          source_receipt_id: null,
          status: "active",
          assigned_at: now,
          started_at: now,
          released_at: null,
          release_reason: null,
        })
        .run()
    })
    const reassign = (workItemID: string, owner_agent_id: string, reason: string) =>
      app.request(`/company/projects/${setup.project.id}/work-items/${workItemID}/reassign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner_agent_id, reason }),
      })

    const activeProject = await reassign(
      setup.worker.id,
      "route-replacement-worker",
      "Replace invalid personnel reuse",
    )
    expect(activeProject.status).toBe(409)
    expect(await activeProject.json()).toMatchObject({
      data: { reason: "project_not_blocked" },
    })
    await AppRuntime.runPromise(
      CompanyProject.Service.use((service) => service.transition({ id: setup.project.id, status: "blocked" })),
    )

    const invalidReason = await reassign(setup.worker.id, "route-replacement-worker", " ")
    expect(invalidReason.status).toBe(400)
    const wrongTarget = await reassign(
      setup.reviewer.id,
      "route-replacement-worker",
      "Reviewer is not a worker target",
    )
    expect(wrongTarget.status).toBe(409)
    expect(await wrongTarget.json()).toMatchObject({ data: { reason: "worker_not_rejected" } })
    const external = await reassign(setup.worker.id, "route-external-worker", "External owner")
    expect(external.status).toBe(409)
    expect(await external.json()).toMatchObject({ data: { reason: "owner_not_company_member" } })
    const reviewer = await reassign(setup.worker.id, "route-reviewer", "Reviewer cannot execute rework")
    expect(reviewer.status).toBe(409)
    expect(await reviewer.json()).toMatchObject({ data: { reason: "owner_is_reviewer" } })
    const unselected = await reassign(setup.worker.id, "route-unselected-worker", "Unselected owner")
    expect(unselected.status).toBe(409)
    expect(await unselected.json()).toMatchObject({ data: { reason: "owner_not_selected" } })

    const response = await reassign(
      setup.worker.id,
      "route-replacement-worker",
      "Reviewer identified invalid personnel reuse",
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: setup.worker.id,
      owner_agent_id: "route-replacement-worker",
      status: "completed",
      review_status: "rejected",
    })
    const unchanged = await reassign(
      setup.worker.id,
      "route-replacement-worker",
      "Duplicate replacement request",
    )
    expect(unchanged.status).toBe(409)
    expect(await unchanged.json()).toMatchObject({ data: { reason: "owner_unchanged" } })

    const state = await AppRuntime.runPromise(
      CompanyProject.Service.use((service) =>
        Effect.all([service.get(setup.project.id), service.listWorkItems(setup.project.id)]),
      ),
    )
    expect(state[0]?.status).toBe("blocked")
    expect(state[1].find((item) => item.id === setup.worker.id)).toMatchObject({
      owner_agent_id: "route-replacement-worker",
      status: "completed",
      review_status: "rejected",
    })
    expect(state[1].find((item) => item.id === setup.reviewer.id)).toMatchObject({
      owner_agent_id: "route-reviewer",
      status: "blocked",
    })
    const events = Database.use((db) => db.select().from(CompanyProjectEventTable).all()).filter(
      (item) => item.type === "project_assignment.reassigned" && item.project_id === setup.project.id,
    )
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data_json)).toMatchObject({
      agent_id: "route-replacement-worker",
      supersedes_assignment_id: "assignment-route-original",
      reason: "Reviewer identified invalid personnel reuse",
    })
  })
})
