import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import path from "path"
import { CompanyProject } from "../../src/company-project"
import {
  CompanyProjectEventTable,
  CompanyWorkItemTable,
} from "../../src/company-project/company-project.sql"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Company } from "../../src/company"
import { Database } from "../../src/storage"

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
        const completedBlock = yield* Effect.exit(
          service.blockWorkItem({ id: planner.id, error: "late planner materialization failure" }),
        )
        expect(Exit.isFailure(completedBlock)).toBe(true)
        if (Exit.isFailure(completedBlock))
          expect(Cause.pretty(completedBlock.cause)).toMatch(/cannot block from completed/)
        expect((yield* service.listWorkItems(project.id)).find((item) => item.id === planner.id)?.status).toBe(
          "completed",
        )
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

  it.live("creates or reconciles planner projections by stable source task key", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const service = yield* CompanyProject.Service
        const project = yield* service.create({ goal: "Materialize a stable task projection" })
        yield* service.transition({ id: project.id, status: "planning" })
        const plan = yield* service.createPlan({
          project_id: project.id,
          phase: "planning",
          summary: "Stable task projection",
          acceptance_criteria: ["Projection can resume without duplication"],
        })
        const firstDependency = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "First prerequisite",
          description: "First prerequisite",
          kind: "planner",
          work_type: "decision",
          role: "planner",
          model_group: "ultra",
          acceptance_criteria: ["Ready"],
        })
        const secondDependency = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Second prerequisite",
          description: "Second prerequisite",
          kind: "worker",
          work_type: "research",
          role: "researcher",
          model_group: "standard",
          acceptance_criteria: ["Ready"],
        })
        const projection = {
          project_id: project.id,
          plan_id: plan.id,
          source_task_key: "task-a",
          parent_id: firstDependency.id,
          title: "Stable leaf",
          description: "Materialize exactly once",
          kind: "worker" as const,
          work_type: "analysis" as const,
          role: "analyst",
          capability_packs: ["analysis@1"],
          decision_scope: ["Analysis"],
          resource_scope: ["artifacts/task-a"],
          inputs: ["Charter"],
          expected_outputs: ["Analysis result"],
          validators: ["Result is supported"],
          disposition: "retain",
          model_group: "standard" as const,
          risk_level: "medium" as const,
          review_status: "pending" as const,
          acceptance_criteria: ["Result is supported"],
          max_attempts: 2,
        }
        const created = yield* service.createWorkItem({
          ...projection,
          depends_on: [secondDependency.id, firstDependency.id],
        })
        const replayed = yield* service.createWorkItem({
          ...projection,
          depends_on: [firstDependency.id, secondDependency.id, firstDependency.id],
        })

        expect(replayed.id).toBe(created.id)
        expect(replayed.depends_on).toEqual([firstDependency.id, secondDependency.id].sort())
        const conflict = yield* Effect.exit(
          service.createWorkItem({
            ...projection,
            title: "Changed leaf",
            depends_on: [firstDependency.id, secondDependency.id],
          }),
        )
        expect(Exit.isFailure(conflict)).toBe(true)
        if (Exit.isFailure(conflict))
          expect(Cause.pretty(conflict.cause)).toMatch(/source task key conflict.*facts or dependencies differ/)
        const dependencyConflict = yield* Effect.exit(
          service.createWorkItem({
            ...projection,
            depends_on: [firstDependency.id],
          }),
        )
        expect(Exit.isFailure(dependencyConflict)).toBe(true)
        if (Exit.isFailure(dependencyConflict))
          expect(Cause.pretty(dependencyConflict.cause)).toMatch(
            /source task key conflict.*facts or dependencies differ/,
          )
        const reviewer = yield* service.createWorkItem({
          ...projection,
          parent_id: created.id,
          title: "Review stable leaf",
          description: "Independently review the stable leaf",
          kind: "reviewer",
          role: "reviewer",
          review_status: "not_required",
          depends_on: [created.id],
        })

        expect(reviewer.id).not.toBe(created.id)
        expect((yield* service.listWorkItems(project.id)).length).toBe(4)
      }),
    ),
  )

  it.live("strictly backfills source task keys for legacy work items", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const service = yield* CompanyProject.Service
        const project = yield* service.create({ goal: "Reconcile legacy partial materialization" })
        yield* service.transition({ id: project.id, status: "planning" })
        const plan = yield* service.createPlan({
          project_id: project.id,
          phase: "planning",
          summary: "Legacy projection",
          acceptance_criteria: ["Every leaf has a stable source key"],
        })
        const createLegacy = (title: string) =>
          service.createWorkItem({
            project_id: project.id,
            plan_id: plan.id,
            title,
            description: title,
            kind: "worker",
            work_type: "analysis",
            role: "analyst",
            model_group: "standard",
            acceptance_criteria: ["Done"],
          })
        const first = yield* createLegacy("First legacy leaf")
        const second = yield* createLegacy("Second legacy leaf")
        const backfilled = yield* service.setWorkItemSourceTaskKey({
          id: first.id,
          source_task_key: "legacy-task",
        })
        const replayed = yield* service.setWorkItemSourceTaskKey({
          id: first.id,
          source_task_key: "legacy-task",
        })

        expect(backfilled.source_task_key).toBe("legacy-task")
        expect(replayed.id).toBe(first.id)
        const duplicate = yield* Effect.exit(
          service.setWorkItemSourceTaskKey({ id: second.id, source_task_key: "legacy-task" }),
        )
        expect(Exit.isFailure(duplicate)).toBe(true)
        if (Exit.isFailure(duplicate))
          expect(Cause.pretty(duplicate.cause)).toMatch(/source task key conflict.*already assigned/)
        const reassignment = yield* Effect.exit(
          service.setWorkItemSourceTaskKey({ id: first.id, source_task_key: "other-task" }),
        )
        expect(Exit.isFailure(reassignment)).toBe(true)
        if (Exit.isFailure(reassignment))
          expect(Cause.pretty(reassignment.cause)).toMatch(/already has source task key legacy-task/)
      }),
    ),
  )

  it.live("reopens a worker and reviewer after an explicit retry of a rejected review", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const service = yield* CompanyProject.Service
        const project = yield* service.create({ goal: "Rework a rejected delivery" })
        yield* service.transition({ id: project.id, status: "planning" })
        const plan = yield* service.createPlan({
          project_id: project.id,
          phase: "planning",
          summary: "Rework plan",
          acceptance_criteria: ["Review accepted"],
        })
        const worker = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          source_task_key: "delivery",
          title: "Delivery",
          description: "Produce evidence",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          model_group: "standard",
          acceptance_criteria: ["Evidence is complete"],
          max_attempts: 1,
        })
        const reviewer = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          source_task_key: "delivery",
          parent_id: worker.id,
          title: "Review delivery",
          description: "Review evidence",
          kind: "reviewer",
          work_type: "analysis",
          role: "reviewer",
          model_group: "standard",
          acceptance_criteria: ["Evidence is complete"],
          max_attempts: 1,
          depends_on: [worker.id],
        })
        yield* service.startWorkItem(worker.id)
        yield* service.addArtifact({
          project_id: project.id,
          work_item_id: worker.id,
          kind: "analysis",
          title: "First delivery",
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
        yield* service.blockWorkItem({ id: reviewer.id, error: "Missing evidence" })

        const reworked = yield* service.reworkRejectedReview({
          worker_id: worker.id,
          reviewer_id: reviewer.id,
        })

        expect(reworked.worker).toMatchObject({
          status: "pending",
          review_status: "pending",
          attempt: 1,
          max_attempts: 2,
          error: undefined,
        })
        expect(reworked.reviewer).toMatchObject({
          status: "pending",
          attempt: 1,
          max_attempts: 2,
          error: undefined,
        })
        expect((yield* service.readyWorkItems(project.id)).map((item) => item.id)).toEqual([worker.id])
      }),
    ),
  )

  it.live("audits safe work item reassignment and rejects active or cancelled items", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const service = yield* CompanyProject.Service
        const project = yield* service.create({ goal: "Correct a worker assignment" })
        yield* service.transition({ id: project.id, status: "planning" })
        const plan = yield* service.createPlan({
          project_id: project.id,
          phase: "planning",
          summary: "Assignment correction",
          acceptance_criteria: ["Worker ownership is auditable"],
        })
        const worker = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Produce evidence",
          description: "Produce bounded evidence",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          model_group: "standard",
          owner_agent_id: "original-worker",
          acceptance_criteria: ["Evidence is complete"],
        })

        expect(
          yield* service.assignWorkItem({
            id: worker.id,
            owner_agent_id: "replacement-worker",
            reason: "Reviewer identified invalid personnel reuse",
          }),
        ).toMatchObject({ id: worker.id, status: "pending", owner_agent_id: "replacement-worker" })
        const events = Database.use((db) =>
          db
            .select()
            .from(CompanyProjectEventTable)
            .where(eq(CompanyProjectEventTable.project_id, project.id))
            .all(),
        ).filter((item) => item.type === "work_item.reassigned")
        expect(events).toHaveLength(1)
        expect(JSON.parse(events[0]!.data_json)).toEqual({
          work_item_id: worker.id,
          from_agent_id: "original-worker",
          to_agent_id: "replacement-worker",
          reason: "Reviewer identified invalid personnel reuse",
        })

        yield* service.startWorkItem(worker.id)
        const active = yield* Effect.exit(
          service.assignWorkItem({
            id: worker.id,
            owner_agent_id: "third-worker",
            reason: "Unsafe active reassignment",
          }),
        )
        expect(Exit.isFailure(active)).toBe(true)
        if (Exit.isFailure(active)) expect(Cause.pretty(active.cause)).toMatch(/cannot be reassigned from running/)
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(CompanyWorkItemTable)
              .set({ status: "cancelled" })
              .where(eq(CompanyWorkItemTable.id, worker.id))
              .run(),
          ),
        )
        const cancelled = yield* Effect.exit(
          service.assignWorkItem({
            id: worker.id,
            owner_agent_id: "third-worker",
            reason: "Unsafe cancelled reassignment",
          }),
        )
        expect(Exit.isFailure(cancelled)).toBe(true)
        if (Exit.isFailure(cancelled))
          expect(Cause.pretty(cancelled.cause)).toMatch(/cannot be reassigned from cancelled/)
        expect((yield* service.listWorkItems(project.id))[0]?.owner_agent_id).toBe("replacement-worker")
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
