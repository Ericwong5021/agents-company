import { afterEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { CompanyAgent } from "../../src/company-agent"
import { CompanyAgentTable } from "../../src/company-agent/company-agent.sql"
import {
  CompanyPlanTable,
  CompanyProjectTable,
  CompanyWorkItemTable,
} from "../../src/company-project/company-project.sql"
import {
  CAPABILITY_VERIFICATION_TTL_MS,
  capabilityAvailability,
  CompanyRecruitment,
  declaredPacksFromProfile,
  evidenceStatus,
  runtimeCompatibility,
} from "../../src/company-recruitment"
import { CompanyTable } from "../../src/company/company.sql"
import { CompanyID } from "../../src/company/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import { missingRuntimeCapabilities } from "../../src/runtime/capability-matrix"
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
        name: "Capability Evidence Test Company",
        data_version: 1,
        default_provider_id: ProviderID.make("test"),
        default_model_id: ModelID.make("test-model"),
        bootstrap_request_id: crypto.randomUUID(),
        bootstrap_input_path: "/tmp/capability-evidence-test",
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
          summary: "Capability evidence test plan",
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
          source_task_key: "capability-evidence",
          parent_id: null,
          title: "Capability evidence work item",
          description: "Select one compatible agent",
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

describe("capability evidence", () => {
  test("derives declared, verified and expired status from stored facts", () => {
    const now = Date.now()
    const base = { capability_pack: "software-implementation@1", declared_at: now - 1_000, failure_count: 0 }
    expect(evidenceStatus(base, now)).toBe("declared")
    expect(evidenceStatus({ ...base, last_verified_at: now - 60_000 }, now)).toBe("verified")
    expect(evidenceStatus({ ...base, last_verified_at: now - CAPABILITY_VERIFICATION_TTL_MS - 1 }, now)).toBe(
      "expired",
    )
  })

  test("hard-gates unknown runtimes, keeps unresolved packs neutral and differentiates runtimes", () => {
    expect(runtimeCompatibility("pi", ["software-implementation@1"])).toMatchObject({
      compatible: true,
      missing: [],
      unresolved: [],
      reasons: [],
    })

    const neutral = runtimeCompatibility("codex", ["evidence-synthesis"])
    expect(neutral.compatible).toBe(true)
    expect(neutral.unresolved).toEqual(["evidence-synthesis"])

    const unknown = runtimeCompatibility("legacy-cli", ["software-implementation@1"])
    expect(unknown.compatible).toBe(false)
    expect(unknown.reasons[0]).toContain("未知 Runtime")

    // Same requirements produce different availability per runtime.
    expect(missingRuntimeCapabilities("pi", ["liveInput", "dynamicSkills"])).toEqual([])
    expect(missingRuntimeCapabilities("claude-code", ["liveInput", "dynamicSkills"])).toEqual([
      "dynamicSkills",
      "liveInput",
    ])
    expect(missingRuntimeCapabilities("codex", ["liveInput"])).toEqual(["liveInput"])
  })

  test("marks evidence unavailable when the pack is retired or the runtime is unknown", () => {
    const facts = { capability_pack: "software-implementation@1", declared_at: 0, failure_count: 0 }
    expect(capabilityAvailability(facts, "pi")).toEqual({ available: true, reasons: [] })

    const retired = capabilityAvailability({ ...facts, capability_pack: "retired-pack@1" }, "pi")
    expect(retired.available).toBe(false)
    expect(retired.reasons[0]).toContain("能力包不可用")

    expect(capabilityAvailability(facts, "legacy-cli").available).toBe(false)
  })

  test("seeds initial declared capabilities from existing agent profiles", () => {
    expect(
      declaredPacksFromProfile({
        description: "Delivers production changes",
        responsibilities: ["software-implementation@1", "coding"],
      }),
    ).toEqual(["software-implementation@1"])
    expect(declaredPacksFromProfile({ role_key: "Independent reviewer" })).toEqual(["independent-review@1"])
    expect(declaredPacksFromProfile({ description: "General helper" })).toEqual([])
  })

  test("excludes runtime-incompatible agents from selection and tracks the evidence lifecycle", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const companyID = CompanyID.parse("cmp_capability_evidence")
        seed(companyID, ["cprj_capability_evidence"])
        // "a-legacy-runner" sorts before "b-impl-engineer": with identical
        // profiles it would win the deterministic tie-break unless the runtime
        // hard gate excludes it.
        await runAgents((service) =>
          service.create({
            id: "a-legacy-runner",
            company_id: companyID,
            name: "Legacy Runner",
            lifecycle: "candidate",
            description: "Implementation engineer for coding work",
            responsibilities: ["implementation engineer", "software-implementation@1", "coding"],
          }),
        )
        await runAgents((service) =>
          service.create({
            id: "b-impl-engineer",
            company_id: companyID,
            name: "Implementation Engineer",
            lifecycle: "candidate",
            description: "Implementation engineer for coding work",
            responsibilities: ["implementation engineer", "software-implementation@1", "coding"],
          }),
        )
        // Simulate an agent bound to a runtime the platform no longer supports.
        Database.use((db) =>
          db
            .update(CompanyAgentTable)
            .set({ preferred_runtime: "legacy-cli" })
            .where(eq(CompanyAgentTable.id, "a-legacy-runner"))
            .run(),
        )

        const need = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_capability_evidence",
            work_item_id: "cprj_capability_evidence-work-item",
            need_key: "implementation",
            role: "implementation engineer",
            work_type: "coding",
            capability_packs: ["software-implementation@1"],
            risk_level: "medium",
            demand_horizon: "project",
          }),
        )
        const result = await runRecruitment((service) =>
          service.selectForNeed({ capability_need_id: need.id, exclude_agent_ids: [] }),
        )
        expect(result.agent).toMatchObject({ id: "b-impl-engineer" })
        const rejected = result.selections.find((item) => item.agent_id === "a-legacy-runner")
        expect(rejected?.decision).toBe("rejected")
        expect(rejected?.reason).toContain("未知 Runtime")

        // Profile-derived declared capability was seeded for the whole pool.
        const declared = await runRecruitment((service) =>
          service.listCapabilities({ company_id: companyID, agent_id: "b-impl-engineer" }),
        )
        expect(declared.find((item) => item.capability_pack === "software-implementation@1")).toMatchObject({
          source: "profile",
          status: "declared",
          available: true,
          failure_count: 0,
        })
        const legacyCapability = (
          await runRecruitment((service) =>
            service.listCapabilities({ company_id: companyID, agent_id: "a-legacy-runner" }),
          )
        ).find((item) => item.capability_pack === "software-implementation@1")
        expect(legacyCapability?.available).toBe(false)
        expect(legacyCapability?.availability_reasons[0]).toContain("未知 Runtime")

        const selectionID = result.selections.find((item) => item.decision === "selected")!.id
        setProjectStatus("cprj_capability_evidence", "completed")
        await runRecruitment((service) =>
          service.recordPerformance({
            selection_id: selectionID,
            outcome: "success",
            quality_score: 90,
            reliability_score: 92,
            cost_score: 80,
            speed_score: 85,
            review_summary: "Delivery accepted by independent review.",
          }),
        )
        const verified = (
          await runRecruitment((service) =>
            service.listCapabilities({ company_id: companyID, agent_id: "b-impl-engineer" }),
          )
        ).find((item) => item.capability_pack === "software-implementation@1")
        expect(verified).toMatchObject({ status: "verified", last_success_selection_id: selectionID })
        expect(verified?.last_verified_at).toBeNumber()

        // Failure records facts without revoking the verified evidence.
        await runRecruitment((service) =>
          service.recordPerformance({
            selection_id: selectionID,
            outcome: "failure",
            quality_score: 40,
            reliability_score: 45,
            cost_score: 50,
            speed_score: 40,
            review_summary: "Rework required after review.",
          }),
        )
        const afterFailure = (
          await runRecruitment((service) =>
            service.listCapabilities({ company_id: companyID, agent_id: "b-impl-engineer" }),
          )
        ).find((item) => item.capability_pack === "software-implementation@1")
        expect(afterFailure).toMatchObject({
          status: "verified",
          failure_count: 1,
          last_failure_summary: "Rework required after review.",
        })

        // Re-recording the same outcome does not double-count failures.
        await runRecruitment((service) =>
          service.recordPerformance({
            selection_id: selectionID,
            outcome: "failure",
            quality_score: 42,
            reliability_score: 46,
            cost_score: 52,
            speed_score: 41,
            review_summary: "Rework confirmed on second review.",
          }),
        )
        const afterRepeat = (
          await runRecruitment((service) =>
            service.listCapabilities({ company_id: companyID, agent_id: "b-impl-engineer" }),
          )
        ).find((item) => item.capability_pack === "software-implementation@1")
        expect(afterRepeat?.failure_count).toBe(1)
      },
    })
  })

  test("keeps retired pack evidence visible but unavailable and exposes capabilities in the snapshot", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const companyID = CompanyID.parse("cmp_capability_retired")
        seed(companyID, ["cprj_capability_retired"])
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
        const need = await runRecruitment((service) =>
          service.createNeed({
            company_id: companyID,
            project_id: "cprj_capability_retired",
            work_item_id: "cprj_capability_retired-work-item",
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
        // A pack unknown to the catalog never blocks selection...
        expect(result.agent).toMatchObject({ id: "evidence-analyst" })

        // ...but its evidence must not read as a currently usable capability.
        const capability = (
          await runRecruitment((service) =>
            service.listCapabilities({ company_id: companyID, agent_id: "evidence-analyst" }),
          )
        ).find((item) => item.capability_pack === "evidence-synthesis")
        expect(capability).toMatchObject({ source: "selection", status: "declared", available: false })
        expect(capability?.availability_reasons[0]).toContain("能力包不可用")

        const snapshot = await runRecruitment((service) => service.snapshot({ company_id: companyID }))
        expect(snapshot.capabilities.map((item) => item.capability_pack)).toContain("evidence-synthesis")
      },
    })
  })
})
