import { afterEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { CompanyAgent } from "../../src/company-agent"
import { CompanyAgentID } from "../../src/company-agent/schema"
import { CompanyProjectTable } from "../../src/company-project/company-project.sql"
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
          need_key: workerKey,
          role: "opaque delivery worker",
          work_type: "analysis" as const,
          capability_packs: ["zeta-capability@1", "alpha-capability@1", "zeta-capability@1"],
          risk_level: "medium" as const,
          demand_horizon: "project" as const,
        }
        const concurrent = await Promise.all(
          Array.from({ length: 12 }, () => runRecruitment((service) => service.createNeed(input))),
        )

        expect(new Set(concurrent.map((need) => need.id)).size).toBe(1)
        expect(concurrent[0]?.capability_packs).toEqual(["alpha-capability@1", "zeta-capability@1"])
        const repeated = await runRecruitment((service) =>
          service.createNeed({
            ...input,
            capability_packs: ["alpha-capability@1", "zeta-capability@1"],
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
        const need = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_recruitment_one",
            need_key: "evidence-analysis",
            role: "evidence analyst",
            work_type: "analysis",
            capability_packs: ["evidence-synthesis"],
            risk_level: "medium",
            demand_horizon: "project",
          }),
        )
        const result = await runRecruitment((service) =>
          service.selectForNeed({ capability_need_id: need.id, exclude_agent_ids: [] }),
        )

        expect(result.agent).toMatchObject({
          id: "evidence-analyst",
          company_id: companyID,
          lifecycle: "assigned",
          role_key: "evidence analyst",
        })
        expect(result.selections.map((item) => item.decision)).toEqual(["selected", "rejected"])
        expect(result.selections.every((item) => item.reason.length > 10)).toBe(true)
        expect(result.selections.find((item) => item.decision === "rejected")?.reason).toContain("未入选")
        expect(CompanyActivity.list(companyID).map((item) => item.agent.id)).not.toContain("evidence-analyst")

        const released = await runRecruitment((service) =>
          service.releaseProject({ company_id: companyID, project_id: "cprj_recruitment_one" }),
        )
        expect(released[0]?.time_released).toBeNumber()
        const reselected = await runRecruitment((service) =>
          service.selectForNeed({ capability_need_id: need.id, exclude_agent_ids: [] }),
        )
        expect(reselected.agent).toMatchObject({
          id: "evidence-analyst",
          lifecycle: "assigned",
          role_key: "evidence analyst",
        })
        expect(reselected.selections.find((item) => item.decision === "selected")).toMatchObject({
          id: released.find((item) => item.decision === "selected")?.id,
          time_released: undefined,
        })
        await runRecruitment((service) =>
          service.releaseProject({ company_id: companyID, project_id: "cprj_recruitment_one" }),
        )
        expect(await runAgents((service) => service.get(CompanyAgentID.make("evidence-analyst")))).toMatchObject({
          lifecycle: "candidate",
          role_key: "evidence analyst",
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
            need_key: "research",
            role: "research analyst",
            work_type: "research",
            capability_packs: ["source-validation"],
            risk_level: "medium",
            demand_horizon: "recurring",
            department_key: "research",
          }),
        )
        const first = await runRecruitment((service) =>
          service.selectForNeed({ capability_need_id: firstNeed.id, exclude_agent_ids: [] }),
        )
        expect(first.agent.role_key).toBe("research analyst")
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
            need_key: "research",
            role: "research analyst",
            work_type: "research",
            capability_packs: ["source-validation"],
            risk_level: "medium",
            demand_horizon: "recurring",
            department_key: "research",
          }),
        )
        const second = await runRecruitment((service) =>
          service.selectForNeed({ capability_need_id: secondNeed.id, exclude_agent_ids: [] }),
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
          lifecycle: "assigned",
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
              role: "research analyst",
            }),
          }),
        ])
      },
    })
  })
})
