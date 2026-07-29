import { afterEach, describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import z from "zod"
import {
  CompanyGraphMutation,
  CompanyProject,
  GraphMutationProposal,
  GraphOperation,
  NewGraphWorkItem,
  type GraphMutationProposal as GraphMutationProposalType,
  type GraphOperation as GraphOperationType,
  type GraphPolicyViolation,
  type NewGraphWorkItem as NewGraphWorkItemType,
  type Plan,
  type Project,
  type WorkItem,
  type WorkReceipt,
} from "../../src/company-project"
import {
  CompanyGraphMutationTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkItemDependencyTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "../../src/company-project/company-project.sql"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage"
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const root = path.resolve(import.meta.dir, "../..")
const reportRoot = path.join(root, ".artifacts/seed-grow-a2")
const migrationPath = path.join(
  root,
  "migration/20260729010000_company_graph_mutation/migration.sql",
)
const broadcasts: { project_id: string; mutation_id: string; graph_revision: number }[] = []

type Seed = {
  project: Project
  plan: Plan
  source: WorkItem
  receipt: WorkReceipt
}

async function writeReport(name: string, value: Record<string, unknown>) {
  await fs.mkdir(reportRoot, { recursive: true })
  await Bun.write(
    path.join(reportRoot, `${name}.json`),
    `${JSON.stringify({ schemaVersion: 1, result: "pass", scenario: name, ...value }, null, 2)}\n`,
  )
}

function completedSource(
  projects: CompanyProject.Interface,
  project: Project,
  plan: Plan,
  label: string,
) {
  return Effect.gen(function* () {
    const source = yield* projects.createWorkItem({
      project_id: project.id,
      plan_id: plan.id,
      title: `Source ${label}`,
      description: `Source ${label}`,
      kind: "worker",
      work_type: "analysis",
      role: "analyst",
      decision_scope: ["project"],
      resource_scope: ["workspace"],
      expected_outputs: ["Evidence"],
      model_group: "standard",
      risk_level: "medium",
      review_status: "not_required",
      owner_agent_id: `agent-${label}`,
      acceptance_criteria: ["Evidence exists"],
    })
    yield* projects.startWorkItem(source.id)
    yield* projects.addArtifact({
      project_id: project.id,
      work_item_id: source.id,
      kind: "evidence",
      title: `Evidence ${label}`,
      content: "{}",
    })
    yield* projects.completeWorkItem(source.id)
    const receipt = (yield* projects.listWorkReceipts(project.id)).find(
      (candidate) => candidate.work_item_id === source.id,
    )
    if (!receipt) throw new Error(`Missing Receipt for ${source.id}`)
    return { source: (yield* projects.listWorkItems(project.id)).find((item) => item.id === source.id)!, receipt }
  })
}

function seed(projects: CompanyProject.Interface, label: string) {
  return Effect.gen(function* () {
    const project = yield* projects.create({ goal: `Graph mutation ${label}` })
    yield* projects.transition({ id: project.id, status: "planning" })
    const plan = yield* projects.createPlan({
      project_id: project.id,
      phase: "execution",
      summary: `Graph mutation ${label}`,
      acceptance_criteria: ["Graph is valid"],
    })
    return { project, plan, ...(yield* completedSource(projects, project, plan, label)) } satisfies Seed
  })
}

function newItem(plan_id: string, id: string, overrides: Partial<NewGraphWorkItemType> = {}) {
  return NewGraphWorkItem.parse({
    id,
    plan_id,
    title: id,
    description: id,
    kind: "worker",
    work_type: "analysis",
    role: "analyst",
    capability_packs: [],
    decision_scope: ["project"],
    resource_scope: ["workspace"],
    inputs: [],
    expected_outputs: ["Verified output"],
    validators: ["Verified output"],
    disposition: "retain",
    model_group: "standard",
    risk_level: "medium",
    review_status: "not_required",
    owner_agent_id: `agent-${id}`,
    acceptance_criteria: ["Verified output"],
    max_attempts: 3,
    purpose: "delivery",
    validation_mode: "machine",
    ...overrides,
  })
}

function proposal(
  seed: Seed,
  input: {
    key: string
    decision: GraphMutationProposalType["decision"]
    operations: GraphOperationType[]
    evidence_refs?: GraphMutationProposalType["evidence_refs"]
    expected_revision?: number
    receipt?: WorkReceipt
  },
) {
  return GraphMutationProposal.parse({
    project_id: seed.project.id,
    trigger_receipt_id: input.receipt?.id ?? seed.receipt.id,
    expected_revision: input.expected_revision ?? 0,
    orchestrator_version: 1,
    idempotency_key: input.key,
    decision: input.decision,
    rationale: input.key,
    evidence_refs: input.evidence_refs ?? input.receipt?.evidence_refs ?? seed.receipt.evidence_refs,
    operations: input.operations,
  })
}

function businessState(project_id: string) {
  return Database.use((db) => ({
    project: db
      .select({
        id: CompanyProjectTable.id,
        graph_revision: CompanyProjectTable.graph_revision,
        updated_at: CompanyProjectTable.updated_at,
      })
      .from(CompanyProjectTable)
      .where(eq(CompanyProjectTable.id, project_id))
      .get(),
    items: db
      .select()
      .from(CompanyWorkItemTable)
      .where(eq(CompanyWorkItemTable.project_id, project_id))
      .orderBy(CompanyWorkItemTable.id)
      .all(),
    dependencies: db
      .select()
      .from(CompanyWorkItemDependencyTable)
      .innerJoin(CompanyWorkItemTable, eq(CompanyWorkItemTable.id, CompanyWorkItemDependencyTable.work_item_id))
      .where(eq(CompanyWorkItemTable.project_id, project_id))
      .orderBy(CompanyWorkItemDependencyTable.work_item_id, CompanyWorkItemDependencyTable.depends_on_id)
      .all(),
    receipts: db
      .select()
      .from(CompanyWorkReceiptTable)
      .where(eq(CompanyWorkReceiptTable.project_id, project_id))
      .orderBy(CompanyWorkReceiptTable.id)
      .all(),
    mutations: db
      .select()
      .from(CompanyGraphMutationTable)
      .where(eq(CompanyGraphMutationTable.project_id, project_id))
      .orderBy(CompanyGraphMutationTable.id)
      .all(),
    events: db
      .select()
      .from(CompanyProjectEventTable)
      .where(eq(CompanyProjectEventTable.project_id, project_id))
      .orderBy(CompanyProjectEventTable.id)
      .all(),
  }))
}

function runProbe(database: string, mode: "prepare" | "fault" | "replay" | "verify", boundary: string) {
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      "test/company-project/graph-mutation-recovery-probe.ts",
      mode,
      boundary,
    ],
    cwd: root,
    env: { ...process.env, AGENTCOMPANY_DB: database },
  })
  const stdout = child.stdout.toString()
  const stderr = child.stderr.toString()
  if (child.exitCode !== 0) throw new Error(stderr || stdout)
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .findLast((entry) => entry.startsWith("{"))
  if (!line) throw new Error(`Graph recovery probe returned no JSON: ${stdout}`)
  return z.record(z.string(), z.unknown()).parse(JSON.parse(line))
}

