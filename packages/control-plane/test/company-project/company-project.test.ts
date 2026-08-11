import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import fs from "node:fs/promises"
import path from "path"
import { CompanyProject } from "../../src/company-project"
import { CompanyRecruitment } from "../../src/company-recruitment"
import {
  CompanyArtifactTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkAttemptTable,
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

const it = testEffect(
  Layer.mergeAll(
    CompanyProject.defaultLayer,
    CompanyRecruitment.defaultLayer,
    Company.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

describe("CompanyProject adaptive execution state", () => {
  it.live("serializes Artifact versions and atomically materializes concurrent writes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const service = yield* CompanyProject.Service
        const project = yield* service.create({ goal: "Persist concurrent artifacts without split-brain state" })
        yield* service.transition({ id: project.id, status: "planning" })
        const plan = yield* service.createPlan({
          project_id: project.id,
          phase: "execution",
          summary: "Concurrent artifact writes",
          acceptance_criteria: ["Every persisted file matches its row"],
        })
        const item = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Produce versioned artifacts",
          description: "Write several independently materialized results",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          model_group: "standard",
          acceptance_criteria: ["Artifacts are durable"],
        })
        yield* service.startWorkItem(item.id)

        const artifacts = yield* Effect.all(
          Array.from({ length: 8 }, (_, index) =>
            service.addArtifact({
              project_id: project.id,
              work_item_id: item.id,
              kind: "analysis",
              title: `Concurrent artifact ${index + 1}`,
              path: `artifacts/concurrent-${index + 1}.json`,
              content: JSON.stringify({ index: index + 1 }),
            }),
          ),
          { concurrency: "unbounded" },
        )
        const ordered = artifacts.toSorted((left, right) => left.version! - right.version!)
        expect(ordered.map((artifact) => artifact.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
        expect(ordered.map((artifact) => artifact.supersedes_artifact_id)).toEqual([
          null,
          ...ordered.slice(0, -1).map((artifact) => artifact.id),
        ])
        for (const artifact of ordered) {
          const bytes = new Uint8Array(yield* Effect.promise(() => Bun.file(artifact.path!).arrayBuffer()))
          expect(artifact.materialized_sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))
        }

        const collisions = yield* Effect.all(
          ["first", "second"].map((content) =>
            Effect.exit(
              service.addArtifact({
                project_id: project.id,
                work_item_id: item.id,
                kind: "analysis",
                title: `Shared path ${content}`,
                path: "artifacts/shared.json",
                content,
              }),
            ),
          ),
          { concurrency: "unbounded" },
        )
        expect(collisions.filter(Exit.isSuccess)).toHaveLength(1)
        expect(collisions.filter(Exit.isFailure)).toHaveLength(1)
        const shared = collisions.find(Exit.isSuccess)!.value
        if (!shared.path || !shared.materialized_sha256) throw new Error("Expected one materialized shared Artifact")
        const sharedPath = shared.path
        expect(
          new Bun.CryptoHasher("sha256")
            .update(new Uint8Array(yield* Effect.promise(() => Bun.file(sharedPath).arrayBuffer())))
            .digest("hex"),
        ).toBe(shared.materialized_sha256)

        const orphan = yield* Effect.exit(
          service.addArtifact({
            project_id: project.id,
            work_item_id: "missing-work-item",
            kind: "analysis",
            title: "Must not materialize",
            path: "artifacts/orphan.json",
            content: "orphan",
          }),
        )
        expect(Exit.isFailure(orphan)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path.join(project.output_dir, "artifacts/orphan.json")).exists())).toBe(
          false,
        )
        expect(
          (yield* Effect.promise(() => fs.readdir(path.join(project.output_dir, "artifacts")))).some((name) =>
            name.endsWith(".tmp"),
          ),
        ).toBe(false)

        const outside = path.join(path.dirname(project.output_dir), `artifact-outside-${crypto.randomUUID()}`)
        yield* Effect.promise(() => fs.mkdir(outside))
        yield* Effect.promise(() => fs.symlink(outside, path.join(project.output_dir, "linked"), "dir"))
        const escaped = yield* Effect.exit(
          service.addArtifact({
            project_id: project.id,
            work_item_id: item.id,
            kind: "analysis",
            title: "Must not follow symlink",
            path: "linked/escape.json",
            content: "escape",
          }),
        )
        expect(Exit.isFailure(escaped)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path.join(outside, "escape.json")).exists())).toBe(false)
        expect(
          Database.use((db) =>
            db
              .select()
              .from(CompanyArtifactTable)
              .where(eq(CompanyArtifactTable.project_id, project.id))
              .all(),
          ).filter((artifact) => artifact.path?.endsWith("orphan.json") || artifact.path?.endsWith("escape.json")),
        ).toHaveLength(0)
      }),
    ),
  )

  it.live("claims one concurrent dispatch attempt and rejects binding an older generation", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const service = yield* CompanyProject.Service
        const recruitment = yield* CompanyRecruitment.Service
        const project = yield* service.create({ goal: "Dispatch one assigned delivery exactly once" })
        yield* service.transition({ id: project.id, status: "planning" })
        const plan = yield* service.createPlan({
          project_id: project.id,
          phase: "execution",
          summary: "Atomic dispatch",
          acceptance_criteria: ["Only one attempt starts"],
        })
        const item = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Produce the delivery",
          description: "Produce one independently verifiable delivery",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          capability_packs: ["analysis@1"],
          resource_scope: ["artifacts/delivery.json"],
          model_group: "standard",
          acceptance_criteria: ["Delivery exists"],
        })
        const need = yield* recruitment.createNeed({
          project_id: project.id,
          work_item_id: item.id,
          need_key: "atomic-dispatch-analyst",
          role: item.role,
          work_type: item.work_type,
          capability_packs: item.capability_packs,
          risk_level: item.risk_level,
          demand_horizon: "project",
          workspace_scopes: item.resource_scope,
        })
        yield* recruitment.selectAndAssign({
          capability_need_id: need.id,
          exclude_agent_ids: [],
          permission_mode: "read_only",
        })

        const claims = yield* Effect.all(
          [service.claimWorkItemForDispatch(item.id), service.claimWorkItemForDispatch(item.id)],
          { concurrency: "unbounded" },
        )
        const claim = claims.find((candidate) => candidate !== undefined)

        expect(claims.filter((candidate) => candidate !== undefined)).toHaveLength(1)
        expect(claim).toBeDefined()
        expect(yield* service.listWorkAttempts(project.id)).toMatchObject([
          {
            id: claim!.attempt_id,
            work_item_id: item.id,
            ordinal: 1,
            status: "running",
          },
        ])
        expect((yield* service.listWorkItems(project.id)).find((candidate) => candidate.id === item.id)).toMatchObject({
          status: "running",
          attempt: 1,
          dispatch_claim_id: claim!.claim_id,
          dispatch_claim_generation: claim!.generation,
          workflow_run_id: claim!.workflow_run_id,
        })

        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(CompanyProjectTable)
              .set({ dispatch_generation: claim!.generation + 1 })
              .where(eq(CompanyProjectTable.id, project.id))
              .run(),
          ),
        )
        const staleBind = yield* Effect.exit(
          service.bindDispatchClaimRun({
            id: item.id,
            claim_id: claim!.claim_id,
            generation: claim!.generation,
            workflow_run_id: claim!.workflow_run_id,
          }),
        )

        expect(Exit.isFailure(staleBind)).toBe(true)
        if (Exit.isFailure(staleBind)) expect(Cause.pretty(staleBind.cause)).toContain("generation is closed")
        expect(
          Database.use((db) =>
            db
              .select({ workflow_run_id: CompanyWorkItemTable.workflow_run_id })
              .from(CompanyWorkItemTable)
              .where(eq(CompanyWorkItemTable.id, item.id))
              .get(),
          ),
        ).toEqual({ workflow_run_id: claim!.workflow_run_id })
        expect(
          Database.use((db) =>
            db
              .select()
              .from(CompanyWorkAttemptTable)
              .where(eq(CompanyWorkAttemptTable.work_item_id, item.id))
              .all(),
          ),
        ).toHaveLength(1)
      }),
    ),
  )

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
          require_high_risk_approval: true,
          require_human_merge: false,
        })
      }),
    ),
  )

  it.live("persists a dependency tree, role contract, review state, and writable worktree from the Charter", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const service = yield* CompanyProject.Service
        const recruitment = yield* CompanyRecruitment.Service
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
          resource_scope: ["."],
          model_group: "standard",
          risk_level: "high",
          acceptance_criteria: ["Host command passes"],
          depends_on: [planner.id],
        })
        const need = yield* recruitment.createNeed({
          project_id: project.id,
          work_item_id: worker.id,
          need_key: "delivery-engineer",
          role: worker.role,
          work_type: worker.work_type,
          capability_packs: worker.capability_packs,
          risk_level: worker.risk_level,
          demand_horizon: "project",
          workspace_scopes: worker.resource_scope,
        })
        yield* recruitment.selectAndAssign({
          capability_need_id: need.id,
          exclude_agent_ids: [],
          permission_mode: "workspace_write",
        })
        const reviewer = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          parent_id: worker.id,
          reviews_work_item_id: worker.id,
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
        expect(reviewer).toMatchObject({
          kind: "reviewer",
          purpose: "verification",
          review_status: "not_required",
          validation_mode: "independent_review",
          parent_id: worker.id,
          reviews_work_item_id: worker.id,
        })
        const duplicateReviewer = yield* Effect.exit(
          service.createWorkItem({
            project_id: project.id,
            plan_id: plan.id,
            parent_id: worker.id,
            reviews_work_item_id: worker.id,
            title: "Duplicate review",
            description: "Review the same worker again",
            kind: "reviewer",
            work_type: "coding",
            role: "second reviewer",
            model_group: "standard",
            review_status: "not_required",
            acceptance_criteria: ["Host command passes"],
            depends_on: [worker.id],
          }),
        )
        expect(Exit.isFailure(duplicateReviewer)).toBe(true)
        if (Exit.isFailure(duplicateReviewer))
          expect(Cause.pretty(duplicateReviewer.cause)).toContain("duplicate_reviewer_target")

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

  it.live("rejects a V2 reviewer targeting a legacy acceptance contract", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const service = yield* CompanyProject.Service
        const project = yield* service.create({ goal: "Keep review contracts version aligned" })
        yield* service.transition({ id: project.id, status: "planning" })
        const plan = yield* service.createPlan({
          project_id: project.id,
          phase: "planning",
          summary: "Version-aligned review",
          acceptance_criteria: ["Reviewer and target use one acceptance contract"],
        })
        const worker = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Legacy contract delivery",
          description: "Deliver evidence under the legacy contract",
          kind: "worker",
          work_type: "analysis",
          role: "legacy analyst",
          model_group: "standard",
          acceptance_criteria: ["Evidence is complete"],
        })
        const reviewer = yield* Effect.exit(
          service.createWorkItem({
            project_id: project.id,
            plan_id: plan.id,
            parent_id: worker.id,
            reviews_work_item_id: worker.id,
            title: "V2 review of legacy delivery",
            description: "Review a legacy contract with a V2 receipt",
            kind: "reviewer",
            work_type: "analysis",
            role: "V2 reviewer",
            model_group: "standard",
            validation_contract_version: 2,
            acceptance_criteria: ["review_results_cover_target_criteria"],
            depends_on: [worker.id],
          }),
        )
        expect(Exit.isFailure(reviewer)).toBe(true)
        if (Exit.isFailure(reviewer))
          expect(Cause.pretty(reviewer.cause)).toContain("reviewer_target_contract_version_mismatch")
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
          reviews_work_item_id: created.id,
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
          reviews_work_item_id: worker.id,
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
        const reviewer = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          parent_id: worker.id,
          reviews_work_item_id: worker.id,
          title: "Review evidence",
          description: "Review the worker independently",
          kind: "reviewer",
          work_type: "analysis",
          role: "reviewer",
          model_group: "standard",
          owner_agent_id: "reviewer-owner",
          acceptance_criteria: ["Evidence is independently reviewed"],
          depends_on: [worker.id],
        })

        expect(
          yield* service.assignWorkItem({
            id: worker.id,
            owner_agent_id: "replacement-worker",
            reason: "Reviewer identified invalid personnel reuse",
          }),
        ).toMatchObject({ id: worker.id, status: "pending", owner_agent_id: "replacement-worker" })
        const reviewerReuse = yield* Effect.exit(
          service.assignWorkItem({
            id: reviewer.id,
            owner_agent_id: "replacement-worker",
            reason: "Invalid reviewer reuse",
          }),
        )
        expect(Exit.isFailure(reviewerReuse)).toBe(true)
        if (Exit.isFailure(reviewerReuse))
          expect(Cause.pretty(reviewerReuse.cause)).toContain("reviewer_not_independent")
        const workerReuse = yield* Effect.exit(
          service.assignWorkItem({
            id: worker.id,
            owner_agent_id: "reviewer-owner",
            reason: "Invalid worker reuse",
          }),
        )
        expect(Exit.isFailure(workerReuse)).toBe(true)
        if (Exit.isFailure(workerReuse))
          expect(Cause.pretty(workerReuse.cause)).toContain("reviewer_not_independent")
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
        const plan = yield* service.createPlan({
          project_id: project.id,
          phase: "planning",
          summary: "Bounded material action",
          acceptance_criteria: ["The action remains within its approved resource scope"],
        })
        const item = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Perform material action",
          description: "Perform one bounded external action",
          kind: "worker",
          work_type: "analysis",
          role: "operator",
          resource_scope: ["external-system"],
          model_group: "standard",
          acceptance_criteria: ["The action remains within its approved resource scope"],
        })
        const gate = yield* service.requestGate({
          project_id: project.id,
          kind: "risk_approval",
          title: "Approve material action",
          summary: "The next action is irreversible",
          work_item_id: item.id,
          resource_scope: item.resource_scope,
        })
        expect((yield* service.get(project.id))?.status).toBe("awaiting_approval")
        yield* service.resolveGate({ id: gate.id, decision: "reject", note: "Do not take this action" })
        expect((yield* service.get(project.id))?.status).toBe("rejected")
      }),
    ),
  )
})
