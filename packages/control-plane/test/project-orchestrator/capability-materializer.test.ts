import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CompanyProject, CompanyGraphMutation, CompanyWorkFacts } from "../../src/company-project"
import { CompanyRecruitment } from "../../src/company-recruitment"
import {
  CompanyCapabilityNeedTable,
  CompanyProjectAssignmentTable,
} from "../../src/company-recruitment/company-recruitment.sql"
import { CompanyTable } from "../../src/company/company.sql"
import { CompanyID } from "../../src/company/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { CapabilityMaterializer } from "../../src/project-orchestrator/capability-materializer"
import { GraphSupervisor } from "../../src/project-orchestrator/graph-supervisor"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Database } from "../../src/storage"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const dependencies = Layer.mergeAll(
  CompanyProject.recoveryControlledLayer,
  CompanyWorkFacts.makeLayer({ recoverOnStart: false }),
  CompanyGraphMutation.defaultLayer,
  CompanyRecruitment.defaultLayer,
)
const it = testEffect(
  Layer.mergeAll(
    dependencies,
    GraphSupervisor.makeLayer({ mode: "active" }).pipe(Layer.provide(dependencies)),
    CapabilityMaterializer.layer.pipe(Layer.provide(dependencies)),
    CrossSpawnSpawner.defaultLayer,
  ),
)

afterEach(async () => {
  await resetDatabase()
})

describe("Capability gap materialization", () => {
  it.live("creates a third Need, Selection and Assignment after an applied receipt decision", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const recruitment = yield* CompanyRecruitment.Service
        const supervisor = yield* GraphSupervisor.Service
        const materializer = yield* CapabilityMaterializer.Service
        const companyID = CompanyID.parse("cmp_b2_capability")
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .insert(CompanyTable)
              .values({
                id: companyID,
                name: "B2 Capability Company",
                data_version: 1,
                default_provider_id: ProviderID.make("test"),
                default_model_id: ModelID.make("test-model"),
                bootstrap_request_id: crypto.randomUUID(),
                bootstrap_input_path: "/tmp/b2-capability",
                time_created: Date.now(),
                time_updated: Date.now(),
              })
              .run(),
          ),
        )
        const project = yield* projects.create({
          company_id: companyID,
          goal: "Grow after a verified capability gap",
          execution_strategy: "seed_and_grow",
          seed_mode: "seed_pair",
        })
        yield* projects.transition({ id: project.id, status: "planning" })
        const plan = yield* projects.createPlan({
          project_id: project.id,
          phase: "execution",
          summary: "Capability growth",
          acceptance_criteria: ["A third independent Assignment is persisted"],
        })
        const items = yield* Effect.forEach(["wayfinder", "builder"], (title) =>
          projects.createWorkItem({
            project_id: project.id,
            plan_id: plan.id,
            title,
            description: title,
            kind: "worker",
            work_type: "analysis",
            role: `${title} analyst`,
            capability_packs: ["research-analysis@1"],
            decision_scope: ["project"],
            resource_scope: ["workspace"],
            model_group: "standard",
            review_status: "not_required",
            acceptance_criteria: [`${title} evidence exists`],
          }),
        )
        const initialAssignments = yield* Effect.forEach(
          items,
          (item, index) =>
            Effect.gen(function* () {
              const need = yield* recruitment.createNeed({
                company_id: companyID,
                project_id: project.id,
                work_item_id: item.id,
                need_key: `initial-${index + 1}`,
                role: item.role,
                work_type: item.work_type,
                capability_packs: item.capability_packs,
                allowed_permission_modes: ["read_only"],
                workspace_scopes: item.resource_scope,
                independent_from_agent_ids: (
                  yield* recruitment.listAssignments({ project_id: project.id })
                ).map((assignment) => assignment.agent_id),
              })
              return yield* recruitment.selectAndAssign({
                capability_need_id: need.id,
                exclude_agent_ids: (yield* recruitment.listAssignments({ project_id: project.id })).map(
                  (assignment) => assignment.agent_id,
                ),
              })
            }),
          { concurrency: 1 },
        )
        yield* projects.startWorkItem(items[0]!.id)
        const artifact = yield* projects.addArtifact({
          project_id: project.id,
          work_item_id: items[0]!.id,
          kind: "evidence",
          title: "Capability gap evidence",
          content: "{}",
        })
        yield* projects.completeWorkItemWithReceipt({
          id: items[0]!.id,
          receipt: {
            idempotency_key: "capability-gap-receipt",
            outcome: "completed",
            summary: "A missing evidence capability was verified",
            artifact_ids: [artifact.id],
            evidence_refs: [{ kind: "artifact", id: artifact.id }],
            confirmed_facts: ["gap is real"],
            invalidated_assumptions: [],
            unknowns: [],
            blockers: [],
            capability_gaps: ["independent evidence verification"],
            task_proposals: [],
            dependency_proposals: [],
            questions: [],
          },
        })
        const receipt = (yield* projects.listWorkReceipts(project.id))[0]!
        const processed = yield* supervisor.processReceipt(receipt.id)
        if (processed.status !== "processed") throw new Error("Supervisor was disabled")
        const first = yield* materializer.materializeDecision(processed.decision)
        const replay = yield* materializer.materializeDecision(processed.decision)
        expect(first.capability_need_ids).toHaveLength(1)
        expect(replay).toEqual(first)
        const assignments = yield* recruitment.listAssignments({ project_id: project.id })
        expect(assignments).toHaveLength(3)
        expect(new Set(assignments.map((assignment) => assignment.agent_id)).size).toBe(3)
        expect(assignments.map((assignment) => assignment.agent_id)).toEqual([
          initialAssignments[0]!.agent.id,
          initialAssignments[1]!.agent.id,
          assignments[2]!.agent_id,
        ])
        const needs = Database.use((db) =>
          db
            .select()
            .from(CompanyCapabilityNeedTable)
            .all()
            .filter((need) => need.source_receipt_id === receipt.id),
        )
        expect(needs).toHaveLength(1)
        const grownAssignment = Database.use((db) =>
          db
            .select()
            .from(CompanyProjectAssignmentTable)
            .all()
            .find((assignment) => assignment.source_receipt_id === receipt.id),
        )
        expect(grownAssignment).toMatchObject({
          capability_need_id: needs[0]!.id,
          status: "assigned",
        })
        expect(grownAssignment!.assigned_at).toBeGreaterThanOrEqual(needs[0]!.time_created)
      }),
    ),
  )
})
