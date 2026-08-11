import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { CompanyGraphMutation, CompanyAttention, CompanyProject, CompanyWorkFacts } from "../../src/company-project"
import { CompanyProjectTable, CompanyWorkItemTable } from "../../src/company-project/company-project.sql"
import { CompanyRecruitment } from "../../src/company-recruitment"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { GraphSupervisor } from "../../src/project-orchestrator/graph-supervisor"
import { QuiescenceService } from "../../src/project-orchestrator/quiescence"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let releaseCalls = 0
const recruitment = Layer.succeed(
  CompanyRecruitment.Service,
  CompanyRecruitment.Service.of({
    releaseProject: () =>
      Effect.sync(() => {
        releaseCalls += 1
        return []
      }),
  } as unknown as CompanyRecruitment.Interface),
)
const dependencies = Layer.mergeAll(
  CompanyProject.recoveryControlledLayer,
  CompanyWorkFacts.makeLayer({ recoverOnStart: false }),
  CompanyGraphMutation.defaultLayer,
  CompanyAttention.defaultLayer,
  recruitment,
)
const it = testEffect(
  Layer.mergeAll(
    dependencies,
    GraphSupervisor.makeLayer({ mode: "active" }).pipe(Layer.provide(dependencies)),
    QuiescenceService.layer.pipe(Layer.provide(dependencies)),
    CrossSpawnSpawner.defaultLayer,
  ),
)

afterEach(async () => {
  releaseCalls = 0
  await resetDatabase()
})

