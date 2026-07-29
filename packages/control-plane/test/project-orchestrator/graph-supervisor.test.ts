import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { and, eq } from "drizzle-orm"
import {
  CompanyGraphMutation,
  CompanyProject,
  CompanyWorkFacts,
  NewGraphWorkItem,
  type Project,
  type WorkItem,
  type WorkReceipt,
} from "../../src/company-project"
import {
  CompanyGraphDecisionTable,
  CompanyGraphMutationTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "../../src/company-project/company-project.sql"
import * as CompanyRollout from "../../src/company-rollout/company-rollout"
import { CompanyRolloutShadowEvaluationTable } from "../../src/company-rollout/company-rollout.sql"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { GraphSupervisor } from "../../src/project-orchestrator/graph-supervisor"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type Seed = {
  project: Project
  source: WorkItem
  receipt: WorkReceipt
  plan_id: string
}

function layer(options: Parameters<typeof GraphSupervisor.makeLayer>[0]) {
  const dependencies = Layer.mergeAll(
    CompanyProject.recoveryControlledLayer,
    CompanyWorkFacts.makeLayer({ recoverOnStart: false }),
    CompanyGraphMutation.defaultLayer,
  )
  return Layer.mergeAll(
    dependencies,
    GraphSupervisor.makeLayer(options).pipe(Layer.provide(dependencies)),
    CrossSpawnSpawner.defaultLayer,
  )
}

function seed(
  projects: CompanyProject.Interface,
  label: string,
  execution_strategy: "legacy_full_plan" | "seed_and_grow" = "seed_and_grow",
) {
  return Effect.gen(function* () {
    const project = yield* projects.create({
      goal: `Supervise ${label}`,
      execution_strategy,
      seed_mode: execution_strategy === "seed_and_grow" ? "seed_pair" : undefined,
    })
    yield* projects.transition({ id: project.id, status: "planning" })
    const plan = yield* projects.createPlan({
      project_id: project.id,
      phase: "execution",
      summary: label,
      acceptance_criteria: ["Graph decision is audited"],
    })
    const source = yield* projects.createWorkItem({
      project_id: project.id,
      plan_id: plan.id,
      title: label,
      description: label,
      kind: "worker",
      work_type: "analysis",
      role: "analyst",
      decision_scope: ["project"],
      resource_scope: ["workspace"],
      model_group: "standard",
      review_status: "not_required",
      owner_agent_id: `agent-${label}`,
      acceptance_criteria: ["Evidence exists"],
    })
    yield* projects.startWorkItem(source.id)
    const artifact = yield* projects.addArtifact({
      project_id: project.id,
      work_item_id: source.id,
      kind: "evidence",
      title: label,
      content: "{}",
    })
    yield* projects.completeWorkItemWithReceipt({
      id: source.id,
      receipt: {
        idempotency_key: `supervisor-${label}`,
        outcome: "completed",
        summary: `${label} completed`,
        artifact_ids: [artifact.id],
        evidence_refs: [{ kind: "artifact", id: artifact.id }],
        confirmed_facts: [`${label}:complete`],
        invalidated_assumptions: [],
        unknowns: [],
        blockers: [],
        capability_gaps: [],
        task_proposals: [],
        dependency_proposals: [],
        questions: [],
      },
    })
    const receipt = (yield* projects.listWorkReceipts(project.id))[0]
    if (!receipt) throw new Error("Seed receipt missing")
    return { project: (yield* projects.get(project.id))!, source, receipt, plan_id: plan.id } satisfies Seed
  })
}

function newItem(plan_id: string, parent_id: string, id: string) {
  return NewGraphWorkItem.parse({
    id,
    plan_id,
    parent_id,
    title: id,
    description: id,
    kind: "worker",
    work_type: "analysis",
    role: "analyst",
    capability_packs: [],
    decision_scope: ["project"],
    resource_scope: ["workspace"],
    inputs: [],
    expected_outputs: ["Evidence"],
    validators: ["Evidence exists"],
    disposition: "retain",
    model_group: "standard",
    risk_level: "medium",
    review_status: "not_required",
    acceptance_criteria: ["Evidence exists"],
    max_attempts: 3,
    purpose: "delivery",
    validation_mode: "machine",
  })
}

let previousExecutionMode: string | undefined

beforeEach(() => {
  previousExecutionMode = process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
})

afterEach(async () => {
  await resetDatabase()
  if (previousExecutionMode === undefined) delete process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
  else process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = previousExecutionMode
})

describe("Graph Supervisor", () => {
  const active = testEffect(
    layer({
      mode: "active",
      decide: (input) => ({
        kind: "expand",
        reason_code: "verified_gap",
        summary: "<thinking>private chain of thought</thinking> verified gap",
        operations: [
          {
            type: "add_work_item",
            item: newItem(
              input.snapshot.nodes.find((node) => node.id === input.receipt.work_item_id)!.plan_id,
              input.receipt.work_item_id,
              `grown-${input.receipt.id}`,
            ),
          },
        ],
      }),
    }),
  )

  active.live("applies one audited decision and finalizes its claimed receipt", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const supervisor = yield* GraphSupervisor.Service
        const input = yield* seed(projects, "active")
        const result = yield* supervisor.processReceipt(input.receipt.id)
        if (result.status !== "processed") throw new Error("Supervisor was disabled")
        expect(result.decision.status).toBe("applied")
        expect(result.decision.summary).not.toContain("private")
        expect(result.decision.added_node_count).toBe(1)
        expect(yield* projects.listWorkItems(input.project.id)).toHaveLength(2)
        expect((yield* projects.listWorkReceipts(input.project.id))[0]).toMatchObject({
          processing_status: "processed",
          processed_decision_id: result.decision.id,
          processed_mutation_id: result.mutation_id,
        })
        const audit = Database.use((db) =>
          db
            .select()
            .from(CompanyProjectEventTable)
            .where(
              and(
                eq(CompanyProjectEventTable.project_id, input.project.id),
                eq(CompanyProjectEventTable.type, "graph_decision.recorded"),
              ),
            )
            .get(),
        )
        expect(audit ? JSON.parse(audit.data_json) : undefined).toMatchObject({
          decisionId: result.decision.id,
          kind: "expand",
          automated: true,
          addedNodeCount: 1,
          reason_code: "verified_gap",
        })
      }),
    ),
  )

  const shadow = testEffect(
    layer({
      mode: "shadow",
      decide: (input) => ({
        kind: "expand",
        reason_code: "shadow_gap",
        summary: "Verified gap in shadow mode",
        operations: [
          {
            type: "add_work_item",
            item: newItem(
              input.snapshot.nodes.find((node) => node.id === input.receipt.work_item_id)!.plan_id,
              input.receipt.work_item_id,
              `shadow-${input.receipt.id}`,
            ),
          },
        ],
      }),
    }),
  )

  shadow.live("records shadow decisions without graph business writes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const supervisor = yield* GraphSupervisor.Service
        const input = yield* seed(projects, "shadow")
        const result = yield* supervisor.processReceipt(input.receipt.id)
        if (result.status !== "processed") throw new Error("Supervisor was disabled")
        expect(result.decision.status).toBe("shadowed")
        expect((yield* projects.get(input.project.id))!.graph_revision).toBe(0)
        expect(yield* projects.listWorkItems(input.project.id)).toHaveLength(1)
        expect(
          Database.use((db) =>
            db
              .select()
              .from(CompanyGraphMutationTable)
              .where(eq(CompanyGraphMutationTable.project_id, input.project.id))
              .all(),
          ),
        ).toHaveLength(0)
      }),
    ),
  )

  shadow.live("evaluates processed legacy receipts from the same graph snapshot without business writes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "shadow"
        CompanyRollout.transition({
          idempotencyKey: "graph-supervisor-legacy-shadow",
          to: "shadow",
          reason: "evaluate the legacy path without applying Seed-and-Grow changes",
        })
        const projects = yield* CompanyProject.Service
        const supervisor = yield* GraphSupervisor.Service
        const input = yield* seed(projects, "legacy-shadow", "legacy_full_plan")
        expect(input.receipt.processing_status).toBe("processed")
        const before = CompanyRollout.projectBusinessStateSha256(input.project.id)
        const first = yield* supervisor.shadowLegacy(input.project.id)
        const after = CompanyRollout.projectBusinessStateSha256(input.project.id)
        expect(first).toHaveLength(1)
        expect(first[0]).toMatchObject({
          projectId: input.project.id,
          receiptId: input.receipt.id,
          kind: "supervisor",
          status: "validated",
          businessStateBeforeSha256: before,
          businessStateAfterSha256: after,
        })
        expect(after).toBe(before)
        expect(yield* supervisor.shadowLegacy(input.project.id)).toEqual(first)
        expect(CompanyRollout.evidence().shadowEvaluations).toEqual(first)
        expect(yield* projects.listWorkItems(input.project.id)).toHaveLength(1)
        expect(
          Database.use((db) =>
            db
              .select()
              .from(CompanyGraphDecisionTable)
              .where(eq(CompanyGraphDecisionTable.project_id, input.project.id))
              .all(),
          ),
        ).toHaveLength(0)
        expect(
          Database.use((db) =>
            db
              .select()
              .from(CompanyGraphMutationTable)
              .where(eq(CompanyGraphMutationTable.project_id, input.project.id))
              .all(),
          ),
        ).toHaveLength(0)
        Database.use((db) =>
          db
            .update(CompanyRolloutShadowEvaluationTable)
            .set({ input_json: "{}" })
            .where(eq(CompanyRolloutShadowEvaluationTable.id, first[0].id))
            .run(),
        )
        expect(() => CompanyRollout.evidence()).toThrow("shadow digest")
      }),
    ),
  )

  let decisions = 0
  const conflict = testEffect(
    layer({
      mode: "active",
      decide: (input) => {
        decisions += 1
        if (decisions === 1)
          Database.use((db) =>
            db
              .update(CompanyProjectTable)
              .set({ graph_revision: input.snapshot.revision + 1 })
              .where(eq(CompanyProjectTable.id, input.project.id))
              .run(),
          )
        return {
          kind: "accept",
          reason_code: "conflict_probe",
          summary: `Decision at revision ${input.snapshot.revision}`,
          operations: [],
        }
      },
    }),
  )

  conflict.live("supersedes a conflicted decision and recomputes from a fresh snapshot", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        decisions = 0
        const projects = yield* CompanyProject.Service
        const supervisor = yield* GraphSupervisor.Service
        const input = yield* seed(projects, "conflict")
        const result = yield* supervisor.processReceipt(input.receipt.id)
        if (result.status !== "processed") throw new Error("Supervisor was disabled")
        expect(result.conflict_count).toBe(1)
        expect((yield* supervisor.listDecisions(input.project.id)).map((decision) => decision.status)).toEqual([
          "superseded",
          "applied",
        ])
        expect(
          Database.use((db) =>
            db
              .select()
              .from(CompanyGraphDecisionTable)
              .where(eq(CompanyGraphDecisionTable.project_id, input.project.id))
              .all(),
          ),
        ).toHaveLength(2)
        expect(
          Database.use(
            (db) =>
              db.select().from(CompanyWorkReceiptTable).where(eq(CompanyWorkReceiptTable.id, input.receipt.id)).get()
                ?.processing_status,
          ),
        ).toBe("processed")
        expect(
          Database.use((db) =>
            db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.project_id, input.project.id)).all(),
          ),
        ).toHaveLength(1)
      }),
    ),
  )
})
