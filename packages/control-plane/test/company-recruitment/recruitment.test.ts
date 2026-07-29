import { afterEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { CompanyAgent } from "../../src/company-agent"
import { CompanyAgentID } from "../../src/company-agent/schema"
import {
  CompanyPlanTable,
  CompanyProjectTable,
  CompanyWorkItemTable,
} from "../../src/company-project/company-project.sql"
import {
  CompanyRecruitment,
  DepartmentRecurringDemandNotProven,
  PerformanceProjectNotCompleted,
  stableCandidateAgentID,
  stableLogicalKey,
} from "../../src/company-recruitment"
import * as CompanyActivity from "../../src/company/activity"
import { CompanyTable } from "../../src/company/company.sql"
import { CompanyID } from "../../src/company/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

function runRecruitment<A>(fn: (service: CompanyRecruitment.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(CompanyRecruitment.Service.use(fn).pipe(Effect.provide(CompanyRecruitment.defaultLayer)))
}

function runAgents<A>(fn: (service: CompanyAgent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(CompanyAgent.Service.use(fn).pipe(Effect.provide(CompanyAgent.defaultLayer)))
}

function seed(companyID: CompanyID, projectIDs: string[]) {
  const now = Date.now()
  Database.use((db) => {
    db.insert(CompanyTable)
      .values({
        id: companyID,
        name: "Recruitment Test Company",
        data_version: 1,
        default_provider_id: ProviderID.make("test"),
        default_model_id: ModelID.make("test-model"),
        bootstrap_request_id: crypto.randomUUID(),
        bootstrap_input_path: "/tmp/recruitment-test",
        time_created: now,
        time_updated: now,
      })
      .run()
    db.insert(CompanyProjectTable)
      .values(
        projectIDs.map((id) => ({
          id,
          company_id: companyID,
          goal: `Goal for ${id}`,
          title: id,
          status: "planning",
          output_dir: `/tmp/${id}`,
          created_at: now,
          updated_at: now,
        })),
      )
      .run()
    db.insert(CompanyPlanTable)
      .values(
        projectIDs.map((id) => ({
          id: `${id}-plan`,
          project_id: id,
          version: 1,
          phase: "planning",
          status: "active",
          summary: "Recruitment test plan",
          assumptions_json: "[]",
          acceptance_criteria_json: "[]",
          change_reason: null,
          created_at: now,
        })),
      )
      .run()
    db.insert(CompanyWorkItemTable)
      .values(
        projectIDs.map((id) => ({
          id: `${id}-work-item`,
          project_id: id,
          plan_id: `${id}-plan`,
          source_task_key: "recruitment",
          parent_id: null,
          title: "Recruitment work item",
          description: "Recruit and assign one agent",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          capability_packs_json: JSON.stringify(["research-analysis@1"]),
          decision_scope_json: "[]",
          resource_scope_json: JSON.stringify([`artifacts/${id}`]),
          inputs_json: "[]",
          expected_outputs_json: "[]",
          validators_json: "[]",
          disposition: "retain",
          model_group: "standard",
          risk_level: "medium",
          review_status: "pending",
          status: "pending",
          purpose: "delivery",
          origin_kind: "legacy",
          origin_ref_id: null,
          graph_revision_created: 0,
          validation_mode: "independent_review",
          superseded_by_id: null,
          owner_agent_id: null,
          workflow_run_id: null,
          acceptance_criteria_json: "[]",
          attempt: 0,
          max_attempts: 3,
          error: null,
          started_at: null,
          completed_at: null,
          created_at: now,
          updated_at: now,
        })),
      )
      .run()
  })
}

function setProjectStatus(projectID: string, status: "blocked" | "completed") {
  Database.use((db) =>
    db
      .update(CompanyProjectTable)
      .set({
        status,
        updated_at: Date.now(),
        completed_at: status === "completed" ? Date.now() : null,
      })
      .where(eq(CompanyProjectTable.id, projectID))
      .run(),
  )
}

afterEach(async () => {
  await resetDatabase()
})

describe("company recruitment", () => {
  test("keeps stable hash tails for long logical keys and candidate identities", () => {
    const original = "independent_review_and_acceptance"
    expect(stableLogicalKey(original)).toBe(original)
    expect(CompanyRecruitment.stableLogicalKey(original)).toBe(original)
    expect(stableLogicalKey(`${original}-review`)).not.toBe(stableLogicalKey(original))

    const prefix = "independent_review_and_acceptance_".repeat(4)
    const worker = stableLogicalKey(`${prefix}worker`)
    const reviewer = stableLogicalKey(`${prefix}reviewer`)

    expect(worker).not.toBe(reviewer)
    expect(worker).toHaveLength(100)
    expect(reviewer).toHaveLength(100)
    expect(worker).toMatch(/-[a-f0-9]{16}$/)
    expect(reviewer).toMatch(/-[a-f0-9]{16}$/)
    expect(stableLogicalKey(`${prefix}worker`)).toBe(worker)

    const base = {
      company_id: "cmp_identity",
      project_id: "cprj_identity",
      need_key: worker,
      role: "evidence reviewer",
    }
    const ids = [
      stableCandidateAgentID(base),
      stableCandidateAgentID({ ...base, company_id: "cmp_identity_other" }),
      stableCandidateAgentID({ ...base, project_id: "cprj_identity_other" }),
      stableCandidateAgentID({ ...base, need_key: reviewer }),
      stableCandidateAgentID({ ...base, role: "evidence worker" }),
    ]

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.length <= 72)).toBe(true)
    expect(ids.every((id) => /-[a-f0-9]{16}$/.test(id))).toBe(true)
  })

  test("creates capability needs atomically, canonicalizes packs and keeps long worker and reviewer keys distinct", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const companyID = CompanyID.parse("cmp_recruitment_identity")
        seed(companyID, ["cprj_recruitment_identity"])
        const prefix = "independent_review_and_acceptance_".repeat(4)
        const workerKey = stableLogicalKey(`${prefix}worker`)
        const reviewerKey = stableLogicalKey(`${prefix}reviewer`)
        const input = {
          company_id: companyID,
          project_id: "cprj_recruitment_identity",
          work_item_id: "cprj_recruitment_identity-work-item",
          need_key: workerKey,
          role: "opaque delivery worker",
          work_type: "analysis" as const,
          capability_packs: ["research-analysis@1", "independent-review@1", "research-analysis@1"],
          risk_level: "medium" as const,
          demand_horizon: "project" as const,
        }
        const concurrent = await Promise.all(
          Array.from({ length: 12 }, () => runRecruitment((service) => service.createNeed(input))),
        )

        expect(new Set(concurrent.map((need) => need.id)).size).toBe(1)
        expect(concurrent[0]?.capability_packs).toEqual(["independent-review@1", "research-analysis@1"])
        const repeated = await runRecruitment((service) =>
          service.createNeed({
            ...input,
            capability_packs: ["independent-review@1", "research-analysis@1"],
          }),
        )
        expect(repeated.id).toBe(concurrent[0]?.id)

        const conflict = await runRecruitment((service) =>
          service.createNeed({ ...input, role: "different role" }),
        ).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(conflict).toBeInstanceOf(Error)
        if (!(conflict instanceof Error)) throw new Error("Expected conflicting capability facts to fail")
        expect(conflict.message).toContain("already exists with different facts")

        const reviewerNeed = await runRecruitment((service) =>
          service.createNeed({
            ...input,
            need_key: reviewerKey,
            role: "opaque independent reviewer",
            capability_packs: ["independent-review@1"],
          }),
        )
        expect(reviewerNeed.need_key).not.toBe(repeated.need_key)

        const worker = await runRecruitment((service) =>
          service.selectForNeed({ capability_need_id: repeated.id, exclude_agent_ids: [] }),
        )
        const reviewer = await runRecruitment((service) =>
          service.selectForNeed({ capability_need_id: reviewerNeed.id, exclude_agent_ids: [worker.agent.id] }),
        )
        expect(worker.agent.id).toBe(stableCandidateAgentID(repeated))
        expect(reviewer.agent.id).toBe(stableCandidateAgentID(reviewerNeed))
        expect(worker.agent.id).not.toBe(reviewer.agent.id)
        expect(worker.agent.id.length).toBeLessThanOrEqual(72)
        expect(reviewer.agent.id.length).toBeLessThanOrEqual(72)
        expect(worker.agent.id).toMatch(/-[a-f0-9]{16}$/)
        expect(reviewer.agent.id).toMatch(/-[a-f0-9]{16}$/)
      },
    })
  })

  test("persists capability matching, selected and rejected reasons, company ownership and candidate release", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const companyID = CompanyID.parse("cmp_recruitment_one")
        seed(companyID, ["cprj_recruitment_one"])
        await runAgents((service) =>
          service.create({
            id: "evidence-analyst",
            company_id: companyID,
            name: "Evidence Analyst",
            lifecycle: "candidate",
            description: "Analysis and evidence synthesis",
            responsibilities: ["evidence analyst", "analysis", "evidence-synthesis"],
          }),
        )
        await runAgents((service) =>
          service.create({
            id: "visual-designer",
            company_id: companyID,
            name: "Visual Designer",
            lifecycle: "candidate",
            description: "Visual design",
            responsibilities: ["design"],
          }),
        )
        await runAgents((service) =>
          service.create({
            id: "evidence-archivist",
            company_id: companyID,
            name: "Evidence Archivist",
            lifecycle: "candidate",
            description: "Analysis support",
            responsibilities: ["analysis"],
          }),
        )
        const need = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_recruitment_one",
            work_item_id: "cprj_recruitment_one-work-item",
            need_key: "evidence-analysis",
            role: "evidence analyst",
            work_type: "analysis",
            capability_packs: ["research-analysis@1"],
            risk_level: "medium",
            demand_horizon: "project",
          }),
        )
        const result = await runRecruitment((service) =>
          service.selectAndAssign({ capability_need_id: need.id, exclude_agent_ids: [] }),
        )

        expect(result.agent).toMatchObject({
          id: "evidence-analyst",
          company_id: companyID,
          lifecycle: "candidate",
          role_key: undefined,
        })
        expect(result.selections.map((item) => item.decision)).toEqual(["selected", "rejected", "rejected"])
        expect(result.selections.every((item) => item.reason.length > 10)).toBe(true)
        // TEAM-04: the selected reason points back to capability evidence and runtime state.
        const selectedRow = result.selections.find((item) => item.decision === "selected")!
        expect(selectedRow.candidate_rank).toBe(1)
        expect(selectedRow.reason).toContain("能力证据强度")
        expect(selectedRow.reason).toContain("负载可用性")
        // Hard-constraint rejection records rank 0 and factual gaps, not a bare match score.
        const designer = result.selections.find((item) => item.agent_id === "visual-designer")!
        expect(designer.candidate_rank).toBe(0)
        expect(designer.gaps).toEqual(["对所需能力包既无可用能力证据，也无可验证的画像匹配"])
        expect(designer.reason).toContain("未入选")
        // The runner-up is persisted with rank 2 and its dimension deficits.
        const runnerUp = result.selections.find((item) => item.agent_id === "evidence-archivist")!
        expect(runnerUp.candidate_rank).toBe(2)
        expect(runnerUp.reason).toContain("第二候选")
        expect(runnerUp.gaps).toContain("能力匹配 2 项低于入选者 3 项")
        // TEAM-01：在岗临时实例进入团队视图，但组织身份是 temporary 而不是正式员工。
        const activity = CompanyActivity.list(companyID).find((item) => item.agent.id === "evidence-analyst")
        expect(activity).toMatchObject({ employment: "temporary", agent: { lifecycle: "assigned" } })

        const released = await runRecruitment((service) =>
          service.releaseProject({ company_id: companyID, project_id: "cprj_recruitment_one" }),
        )
        expect(released[0]?.time_released).toBeNumber()
        const reselected = await runRecruitment((service) =>
          service.selectForNeed({ capability_need_id: need.id, exclude_agent_ids: [] }),
        )
        expect(reselected.agent).toMatchObject({
          id: "evidence-analyst",
          lifecycle: "candidate",
        })
        expect(reselected.selections.filter((item) => item.decision === "selected")).toHaveLength(2)
        expect(reselected.selections.find((item) => item.decision === "selected" && !item.time_released)?.id).not.toBe(
          released.find((item) => item.decision === "selected")?.id,
        )
        await runRecruitment((service) =>
          service.releaseProject({ company_id: companyID, project_id: "cprj_recruitment_one" }),
        )
        expect(await runAgents((service) => service.get(CompanyAgentID.make("evidence-analyst")))).toMatchObject({
          lifecycle: "candidate",
        })
      },
    })
  })

  test("reuses a candidate, gates formal employment on evidence and creates departments only for recurring demand", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const companyID = CompanyID.parse("cmp_recruitment_reuse")
        seed(companyID, ["cprj_recruitment_alpha", "cprj_recruitment_beta"])
        const firstNeed = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_recruitment_alpha",
            work_item_id: "cprj_recruitment_alpha-work-item",
            need_key: "research",
            role: "research analyst",
            work_type: "research",
            capability_packs: ["research-analysis@1"],
            risk_level: "medium",
            demand_horizon: "recurring",
            department_key: "research",
          }),
        )
        const first = await runRecruitment((service) =>
          service.selectAndAssign({ capability_need_id: firstNeed.id, exclude_agent_ids: [] }),
        )
        expect(first.agent.lifecycle).toBe("candidate")
        expect(first.assignment.temporary_role).toBe("research analyst")
        const firstSelection = first.selections.find((item) => item.decision === "selected")!
        setProjectStatus("cprj_recruitment_alpha", "completed")
        await runRecruitment((service) =>
          service.recordPerformance({
            selection_id: firstSelection.id,
            outcome: "success",
            quality_score: 92,
            reliability_score: 95,
            cost_score: 86,
            speed_score: 88,
            review_summary: "Independent review accepted the evidence package.",
          }),
        )
        const departmentBeforeRecurringDemand = await runRecruitment((service) =>
          service.ensureDepartment({
            company_id: companyID,
            department_key: "research",
            name: "Research",
            purpose: "Recurring evidence and source validation work",
          }),
        ).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(DepartmentRecurringDemandNotProven.isInstance(departmentBeforeRecurringDemand)).toBe(true)
        if (!DepartmentRecurringDemandNotProven.isInstance(departmentBeforeRecurringDemand))
          throw new Error("Expected department creation to fail before recurring demand was proven")
        expect(departmentBeforeRecurringDemand.data).toMatchObject({
          recurring_project_count: 1,
          required_project_count: 2,
          message: expect.stringContaining("at least two projects"),
        })
        await runRecruitment((service) =>
          service.releaseProject({ company_id: companyID, project_id: "cprj_recruitment_alpha" }),
        )

        const secondNeed = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_recruitment_beta",
            work_item_id: "cprj_recruitment_beta-work-item",
            need_key: "research",
            role: "research analyst",
            work_type: "research",
            capability_packs: ["research-analysis@1"],
            risk_level: "medium",
            demand_horizon: "recurring",
            department_key: "research",
          }),
        )
        const second = await runRecruitment((service) =>
          service.selectAndAssign({ capability_need_id: secondNeed.id, exclude_agent_ids: [] }),
        )
        expect(second.agent.id).toBe(first.agent.id)
        expect(second.selections.find((item) => item.decision === "selected")?.source).toBe("company_pool")
        setProjectStatus("cprj_recruitment_beta", "blocked")
        const blockedPerformance = await runRecruitment((service) =>
          service.recordPerformance({
            selection_id: second.selections.find((item) => item.decision === "selected")!.id,
            outcome: "success",
            quality_score: 90,
            reliability_score: 93,
            cost_score: 84,
            speed_score: 89,
            review_summary: "Second representative project passed independent review.",
          }),
        ).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(PerformanceProjectNotCompleted.isInstance(blockedPerformance)).toBe(true)
        if (!PerformanceProjectNotCompleted.isInstance(blockedPerformance))
          throw new Error("Expected blocked project performance to fail")
        expect(blockedPerformance.data).toMatchObject({
          project_id: "cprj_recruitment_beta",
          project_status: "blocked",
          required_project_status: "completed",
        })

        const departmentBeforeSuccessfulDelivery = await runRecruitment((service) =>
          service.ensureDepartment({
            company_id: companyID,
            department_key: "research",
            name: "Research",
            purpose: "Recurring evidence and source validation work",
          }),
        ).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(DepartmentRecurringDemandNotProven.isInstance(departmentBeforeSuccessfulDelivery)).toBe(true)
        if (!DepartmentRecurringDemandNotProven.isInstance(departmentBeforeSuccessfulDelivery))
          throw new Error("Expected incomplete recurring delivery to be excluded")
        expect(departmentBeforeSuccessfulDelivery.data.recurring_project_count).toBe(1)

        const blockedReview = await runRecruitment((service) =>
          service.reviewEmployment({
            company_id: companyID,
            agent_id: second.agent.id,
            decision: "approve",
            decision_note: "Attempted approval before the second delivery completed.",
          }),
        )
        expect(blockedReview).toMatchObject({
          eligible: false,
          review: {
            status: "proposed",
            successful_project_count: 1,
            recurring_need_count: 1,
          },
        })
        expect(await runAgents((service) => service.get(second.agent.id))).toMatchObject({
          lifecycle: "candidate",
        })

        setProjectStatus("cprj_recruitment_beta", "completed")
        await runRecruitment((service) =>
          service.recordPerformance({
            selection_id: second.selections.find((item) => item.decision === "selected")!.id,
            outcome: "success",
            quality_score: 90,
            reliability_score: 93,
            cost_score: 84,
            speed_score: 89,
            review_summary: "Second representative project passed independent review.",
          }),
        )

        const department = await runRecruitment((service) =>
          service.ensureDepartment({
            company_id: companyID,
            department_key: "research",
            name: "Research",
            purpose: "Recurring evidence and source validation work",
          }),
        )
        expect(department).toMatchObject({
          status: "active",
          recurring_project_count: 2,
          evidence: { project_ids: ["cprj_recruitment_alpha", "cprj_recruitment_beta"] },
        })
        await runRecruitment((service) =>
          service.releaseProject({ company_id: companyID, project_id: "cprj_recruitment_beta" }),
        )

        const review = await runRecruitment((service) =>
          service.reviewEmployment({
            company_id: companyID,
            agent_id: second.agent.id,
            decision: "approve",
            decision_note: "Governance approved the sustained role.",
          }),
        )
        expect(review).toMatchObject({
          eligible: true,
          unmet_conditions: [],
          review: {
            status: "approved",
            selected_project_count: 2,
            successful_project_count: 2,
            recurring_need_count: 2,
          },
        })
        expect(await runAgents((service) => service.get(second.agent.id))).toMatchObject({
          lifecycle: "employee",
          department: "research",
        })
        expect(CompanyActivity.list(companyID)).toEqual([
          expect.objectContaining({
            agent: expect.objectContaining({
              id: second.agent.id,
              lifecycle: "employee",
              department: "research",
            }),
          }),
        ])
      },
    })
  })

  test("retires temporary role instances without real task evidence and keeps evidenced ones in the candidate pool", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const companyID = CompanyID.parse("cmp_recruitment_lifecycle")
        seed(companyID, ["cprj_lifecycle_alpha", "cprj_lifecycle_beta"])
        const workerNeed = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_lifecycle_alpha",
            work_item_id: "cprj_lifecycle_alpha-work-item",
            need_key: "delivery",
            role: "delivery specialist",
            work_type: "coding",
            capability_packs: ["structured-delivery"],
            risk_level: "medium",
            demand_horizon: "project",
          }),
        )
        Database.use((db) => {
          const workItem = db
            .select()
            .from(CompanyWorkItemTable)
            .where(eq(CompanyWorkItemTable.id, "cprj_lifecycle_alpha-work-item"))
            .get()
          if (!workItem) throw new Error("Lifecycle recruitment work item not found")
          db.insert(CompanyWorkItemTable)
            .values({
              ...workItem,
              id: "cprj_lifecycle_alpha-advisory-work-item",
              source_task_key: "advisory",
              title: "Advisory recruitment work item",
            })
            .run()
        })
        const idleNeed = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_lifecycle_alpha",
            work_item_id: "cprj_lifecycle_alpha-advisory-work-item",
            need_key: "advisory",
            role: "advisory specialist",
            work_type: "analysis",
            capability_packs: ["domain-advisory"],
            risk_level: "low",
            demand_horizon: "project",
          }),
        )
        const worker = await runRecruitment((service) =>
          service.selectAndAssign({ capability_need_id: workerNeed.id, exclude_agent_ids: [] }),
        )
        // 独立性约束排除执行者后，不强行复用，而是创建第二个临时角色实例。
        const idle = await runRecruitment((service) =>
          service.selectAndAssign({ capability_need_id: idleNeed.id, exclude_agent_ids: [worker.agent.id] }),
        )
        expect(idle.agent.id).not.toBe(worker.agent.id)
        expect(worker.selections.find((item) => item.decision === "selected")?.source).toBe("new_candidate")
        expect(idle.selections.find((item) => item.decision === "selected")?.source).toBe("new_candidate")

        const before = await runRecruitment((service) => service.snapshot({ company_id: companyID }))
        expect(before.organization.temporary_instances.map((agent) => agent.id).toSorted()).toEqual(
          [worker.agent.id, idle.agent.id].toSorted(),
        )
        expect(before.organization.employees).toHaveLength(0)
        expect(before.organization.board_members).toHaveLength(0)

        // 仅 worker 实例沉淀了真实任务证据：本项目一个已完成的工作项。
        const now = Date.now()
        Database.use((db) => {
          db.insert(CompanyPlanTable)
            .values({
              id: "cpl_lifecycle_alpha_v2",
              project_id: "cprj_lifecycle_alpha",
              version: 2,
              phase: "delivery",
              status: "active",
              summary: "Lifecycle evidence plan",
              assumptions_json: "[]",
              acceptance_criteria_json: "[]",
              created_at: now,
            })
            .run()
          db.insert(CompanyWorkItemTable)
            .values({
              id: "cwi_lifecycle_delivery",
              project_id: "cprj_lifecycle_alpha",
              plan_id: "cpl_lifecycle_alpha_v2",
              source_task_key: "delivery",
              title: "交付主任务",
              description: "完成可验收的交付物。",
              kind: "leaf",
              work_type: "delivery",
              role: "delivery specialist",
              capability_packs_json: JSON.stringify(["structured-delivery"]),
              decision_scope_json: "[]",
              resource_scope_json: "[]",
              inputs_json: "[]",
              expected_outputs_json: "[]",
              validators_json: "[]",
              disposition: "execute",
              model_group: "standard",
              risk_level: "medium",
              review_status: "approved",
              status: "completed",
              owner_agent_id: worker.agent.id,
              acceptance_criteria_json: "[]",
              completed_at: now,
              created_at: now,
              updated_at: now,
            })
            .run()
        })
        setProjectStatus("cprj_lifecycle_alpha", "completed")
        await runRecruitment((service) =>
          service.releaseProject({ company_id: companyID, project_id: "cprj_lifecycle_alpha" }),
        )

        // 有证据的临时实例回候选池；无证据的直接退役并留存审计记录。
        expect(await runAgents((service) => service.get(worker.agent.id))).toMatchObject({ lifecycle: "candidate" })
        expect(await runAgents((service) => service.get(idle.agent.id))).toMatchObject({ lifecycle: "archived" })
        const after = await runRecruitment((service) => service.snapshot({ company_id: companyID }))
        expect(after.organization.temporary_instances).toHaveLength(0)
        expect(after.organization.candidate_pool.map((agent) => agent.id)).toContain(worker.agent.id)
        expect(after.organization.candidate_pool.map((agent) => agent.id)).not.toContain(idle.agent.id)
        expect(after.employment_reviews).toContainEqual(
          expect.objectContaining({
            agent_id: idle.agent.id,
            status: "retired",
            successful_project_count: 0,
            rationale: expect.stringContaining("退役"),
          }),
        )

        // 独立性：被排除的执行者不会被选为同类任务的复核者，改为新建临时实例。
        const reviewNeed = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_lifecycle_beta",
            work_item_id: "cprj_lifecycle_beta-work-item",
            need_key: "delivery_review",
            role: "delivery reviewer",
            work_type: "coding",
            capability_packs: ["structured-delivery"],
            risk_level: "medium",
            demand_horizon: "project",
          }),
        )
        const reviewer = await runRecruitment((service) =>
          service.selectAndAssign({ capability_need_id: reviewNeed.id, exclude_agent_ids: [worker.agent.id] }),
        )
        expect(reviewer.agent.id).not.toBe(worker.agent.id)
        expect(reviewer.selections.find((item) => item.decision === "selected")?.source).toBe("new_candidate")
        expect(
          reviewer.selections.find((item) => item.agent_id === worker.agent.id)?.reason,
        ).toContain("独立执行或复核约束")
      },
    })
  })
})
