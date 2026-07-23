import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { CompanyProject } from "../../src/company-project"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Company } from "../../src/company"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(CompanyProject.defaultLayer, Company.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("CompanyProject adaptive execution state", () => {
  it.live("inherits the current company approval preset in a new Project Charter", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const company = yield* Company.Service
        const service = yield* CompanyProject.Service
        yield* company.updateApprovalPolicy({ preset: "autonomous" })
        const project = yield* service.create({ goal: "Deliver within the company approval policy" })
        const charter = yield* service.createCharter({
          project_id: project.id,
          scope: [project.goal],
          success_criteria: ["Delivered"],
          acceptance_criteria: ["Policy inherited"],
        })

        expect(charter.policy).toMatchObject({
          source_approval_preset: "autonomous",
          require_high_risk_approval: false,
          require_human_merge: false,
        })
      }),
    ),
  )

  it.live("persists a dependency tree, role contract, review state, and writable worktree from the Charter", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const service = yield* CompanyProject.Service
        const project = yield* service.create({ goal: "Analyze evidence and produce a verified local delivery" })
        yield* service.createCharter({
          project_id: project.id,
          scope: [project.goal],
          success_criteria: ["Verified delivery"],
          constraints: ["Local only"],
          acceptance_criteria: ["Evidence is preserved"],
        })

        const repo = yield* service.initRepository(project.id)
        expect(yield* Effect.promise(() => Bun.file(path.join(repo, ".git", "HEAD")).exists())).toBe(true)
        yield* service.transition({ id: project.id, status: "planning" })
        const plan = yield* service.createPlan({
          project_id: project.id,
          phase: "planning",
          summary: "Dynamic dependency tree",
          acceptance_criteria: ["Every leaf is independently verified"],
        })
        const planner = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Create Charter",
          description: "Define the bounded task tree",
          kind: "planner",
          work_type: "decision",
          role: "project-planner",
          capability_packs: ["product-charter@1"],
          decision_scope: ["Charter"],
          resource_scope: ["artifacts/project-charter.json"],
          model_group: "ultra",
          review_status: "not_required",
          acceptance_criteria: ["Task tree is bounded"],
        })
        const worker = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          parent_id: planner.id,
          title: "Implement delivery",
          description: "Create and verify the local delivery",
          kind: "worker",
          work_type: "coding",
          role: "delivery engineer",
          capability_packs: ["software-implementation@1"],
          decision_scope: ["Implementation details"],
          resource_scope: ["repo"],
          model_group: "standard",
          risk_level: "high",
          acceptance_criteria: ["Host command passes"],
          depends_on: [planner.id],
        })
        const reviewer = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          parent_id: worker.id,
          title: "Review delivery",
          description: "Independently verify the worker artifact",
          kind: "reviewer",
          work_type: "coding",
          role: "independent reviewer",
          capability_packs: ["independent-review@1"],
          resource_scope: ["repo"],
          model_group: "ultra",
          review_status: "not_required",
          acceptance_criteria: ["Host command passes"],
          depends_on: [worker.id],
        })

        expect((yield* service.readyWorkItems(project.id)).map((item) => item.id)).toEqual([planner.id])
        yield* service.startWorkItem(planner.id)
        const completionWithoutArtifact = yield* Effect.exit(service.completeWorkItem(planner.id))
        expect(Exit.isFailure(completionWithoutArtifact)).toBe(true)
        if (Exit.isFailure(completionWithoutArtifact))
          expect(Cause.pretty(completionWithoutArtifact.cause)).toMatch(/without an artifact/)
        yield* service.addArtifact({
          project_id: project.id,
          work_item_id: planner.id,
          kind: "project_charter",
          title: "Charter",
          content: "{}",
        })
        yield* service.completeWorkItem(planner.id)
        expect((yield* service.readyWorkItems(project.id)).map((item) => item.id)).toEqual([worker.id])

        const worktree = yield* service.createWorktreeRun({ project_id: project.id, work_item_id: worker.id })
        yield* service.startWorktreeRun({ id: worktree.id })
        yield* Effect.promise(() => Bun.write(path.join(worktree.directory, "runtime-proof.txt"), "verified\n"))
        const verified = yield* service.verifyWorktreeRun({ id: worktree.id, commands: ["bun --version"] })
        expect(verified.status).toBe("awaiting_merge_approval")
        expect(reviewer.owner_agent_id).toBeUndefined()
        expect(worker).toMatchObject({
          kind: "worker",
          work_type: "coding",
          model_group: "standard",
          review_status: "pending",
          decision_scope: ["Implementation details"],
        })
      }),
    ),
  )

  it.live("uses one risk gate instead of fixed project and development approvals", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const service = yield* CompanyProject.Service
        const project = yield* service.create({ goal: "Perform a material external action" })
        yield* service.transition({ id: project.id, status: "planning" })
        const gate = yield* service.requestGate({
          project_id: project.id,
          kind: "risk_approval",
          title: "Approve material action",
          summary: "The next action is irreversible",
        })
        expect((yield* service.get(project.id))?.status).toBe("awaiting_approval")
        yield* service.resolveGate({ id: gate.id, decision: "reject", note: "Do not take this action" })
        expect((yield* service.get(project.id))?.status).toBe("rejected")
      }),
    ),
  )
})