afterEach(async () => {
  broadcasts.length = 0
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    CompanyProject.defaultLayer,
    CompanyGraphMutation.makeLayer({
      publish: async (input) => {
        broadcasts.push(input)
      },
    }),
    CrossSpawnSpawner.defaultLayer,
  ),
)

test("[a2-mutation-policy] upgrades persisted A1 graph facts with deterministic defaults", async () => {
  await using directory = await tmpdir()
  const database = new SQLite(path.join(directory.path, "a1.db"))
  database.exec("PRAGMA foreign_keys = ON")
  database.exec("CREATE TABLE company_project (id text PRIMARY KEY NOT NULL)")
  database.exec(
    "CREATE TABLE company_work_item (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE, review_status text NOT NULL)",
  )
  database.exec(
    "CREATE TABLE company_work_receipt (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE)",
  )
  database.run("INSERT INTO company_project (id) VALUES ('project-migrated')")
  database.run(
    "INSERT INTO company_work_item (id, project_id, review_status) VALUES ('item-migrated', 'project-migrated', 'pending')",
  )
  database.run(
    "INSERT INTO company_work_receipt (id, project_id) VALUES ('receipt-migrated', 'project-migrated')",
  )
  database.exec(await Bun.file(migrationPath).text())

  expect(database.query("SELECT graph_revision FROM company_project").get()).toEqual({
    graph_revision: 0,
  })
  expect(
    database
      .query(
        "SELECT purpose, origin_kind, graph_revision_created, validation_mode, superseded_by_id FROM company_work_item",
      )
      .get(),
  ).toEqual({
    purpose: "delivery",
    origin_kind: "legacy",
    graph_revision_created: 0,
    validation_mode: "independent_review",
    superseded_by_id: null,
  })
  expect(
    database
      .query(
        `SELECT count(*) AS count
         FROM pragma_index_list('company_graph_mutation')
         WHERE name = 'company_graph_mutation_project_idempotency_idx' AND "unique" = 1`,
      )
      .get(),
  ).toEqual({ count: 1 })
  database.close()
})

