import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import {
  CompanyGraphMutation,
  CompanyProject,
  CompanyWorkFacts,
} from "../../src/company-project"
import { CompanyRecruitment } from "../../src/company-recruitment"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { CapabilityMaterializer } from "../../src/project-orchestrator/capability-materializer"
import { DispatchCoordinator } from "../../src/project-orchestrator/dispatch"
import { GraphSupervisor } from "../../src/project-orchestrator/graph-supervisor"
import { ProjectOrchestrator } from "../../src/project-orchestrator/project-orchestrator"
import { QuiescenceService } from "../../src/project-orchestrator/quiescence"
import { ReceiptProcessor } from "../../src/project-orchestrator/receipt-processor"
import { resetDatabase } from "../fixture/db"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const recruitment = Layer.succeed(
  CompanyRecruitment.Service,
  CompanyRecruitment.Service.of({
    listAssignments: () => Effect.succeed([]),
    releaseProject: () => Effect.succeed([]),
  } as unknown as CompanyRecruitment.Interface),
)
const dispatch = Layer.succeed(
  DispatchCoordinator.Service,
  DispatchCoordinator.Service.of({
    dispatchReady: (project_id: string) =>
      Effect.succeed({
        project_id,
        status: "idle",
        barrier: "open",
        eligible_work_item_ids: [],
        dispatched_work_item_ids: [],
      }),
  } as unknown as DispatchCoordinator.Interface),
)
const dependencies = Layer.mergeAll(
  CompanyProject.recoveryControlledLayer,
  CompanyWorkFacts.makeLayer({ recoverOnStart: false }),
  CompanyGraphMutation.defaultLayer,
  recruitment,
)
const supervisor = GraphSupervisor.makeLayer({ mode: "active" }).pipe(Layer.provide(dependencies))
const materializer = CapabilityMaterializer.layer.pipe(Layer.provide(dependencies))
const quiescence = QuiescenceService.layer.pipe(Layer.provide(dependencies))
const processorDependencies = Layer.mergeAll(
  dependencies,
  supervisor,
  materializer,
  quiescence,
)
const processor = ReceiptProcessor.layer.pipe(Layer.provide(processorDependencies))
const orchestratorDependencies = Layer.mergeAll(
  processorDependencies,
  processor,
  dispatch,
)
const it = testEffect(
  Layer.mergeAll(
    orchestratorDependencies,
    ProjectOrchestrator.layer.pipe(Layer.provide(orchestratorDependencies)),
    CrossSpawnSpawner.defaultLayer,
  ),
)

afterEach(async () => {
  await resetDatabase()
})

describe("B2 orchestrator recovery", () => {
  it.live("[b2-supervisor-benchmarks] resumes a claimed Receipt and replays without duplicate decisions", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const facts = yield* CompanyWorkFacts.Service
        const orchestrator = yield* ProjectOrchestrator.Service
        const supervisor = yield* GraphSupervisor.Service
        const project = yield* projects.create({
          goal: "Recover a terminal Seed graph",
          execution_strategy: "seed_and_grow",
          seed_mode: "direct_single",
        })
        yield* projects.transition({ id: project.id, status: "planning" })
        yield* projects.createCharter({
          project_id: project.id,
          scope: ["workspace"],
          success_criteria: ["recovery-criterion"],
          acceptance_criteria: ["recovery-criterion"],
        })
        const plan = yield* projects.createPlan({
          project_id: project.id,
          phase: "execution",
          summary: "Recovery",
          acceptance_criteria: ["recovery-criterion"],
        })
        const item = yield* projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Recovery item",
          description: "Persist a terminal Receipt",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          model_group: "standard",
          review_status: "not_required",
          owner_agent_id: "agent-recovery",
          acceptance_criteria: ["recovery-criterion"],
        })
        yield* projects.startWorkItem(item.id)
        const artifact = yield* projects.addArtifact({
          project_id: project.id,
          work_item_id: item.id,
          kind: "evidence",
          title: "Recovery evidence",
          content: "{}",
        })
        yield* projects.completeWorkItemWithReceipt({
          id: item.id,
          receipt: {
            idempotency_key: "b2-recovery-receipt",
            outcome: "completed",
            summary: "Recovery criterion completed",
            artifact_ids: [artifact.id],
            evidence_refs: [{ kind: "artifact", id: artifact.id }],
            confirmed_facts: ["recovery-criterion"],
            invalidated_assumptions: [],
            unknowns: [],
            blockers: [],
            capability_gaps: [],
            task_proposals: [],
            dependency_proposals: [],
            questions: [],
          },
        })
        const receipt = (yield* projects.listWorkReceipts(project.id))[0]!
        const claim = yield* facts.claimReceipt(receipt.id)
        const first = yield* orchestrator.recover()
        const replay = yield* orchestrator.recover()
        expect(claim.replayed).toBe(false)
        expect(first).toMatchObject({
          idempotency_key: "project-orchestrator-recover:v1",
          project_ids: [project.id],
          receipt_ids: [receipt.id],
          replayed: false,
        })
        expect(first.quiescence).toEqual([
          expect.objectContaining({
            status: "completed",
            replayed: false,
          }),
        ])
        expect(replay).toMatchObject({
          project_ids: [project.id],
          receipt_ids: [],
          decision_ids: first.decision_ids,
          replayed: true,
        })
        expect(replay.quiescence[0]).toMatchObject({
          status: "completed",
          replayed: true,
          delivery_package_artifact_id: first.quiescence[0]!.delivery_package_artifact_id,
        })
        expect(yield* supervisor.listDecisions(project.id)).toHaveLength(1)
        expect((yield* projects.listArtifacts(project.id)).filter((entry) => entry.kind === "delivery_package")).toHaveLength(
          1,
        )
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(process.cwd(), ".artifacts", "seed-grow-b2"), { recursive: true })
          await Bun.write(
            path.join(process.cwd(), ".artifacts", "seed-grow-b2", "supervisor-benchmarks.json"),
            `${JSON.stringify(
              {
                schemaVersion: 1,
                projectId: project.id,
                receiptId: receipt.id,
                decisionIds: first.decision_ids,
                deliveryPackageArtifactId: first.quiescence[0]!.delivery_package_artifact_id,
                firstReplay: first.replayed,
                secondReplay: replay.replayed,
              },
              null,
              2,
            )}\n`,
          )
        })
      }),
    ),
  )
})