describe("B2 quiescence", () => {
  it.live("[b2-quiescence] requires per-criterion bindings and finalizes one replayable delivery package", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const attention = yield* CompanyAttention.Service
        const supervisor = yield* GraphSupervisor.Service
        const quiescence = yield* QuiescenceService.Service
        const project = yield* projects.create({
          goal: "Prove every acceptance criterion",
          execution_strategy: "seed_and_grow",
          seed_mode: "direct_single",
        })
        yield* projects.transition({ id: project.id, status: "planning" })
        yield* projects.createCharter({
          project_id: project.id,
          scope: ["workspace"],
          success_criteria: ["criterion-a", "criterion-b"],
          acceptance_criteria: ["criterion-a", "criterion-b"],
        })
        const plan = yield* projects.createPlan({
          project_id: project.id,
          phase: "execution",
          summary: "Quiescence",
          acceptance_criteria: ["criterion-a", "criterion-b"],
        })
        const item = yield* projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Criterion A",
          description: "Produce evidence for criterion A",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          capability_packs: ["research-analysis@1"],
          decision_scope: ["project"],
          resource_scope: ["workspace"],
          model_group: "standard",
          review_status: "not_required",
          owner_agent_id: "agent-b2-quiescence",
          acceptance_criteria: ["criterion-a"],
        })
        yield* projects.startWorkItem(item.id)
        const evidence = yield* projects.addArtifact({
          project_id: project.id,
          work_item_id: item.id,
          kind: "evidence",
          title: "Criterion A evidence",
          content: "{}",
        })
        yield* projects.completeWorkItemWithReceipt({
          id: item.id,
          receipt: {
            idempotency_key: "b2-quiescence-receipt",
            outcome: "completed",
            summary: "Criterion A completed",
            artifact_ids: [evidence.id],
            evidence_refs: [{ kind: "artifact", id: evidence.id }],
            confirmed_facts: ["criterion-a"],
            invalidated_assumptions: [],
            unknowns: [],
            blockers: [],
            capability_gaps: [],
            task_proposals: [],
            dependency_proposals: [],
            questions: [],
          },
        })
        const pending = yield* quiescence.check(project.id)
        expect(pending.blocker_codes).toContain("unprocessed_receipts")
        const receipt = (yield* projects.listWorkReceipts(project.id))[0]!
        const processed = yield* supervisor.processReceipt(receipt.id)
        if (processed.status !== "processed") throw new Error("Supervisor was disabled")
        const unrelatedEvidence = yield* projects.addArtifact({
          project_id: project.id,
          kind: "evidence",
          title: "Unrelated evidence",
          evidence: { acceptance_criteria: ["unrelated-criterion"] },
        })
        expect(unrelatedEvidence.id).toBeDefined()
        const missing = yield* quiescence.check(project.id)
        expect(missing.blockers).toContainEqual({
          code: "acceptance_evidence_missing",
          entity_ids: ["criterion-b"],
        })
        const gated = yield* projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Criterion B",
          description: "Record the bounded limitation for criterion B",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          decision_scope: ["project"],
          resource_scope: ["workspace"],
          model_group: "standard",
          review_status: "not_required",
          acceptance_criteria: ["criterion-b"],
        })
        const gate = yield* projects.requestGate({
          project_id: project.id,
          kind: "risk_approval",
          title: "Pending closeout",
          summary: "Quiescence must wait",
          work_item_id: gated.id,
          resource_scope: gated.resource_scope,
        })
        yield* projects.addArtifact({
          project_id: project.id,
          work_item_id: gated.id,
          kind: "acceptance_limitation",
          title: "Criterion B limitation",
          evidence: {
            criterion: "criterion-b",
            limitation: "Criterion B is explicitly limited to local evidence.",
          },
        })
        expect((yield* quiescence.check(project.id)).blocker_codes).toContain("pending_approval_gates")
        yield* projects.resolveGate({ id: gate.id, decision: "approve" })
        yield* projects.startWorkItem(gated.id)
        yield* projects.completeWorkItem(gated.id)
        const gatedReceipt = (yield* projects.listWorkReceipts(project.id)).find(
          (receipt) => receipt.work_item_id === gated.id,
        )
        if (!gatedReceipt) throw new Error("Criterion B receipt was not persisted")
        const gatedProcessed = yield* supervisor.processReceipt(gatedReceipt.id)
        if (gatedProcessed.status !== "processed") throw new Error("Criterion B receipt was not processed")
        const opened = yield* attention.create({
          project_id: project.id,
          idempotency_key: "b3-quiescence-attention",
          issue: {
            issue_kind: "permission_required",
            risk: "high",
            materiality: "permission",
          },
          title: "Material permission decision",
          summary: "Quiescence must wait for the material decision",
          source_refs: [{ kind: "project", id: project.id }],
        })
        const requested = yield* attention.requestAction({
          project_id: project.id,
          attention_id: opened.record.id,
          action: "stop_work",
          idempotency_key: "b3-quiescence-action",
          payload: { reason: "verify claimed blocker" },
          expected_revision: (yield* projects.get(project.id))!.graph_revision,
        })
        const claimed = yield* attention.claimAction(requested.record.id)
        const actionBlocked = yield* quiescence.check(project.id)
        expect(actionBlocked.blocker_codes).toContain("open_material_attention")
        expect(actionBlocked.blocker_codes).toContain("claimed_project_actions")
        yield* attention.close({
          id: opened.record.id,
          expected_version: opened.record.version,
          resolution: "Permission granted",
        })
        yield* attention.applyAction({
          id: claimed.record.id,
          result: { verified: true },
        })
        const completed = yield* quiescence.check(project.id)
        const replayed = yield* quiescence.check(project.id)
        expect(completed).toMatchObject({
          status: "completed",
          ready: true,
          replayed: false,
          quiesce_decision_id: gatedProcessed.decision.id,
        })
        expect(replayed).toMatchObject({
          status: "completed",
          replayed: true,
          delivery_package_artifact_id: completed.delivery_package_artifact_id,
          released_selection_ids: completed.released_selection_ids,
        })
        const deliveryPackages = (yield* projects.listArtifacts(project.id)).filter(
          (artifact) => artifact.kind === "delivery_package",
        )
        expect(deliveryPackages).toHaveLength(1)
        expect((yield* projects.listEvents(project.id)).find((event) => event.type === "delivery.ready")?.data).toMatchObject({
          delivery_id: `delivery:${deliveryPackages[0]!.id}`,
          version: 1,
          graph_revision: completed.graph_revision,
          plan_id: plan.id,
          plan_version: plan.version,
          brief_id: `legacy:${project.id}`,
          brief_version: 1,
          criterion_ids: [],
          delivery_package_artifact_id: deliveryPackages[0]!.id,
          artifact_ids: [evidence.id],
          receipt_ids: [gatedReceipt.id, receipt.id].sort(),
          legacy_unverified: true,
        })
        const coverage = JSON.parse(deliveryPackages[0]!.content!).acceptance_coverage
        expect(coverage[0]).toMatchObject({ criterion: "criterion-a", disposition: "evidence" })
        expect(coverage[1]).toMatchObject({ criterion: "criterion-b", disposition: "limitation" })
        yield* projects.recordEvent({
          project_id: project.id,
          type: "delivery.revision_requested",
          data: { delivery_id: `delivery:${deliveryPackages[0]!.id}` },
        })
        yield* Effect.sync(() =>
          Database.use((db) => {
            const now = Date.now()
            db.update(CompanyWorkItemTable)
              .set({ status: "pending", started_at: null, completed_at: null, updated_at: now })
              .where(eq(CompanyWorkItemTable.id, item.id))
              .run()
            db.update(CompanyProjectTable)
              .set({ status: "executing", orchestration_state: "idle", completed_at: null, updated_at: now })
              .where(eq(CompanyProjectTable.id, project.id))
              .run()
          }),
        )
        yield* projects.startWorkItem(item.id)
        const revisedEvidence = yield* projects.addArtifact({
          project_id: project.id,
          work_item_id: item.id,
          kind: "evidence",
          title: "Criterion A revised evidence",
          content: JSON.stringify({ revision: 2 }),
        })
        yield* projects.completeWorkItemWithReceipt({
          id: item.id,
          receipt: {
            idempotency_key: "b2-quiescence-receipt-v2",
            outcome: "completed",
            summary: "Criterion A revised",
            artifact_ids: [revisedEvidence.id],
            evidence_refs: [{ kind: "artifact", id: revisedEvidence.id }],
            confirmed_facts: ["criterion-a"],
            invalidated_assumptions: [],
            unknowns: [],
            blockers: [],
            capability_gaps: [],
            task_proposals: [],
            dependency_proposals: [],
            questions: [],
          },
        })
        const revisedReceipt = (yield* projects.listWorkReceipts(project.id)).find(
          (candidate) => candidate.idempotency_key === "b2-quiescence-receipt-v2",
        )
        if (!revisedReceipt) throw new Error("Revised receipt was not persisted")
        const revisedProcessed = yield* supervisor.processReceipt(revisedReceipt.id)
        if (revisedProcessed.status !== "processed") throw new Error("Revised receipt was not processed")
        const revised = yield* quiescence.check(project.id)
        const revisedPackages = (yield* projects.listArtifacts(project.id)).filter(
          (artifact) => artifact.kind === "delivery_package",
        )
        expect(revised).toMatchObject({ status: "completed", ready: true, replayed: false })
        expect(revisedPackages).toHaveLength(2)
        expect((yield* projects.listEvents(project.id)).findLast((event) => event.type === "delivery.ready")?.data).toMatchObject({
          delivery_id: `delivery:${revisedPackages[1]!.id}`,
          version: 2,
          delivery_package_artifact_id: revisedPackages[1]!.id,
          artifact_ids: [revisedEvidence.id],
          receipt_ids: [gatedReceipt.id, revisedReceipt.id].sort(),
        })
        expect(releaseCalls).toBe(3)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(process.cwd(), ".artifacts", "seed-grow-b2"), { recursive: true })
          await Bun.write(
            path.join(process.cwd(), ".artifacts", "seed-grow-b2", "quiescence.json"),
            `${JSON.stringify(
              {
                schemaVersion: 1,
                projectId: project.id,
                quiesceDecisionId: completed.quiesce_decision_id,
                deliveryPackageArtifactId: completed.delivery_package_artifact_id,
                acceptanceCoverage: coverage,
                replayed: replayed.replayed,
                releaseCalls,
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