describe("Company graph mutation policy", () => {
  it.live("[a2-mutation-policy] rejects unsafe graph patches and applies idempotent audited mutations", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const graph = yield* CompanyGraphMutation.Service
        const seeded = yield* seed(projects, "policy")
        const pending = yield* projects.createWorkItem({
          project_id: seeded.project.id,
          plan_id: seeded.plan.id,
          title: "Pending policy node",
          description: "Pending policy node",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          decision_scope: ["project"],
          resource_scope: ["workspace"],
          model_group: "standard",
          review_status: "not_required",
          acceptance_criteria: ["Policy"],
        })
        const running = yield* projects.createWorkItem({
          project_id: seeded.project.id,
          plan_id: seeded.plan.id,
          title: "Running policy node",
          description: "Running policy node",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          decision_scope: ["project"],
          resource_scope: ["workspace"],
          model_group: "standard",
          review_status: "not_required",
          acceptance_criteria: ["Policy"],
        })
        yield* projects.startWorkItem(running.id)

        const cases: {
          name: string
          expected: GraphPolicyViolation
          value: GraphMutationProposalType
        }[] = [
          {
            name: "evidence",
            expected: "evidence_required",
            value: proposal(seeded, {
              key: "reject-evidence",
              decision: "expand",
              evidence_refs: [],
              operations: [{ type: "add_work_item", item: newItem(seeded.plan.id, "policy-no-evidence") }],
            }),
          },
          {
            name: "scope",
            expected: "scope_escalation",
            value: proposal(seeded, {
              key: "reject-scope",
              decision: "expand",
              operations: [
                {
                  type: "add_work_item",
                  item: newItem(seeded.plan.id, "policy-scope", { resource_scope: ["external"] }),
                },
              ],
            }),
          },
          {
            name: "high-risk",
            expected: "high_risk_gate_required",
            value: proposal(seeded, {
              key: "reject-high-risk",
              decision: "expand",
              operations: [
                {
                  type: "add_work_item",
                  item: newItem(seeded.plan.id, "policy-high-risk", {
                    risk_level: "high",
                    validation_mode: "self_check",
                  }),
                },
              ],
            }),
          },
          {
            name: "high-risk-without-gate",
            expected: "high_risk_gate_required",
            value: proposal(seeded, {
              key: "reject-high-risk-without-gate",
              decision: "expand",
              operations: [
                {
                  type: "add_work_item",
                  item: newItem(seeded.plan.id, "policy-high-risk-without-gate", {
                    risk_level: "high",
                    validation_mode: "review_and_user_gate",
                  }),
                },
              ],
            }),
          },
          {
            name: "self-review",
            expected: "self_review",
            value: proposal(seeded, {
              key: "reject-self-review",
              decision: "expand",
              operations: [
                {
                  type: "add_work_item",
                  item: newItem(seeded.plan.id, "policy-reviewer", {
                    parent_id: seeded.source.id,
                    kind: "reviewer",
                    owner_agent_id: seeded.source.owner_agent_id,
                    validation_mode: "independent_review",
                  }),
                },
              ],
            }),
          },
          {
            name: "missing",
            expected: "missing_node",
            value: proposal(seeded, {
              key: "reject-missing",
              decision: "rewire",
              operations: [
                { type: "add_dependency", work_item_id: pending.id, depends_on_id: "missing-node" },
              ],
            }),
          },
          {
            name: "immutable",
            expected: "immutable_fact",
            value: proposal(seeded, {
              key: "reject-immutable",
              decision: "rewire",
              operations: [
                {
                  type: "add_dependency",
                  work_item_id: seeded.source.id,
                  depends_on_id: pending.id,
                },
              ],
            }),
          },
          {
            name: "running",
            expected: "running_dependency_change",
            value: proposal(seeded, {
              key: "reject-running",
              decision: "rewire",
              operations: [
                { type: "add_dependency", work_item_id: running.id, depends_on_id: seeded.source.id },
              ],
            }),
          },
          {
            name: "cycle",
            expected: "cycle",
            value: proposal(seeded, {
              key: "reject-cycle",
              decision: "expand",
              operations: [
                { type: "add_work_item", item: newItem(seeded.plan.id, "cycle-a") },
                { type: "add_work_item", item: newItem(seeded.plan.id, "cycle-b") },
                { type: "add_dependency", work_item_id: "cycle-a", depends_on_id: "cycle-b" },
                { type: "add_dependency", work_item_id: "cycle-b", depends_on_id: "cycle-a" },
              ],
            }),
          },
          {
            name: "parent-cycle",
            expected: "cycle",
            value: proposal(seeded, {
              key: "reject-parent-cycle",
              decision: "expand",
              operations: [
                {
                  type: "add_work_item",
                  item: newItem(seeded.plan.id, "parent-cycle-a", { parent_id: "parent-cycle-b" }),
                },
                {
                  type: "add_work_item",
                  item: newItem(seeded.plan.id, "parent-cycle-b", { parent_id: "parent-cycle-a" }),
                },
              ],
            }),
          },
          {
            name: "self-dependency",
            expected: "self_dependency",
            value: proposal(seeded, {
              key: "reject-self-dependency",
              decision: "rewire",
              operations: [
                {
                  type: "add_dependency",
                  work_item_id: pending.id,
                  depends_on_id: pending.id,
                },
              ],
            }),
          },
        ]
        const verdicts = yield* Effect.forEach(cases, (item) =>
          graph.shadow(item.value).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                expect(result.status).toBe("rejected")
                if (result.status === "rejected") expect(result.verdict.violations).toContain(item.expected)
              }),
            ),
          ),
        )
        expect(GraphOperation.safeParse({ type: "delete_artifact", artifact_id: "artifact" }).success).toBe(false)
        expect(GraphOperation.safeParse({ type: "delete_event", event_id: "event" }).success).toBe(false)
        expect(
          GraphOperation.safeParse({
            type: "update_acceptance_criteria",
            work_item_id: pending.id,
            acceptance_criteria: [],
          }).success,
        ).toBe(false)
        expect(GraphOperation.safeParse({ type: "execute_script", source: "SELECT 1" }).success).toBe(false)
        const gated = yield* graph.shadow(
          proposal(seeded, {
            key: "allow-high-risk-with-gate",
            decision: "expand",
            operations: [
              {
                type: "add_work_item",
                item: newItem(seeded.plan.id, "policy-gated", {
                  risk_level: "high",
                  validation_mode: "review_and_user_gate",
                }),
              },
              {
                type: "add_validation_gate",
                gate: {
                  id: "gate-policy-gated",
                  work_item_id: "policy-gated",
                  title: "Approve high-risk work",
                  summary: "High-risk work cannot start without approval",
                  risk_level: "high",
                  validation_mode: "review_and_user_gate",
                },
              },
            ],
          }),
        )
        expect(gated.status).toBe("validated")

        const rejected = yield* graph.apply(cases[0].value)
        expect(rejected.status).toBe("rejected")
        const expandInput = proposal(seeded, {
          key: "apply-expand",
          decision: "expand",
          operations: [
            { type: "add_work_item", item: newItem(seeded.plan.id, "policy-child") },
            { type: "add_work_item", item: newItem(seeded.plan.id, "policy-downstream") },
            {
              type: "add_dependency",
              work_item_id: "policy-child",
              depends_on_id: seeded.source.id,
            },
            {
              type: "add_dependency",
              work_item_id: "policy-downstream",
              depends_on_id: "policy-child",
            },
          ],
        })
        const expanded = yield* graph.apply(expandInput)
        expect(expanded.status).toBe("applied")
        if (expanded.status !== "applied") throw new Error("Expected applied expansion")
        expect(expanded.mutation.applied_revision).toBe(1)
        expect(expanded.after.nodes.some((node) => node.id === "policy-child")).toBe(true)
        expect(broadcasts).toHaveLength(1)
        const replayed = yield* graph.apply(expandInput)
        expect(replayed.status).toBe("applied")
        if (replayed.status === "applied") expect(replayed.replayed).toBe(true)
        expect(broadcasts).toHaveLength(1)

        const nextSource = yield* completedSource(projects, seeded.project, seeded.plan, "policy-next")
        const superseded = yield* graph.apply(
          proposal(seeded, {
            key: "apply-supersede",
            decision: "supersede",
            expected_revision: 1,
            receipt: nextSource.receipt,
            operations: [
              { type: "add_work_item", item: newItem(seeded.plan.id, "policy-replacement") },
              {
                type: "supersede_work_item",
                work_item_id: "policy-child",
                replacement_id: "policy-replacement",
                reason: "Receipt invalidated the original path",
              },
            ],
          }),
        )
        expect(superseded.status).toBe("applied")
        expect(broadcasts).toHaveLength(2)
        const items = yield* projects.listWorkItems(seeded.project.id)
        expect(items.find((item) => item.id === "policy-child")).toMatchObject({
          status: "superseded",
          superseded_by_id: "policy-replacement",
        })
        expect(items.find((item) => item.id === "policy-replacement")).toMatchObject({
          origin_kind: "graph_mutation",
          graph_revision_created: 2,
        })
        expect((yield* projects.readyWorkItems(seeded.project.id)).map((item) => item.id)).toEqual(
          expect.arrayContaining(["policy-downstream", "policy-replacement"]),
        )
        const mutations = yield* graph.list(seeded.project.id)
        const events = yield* projects.listEvents(seeded.project.id)
        expect(mutations.map((mutation) => mutation.status)).toEqual(["rejected", "applied", "applied"])
        expect(events.filter((event) => event.type === "graph_mutation.applied")).toHaveLength(2)
        expect(events.filter((event) => event.type === "graph_mutation.rejected")).toHaveLength(1)
        expect(events.filter((event) => event.type === "work_item.superseded")).toHaveLength(1)
        const finalSnapshot = yield* graph.snapshot(seeded.project.id)

        yield* Effect.promise(() =>
          writeReport("mutation-policy", {
            mutation_input: {
              decision: expandInput.decision,
              expected_revision: expandInput.expected_revision,
              evidence_refs: expandInput.evidence_refs.length,
              operations: expandInput.operations.map((operation) => operation.type),
            },
            policy_verdicts: cases.map((item, index) => ({
              case: item.name,
              expected_violation: item.expected,
              result: verdicts[index].status,
              violations:
                verdicts[index].status === "rejected" ? verdicts[index].verdict.violations : [],
            })),
            snapshots: {
              before: {
                revision: expanded.before.revision,
                nodes: expanded.before.nodes.length,
                dependencies: expanded.before.dependencies.length,
              },
              after_expand: {
                revision: expanded.after.revision,
                nodes: expanded.after.nodes.length,
                dependencies: expanded.after.dependencies.length,
              },
              after_supersede: {
                revision: finalSnapshot.revision,
                nodes: finalSnapshot.nodes.length,
                dependencies: finalSnapshot.dependencies.length,
                superseded: finalSnapshot.nodes.filter((node) => node.status === "superseded").length,
              },
            },
            rejected_rules: verdicts.length,
            prohibited_operations_rejected: 4,
            high_risk_with_gate_allowed: true,
            applied_mutations: 2,
            rejected_mutations: 1,
            final_revision: 2,
            idempotent_replay: true,
            duplicate_broadcasts: 0,
            superseded_traceable: true,
          }),
        )
      }),
    ),
  )

  it.live("[a2-concurrency] commits one old revision and recomputes the loser", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const graph = yield* CompanyGraphMutation.Service
        const seeded = yield* seed(projects, "concurrency-a")
        const second = yield* completedSource(projects, seeded.project, seeded.plan, "concurrency-b")
        const inputs = [
          proposal(seeded, {
            key: "concurrency-a",
            decision: "expand",
            receipt: seeded.receipt,
            operations: [
              { type: "add_work_item", item: newItem(seeded.plan.id, "concurrency-item-a") },
              {
                type: "add_dependency",
                work_item_id: "concurrency-item-a",
                depends_on_id: seeded.source.id,
              },
            ],
          }),
          proposal(seeded, {
            key: "concurrency-b",
            decision: "expand",
            receipt: second.receipt,
            operations: [
              { type: "add_work_item", item: newItem(seeded.plan.id, "concurrency-item-b") },
              {
                type: "add_dependency",
                work_item_id: "concurrency-item-b",
                depends_on_id: second.source.id,
              },
            ],
          }),
        ]
        const before = yield* graph.snapshot(seeded.project.id)
        const firstPass = yield* Effect.all(inputs.map((input) => graph.apply(input)), { concurrency: "unbounded" })
        expect(firstPass.filter((result) => result.status === "applied")).toHaveLength(1)
        expect(firstPass.filter((result) => result.status === "conflict")).toHaveLength(1)
        const loser = firstPass.findIndex((result) => result.status === "conflict")
        if (loser < 0) throw new Error("Expected revision conflict")
        const conflict = firstPass[loser]
        if (conflict.status !== "conflict") throw new Error("Expected revision conflict")
        expect(conflict).toMatchObject({
          reason: "revision_mismatch",
          expected_revision: 0,
          actual_revision: 1,
        })
        const recomputed = yield* graph.apply(
          GraphMutationProposal.parse({ ...inputs[loser], expected_revision: conflict.actual_revision }),
        )
        expect(recomputed.status).toBe("applied")
        if (recomputed.status === "applied") expect(recomputed.mutation.applied_revision).toBe(2)
        expect((yield* graph.snapshot(seeded.project.id)).revision).toBe(2)
        expect(yield* graph.list(seeded.project.id)).toHaveLength(2)
        const receipts = yield* projects.listWorkReceipts(seeded.project.id)
        expect(receipts.filter((receipt) => receipt.processed_mutation_id)).toHaveLength(2)
        const after = yield* graph.snapshot(seeded.project.id)

        yield* Effect.promise(() =>
          writeReport("concurrency", {
            mutation_inputs: inputs.map((input) => ({
              decision: input.decision,
              expected_revision: input.expected_revision,
              evidence_refs: input.evidence_refs.length,
              operations: input.operations.map((operation) => operation.type),
            })),
            conflict: {
              reason: conflict.reason,
              expected_revision: conflict.expected_revision,
              actual_revision: conflict.actual_revision,
              snapshot_revision: conflict.before.revision,
            },
            snapshots: {
              before: {
                revision: before.revision,
                nodes: before.nodes.length,
                dependencies: before.dependencies.length,
              },
              after: {
                revision: after.revision,
                nodes: after.nodes.length,
                dependencies: after.dependencies.length,
              },
            },
            old_revision_candidates: 2,
            old_revision_commits: 1,
            conflicts: 1,
            recomputed_commits: 1,
            final_revision: 2,
            duplicate_mutations: 0,
          }),
        )
      }),
    ),
  )

  it.live("[a2-shadow-zero-write] returns a policy decision without business-state writes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const graph = yield* CompanyGraphMutation.Service
        const seeded = yield* seed(projects, "shadow")
        const input = proposal(seeded, {
          key: "shadow-expand",
          decision: "expand",
          operations: [
            { type: "add_work_item", item: newItem(seeded.plan.id, "shadow-item") },
            {
              type: "add_dependency",
              work_item_id: "shadow-item",
              depends_on_id: seeded.source.id,
            },
          ],
        })
        const before = businessState(seeded.project.id)
        const result = yield* graph.shadow(input)
        const after = businessState(seeded.project.id)
        expect(result.status).toBe("validated")
        if (result.status !== "validated") throw new Error("Expected validated shadow result")
        expect(result.verdict).toEqual({ result: "allowed", violations: [] })
        expect(result.before.revision).toBe(0)
        expect(result.preview.revision).toBe(1)
        expect(result.preview.nodes.some((node) => node.id === "shadow-item")).toBe(true)
        expect(after).toEqual(before)

        yield* Effect.promise(() =>
          writeReport("shadow-zero-write", {
            mutation_input: {
              decision: input.decision,
              expected_revision: input.expected_revision,
              evidence_refs: input.evidence_refs.length,
              operations: input.operations.map((operation) => operation.type),
            },
            policy_verdict: result.verdict,
            snapshots: {
              before: {
                revision: result.before.revision,
                nodes: result.before.nodes.length,
                dependencies: result.before.dependencies.length,
              },
              preview: {
                revision: result.preview.revision,
                nodes: result.preview.nodes.length,
                dependencies: result.preview.dependencies.length,
              },
            },
            decision: "validated",
            predicted_revision: 1,
            project_writes: 0,
            work_item_writes: 0,
            dependency_writes: 0,
            receipt_writes: 0,
            mutation_writes: 0,
            event_writes: 0,
          }),
        )
      }),
    ),
  )
})

test("[a2-transaction-recovery] recovers every transaction and broadcast boundary atomically", async () => {
  await using directory = await tmpdir()
  const rolledBack = [
    "before_transaction",
    "after_mutation_write",
    "after_operations",
    "after_revision",
    "after_event",
  ]
  const committed = ["after_commit", "after_broadcast"]
  for (const boundary of [...rolledBack, ...committed]) {
    const database = path.join(directory.path, `${boundary}.db`)
    expect(runProbe(database, "prepare", boundary)).toMatchObject({ result: "pass", mode: "prepare", boundary })
    expect(runProbe(database, "fault", boundary)).toMatchObject({
      result: "pass",
      mode: "fault",
      boundary,
      faulted: true,
    })
    const expected = rolledBack.includes(boundary)
      ? {
          graph_revision: 0,
          mutations: 0,
          added_items: 0,
          dependencies: 0,
          applied_events: 0,
          receipt_bound: false,
        }
      : {
          graph_revision: 1,
          mutations: 1,
          added_items: 1,
          dependencies: 1,
          applied_events: 1,
          receipt_bound: true,
        }
    expect(runProbe(database, "verify", boundary)).toMatchObject({ result: "pass", ...expected })
    if (committed.includes(boundary)) {
      expect(runProbe(database, "replay", boundary)).toMatchObject({
        result: "pass",
        status: "applied",
        replayed: true,
      })
      expect(runProbe(database, "verify", boundary)).toMatchObject({ result: "pass", ...expected })
    }
  }
  await writeReport("transaction-recovery", {
    mutation_input: {
      decision: "expand",
      expected_revision: 0,
      evidence_refs: 1,
      operations: ["add_work_item", "add_dependency"],
    },
    boundaries: [
      ...rolledBack.map((boundary) => ({
        boundary,
        transaction: "rolled_back",
        graph_revision: 0,
        mutations: 0,
        added_items: 0,
        dependencies: 0,
        applied_events: 0,
        receipt_bound: false,
      })),
      ...committed.map((boundary) => ({
        boundary,
        transaction: "committed",
        graph_revision: 1,
        mutations: 1,
        added_items: 1,
        dependencies: 1,
        applied_events: 1,
        receipt_bound: true,
        replayed_without_write: true,
      })),
    ],
    rollback_boundaries: rolledBack.length,
    committed_boundaries: committed.length,
    partial_graphs: 0,
    duplicate_mutations: 0,
    duplicate_dispatches: 0,
    restart_replays_idempotent: true,
  })
})
