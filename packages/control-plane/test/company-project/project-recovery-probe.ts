import { Effect, Layer } from "effect"
import { and, eq } from "drizzle-orm"
import { AgentRunTable } from "../../src/agent-run/agent-run.sql"
import {
  CompanyGraphMutation,
  CompanyProjectRecovery,
  CompanyValidationGate,
  CompanyWorkFacts,
} from "../../src/company-project"
import {
  CompanyGraphMutationTable,
  CompanyPlanTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemDependencyTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "../../src/company-project/company-project.sql"
import type { Boundary } from "../../src/company-project/recovery"
import { CompanyWorkProjectionTable } from "../../src/company-project/work-projection.sql"
import { Database } from "../../src/storage"

const mode = Bun.argv[2]
const boundary = (
  [
    "before_recovery",
    "after_receipts",
    "after_mutations",
    "after_gates",
    "after_work_items",
    "after_projections",
  ] as const satisfies readonly Boundary[]
).find((value) => value === Bun.argv[3])
if (!boundary) throw new Error("Expected a valid project recovery boundary")

const projectID = "project-a4-recovery"
const planID = "plan-a4-recovery"
const sourceID = "source-a4-recovery"
const sourceAttemptID = "attempt-a4-source"
const sourceReceiptID = "receipt-a4-source"
const evidenceID = "evidence-a4-source"
const mutationID = "mutation-a4-proposed"
const mutationItemID = "mutation-a4-added"
const targetID = "gate-a4-target"
const orphanID = "orphan-a4-runtime"
const orphanAttemptID = "attempt-a4-orphan"
const terminalID = "terminal-a4-runtime"
const terminalAttemptID = "attempt-a4-terminal"
const terminalReceiptID = "receipt-a4-terminal"
const activeID = "active-a4-runtime"
const activeAttemptID = "attempt-a4-active"
const activeRunID = "run-a4-active"
const runningGateID = "gate-a4-running"
const invalidPassGateID = "gate-a4-invalid-pass"
const circuitGateID = "gate-a4-circuit"
const now = 1_900_000_000_000
const criteria = [
  {
    id: "a4-anchor",
    statement: "A4 recovery anchor remains true",
    anchor: { kind: "policy", reference: "policy:a4-recovery" },
    operator: "equals",
    expected: true,
  },
]
const criteriaSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(criteria)).digest("hex")

function workItem(id: string, status: "pending" | "running" | "completed", attempt = 0) {
  return {
    id,
    project_id: projectID,
    plan_id: planID,
    title: id,
    description: id,
    kind: "worker",
    work_type: "analysis",
    role: "analyst",
    capability_packs_json: "[]",
    decision_scope_json: "[]",
    resource_scope_json: "[]",
    inputs_json: "[]",
    expected_outputs_json: '["Recovered"]',
    validators_json: '["Recovered"]',
    disposition: "retain",
    model_group: "standard",
    risk_level: "medium",
    review_status: "not_required",
    status,
    purpose: "delivery",
    origin_kind: "seed",
    graph_revision_created: 0,
    validation_mode: "machine",
    acceptance_criteria_json: '["Recovered"]',
    attempt,
    max_attempts: 3,
    started_at: attempt ? now : null,
    completed_at: status === "completed" ? now + 1 : null,
    created_at: now,
    updated_at: now,
  }
}

function receipt(input: {
  id: string
  work_item_id: string
  attempt_id: string
  processing_status: "pending" | "processed"
}) {
  return {
    id: input.id,
    project_id: projectID,
    work_item_id: input.work_item_id,
    attempt_id: input.attempt_id,
    idempotency_key: input.id,
    outcome: "completed",
    summary: "Recovered",
    artifact_ids_json: "[]",
    evidence_refs_json: JSON.stringify([{ kind: "project_event", id: evidenceID }]),
    confirmed_facts_json: '["recovered"]',
    invalidated_assumptions_json: "[]",
    unknowns_json: "[]",
    blockers_json: "[]",
    capability_gaps_json: "[]",
    task_proposals_json: "[]",
    dependency_proposals_json: "[]",
    questions_json: "[]",
    processing_status: input.processing_status,
    created_at: now + 1,
    processed_at: input.processing_status === "processed" ? now + 1 : null,
  }
}

function gate(
  id: string,
  status: "running" | "passed" | "failed",
  input: { evidence_refs_json?: string; repair_round?: number } = {},
) {
  return {
    id,
    project_id: projectID,
    work_item_id: targetID,
    kind: "policy",
    status,
    criteria_json: JSON.stringify(criteria),
    criteria_sha256: criteriaSha256,
    blocking_work_item_ids_json: JSON.stringify([targetID]),
    evidence_refs_json: input.evidence_refs_json ?? "[]",
    evaluator: "policy_invariant_v1",
    repair_round: input.repair_round ?? 0,
    max_repair_rounds: 3,
    failure_summary: status === "failed" ? "Persistent deterministic failure" : null,
    created_at: now,
    evaluated_at: status === "running" ? null : now + 1,
  }
}

async function output(value: Record<string, unknown>) {
  Database.close()
  await Bun.write(Bun.stdout, `${JSON.stringify(value)}\n`)
  process.exit(0)
}

if (mode === "prepare") {
  const db = Database.Client()
  db.insert(CompanyProjectTable)
    .values({
      id: projectID,
      goal: "A4 recovery",
      title: "A4 recovery",
      status: "executing",
      output_dir: "/tmp",
      created_at: now,
      updated_at: now,
    })
    .run()
  db.insert(CompanyPlanTable)
    .values({
      id: planID,
      project_id: projectID,
      version: 1,
      phase: "execution",
      status: "active",
      summary: "A4 recovery",
      assumptions_json: "[]",
      acceptance_criteria_json: '["Recovered"]',
      created_at: now,
    })
    .run()
  db.insert(CompanyWorkItemTable)
    .values([
      workItem(sourceID, "completed", 1),
      workItem(targetID, "pending"),
      workItem(orphanID, "running", 1),
      workItem(terminalID, "running", 1),
      workItem(activeID, "running", 1),
    ])
    .run()
  db.insert(CompanyWorkAttemptTable)
    .values([
      {
        id: sourceAttemptID,
        project_id: projectID,
        work_item_id: sourceID,
        ordinal: 1,
        status: "completed",
        started_at: now,
        finished_at: now + 1,
      },
      {
        id: orphanAttemptID,
        project_id: projectID,
        work_item_id: orphanID,
        ordinal: 1,
        status: "running",
        started_at: now,
      },
      {
        id: terminalAttemptID,
        project_id: projectID,
        work_item_id: terminalID,
        ordinal: 1,
        status: "completed",
        started_at: now,
        finished_at: now + 1,
      },
      {
        id: activeAttemptID,
        project_id: projectID,
        work_item_id: activeID,
        agent_run_id: activeRunID,
        ordinal: 1,
        status: "running",
        started_at: now,
      },
    ])
    .run()
  db.insert(AgentRunTable)
    .values({
      id: activeRunID,
      agent_id: "agent-a4-active",
      runtime: "pi",
      lifecycle: "on_demand",
      permission_mode: "workspace_write",
      state: "awaiting_recovery",
      company_project_id: projectID,
      work_item_id: activeID,
      cwd: "/tmp/a4-active",
      runtime_home_path: "/tmp/a4-active/runtime",
      time_started: now,
      time_created: now,
      time_updated: now,
    })
    .run()
  db.insert(CompanyProjectEventTable)
    .values({
      id: evidenceID,
      project_id: projectID,
      type: "work_receipt.submitted",
      data_json: JSON.stringify({ receipt_id: sourceReceiptID }),
      created_at: now + 1,
    })
    .run()
  db.insert(CompanyWorkReceiptTable)
    .values([
      receipt({
        id: sourceReceiptID,
        work_item_id: sourceID,
        attempt_id: sourceAttemptID,
        processing_status: "pending",
      }),
      receipt({
        id: terminalReceiptID,
        work_item_id: terminalID,
        attempt_id: terminalAttemptID,
        processing_status: "processed",
      }),
    ])
    .run()
  const operations = [
    {
      type: "add_work_item",
      item: {
        id: mutationItemID,
        plan_id: planID,
        title: "Recovered mutation item",
        description: "Recovered mutation item",
        kind: "worker",
        work_type: "analysis",
        role: "analyst",
        capability_packs: [],
        decision_scope: [],
        resource_scope: [],
        inputs: [],
        expected_outputs: ["Recovered"],
        validators: ["Recovered"],
        disposition: "retain",
        model_group: "standard",
        risk_level: "medium",
        review_status: "not_required",
        acceptance_criteria: ["Recovered"],
        max_attempts: 3,
        purpose: "recovery",
        validation_mode: "machine",
      },
    },
    {
      type: "add_dependency",
      work_item_id: mutationItemID,
      depends_on_id: sourceID,
    },
  ]
  db.insert(CompanyGraphMutationTable)
    .values({
      id: mutationID,
      project_id: projectID,
      trigger_receipt_id: sourceReceiptID,
      expected_revision: 0,
      orchestrator_version: 1,
      idempotency_key: "a4-proposed-recovery",
      decision: "expand",
      rationale: "Recover a committed proposed mutation",
      evidence_refs_json: JSON.stringify([{ kind: "project_event", id: evidenceID }]),
      operations_json: JSON.stringify(operations),
      status: "proposed",
      policy_verdict_json: JSON.stringify({ result: "allowed", violations: [] }),
      created_at: now + 2,
    })
    .run()
  db.insert(CompanyValidationGateTable)
    .values([
      gate(runningGateID, "running"),
      gate(invalidPassGateID, "passed", {
        evidence_refs_json: JSON.stringify([{ kind: "artifact", id: "missing-a4-artifact" }]),
      }),
      gate(circuitGateID, "failed", { repair_round: 3 }),
    ])
    .run()
  db.insert(CompanyWorkProjectionTable)
    .values({
      project_id: projectID,
      projector_version: 0,
      source_watermark: "stale",
      projection_json: "{}",
      updated_at: now,
    })
    .run()
  await output({ result: "pass", mode, boundary })
}

const recoveryLayer = CompanyProjectRecovery.makeLayer({
  onBoundary: (current) => {
    if (mode === "fault" && current === boundary) process.exit(91)
  },
}).pipe(
  Layer.provide(CompanyWorkFacts.makeLayer({ recoverOnStart: false })),
  Layer.provide(CompanyGraphMutation.makeLayer({ publish: async () => {} })),
  Layer.provide(CompanyValidationGate.defaultLayer),
)

if (mode === "fault" || mode === "recover") {
  const report = await Effect.runPromise(
    CompanyProjectRecovery.Service.use((service) => service.recover()).pipe(Effect.provide(recoveryLayer)),
  )
  await output({ result: "pass", mode, boundary, report })
}

if (mode === "verify") {
  const db = Database.Client()
  const project = db
    .select({ graph_revision: CompanyProjectTable.graph_revision })
    .from(CompanyProjectTable)
    .where(eq(CompanyProjectTable.id, projectID))
    .get()!
  const sourceReceipt = db
    .select()
    .from(CompanyWorkReceiptTable)
    .where(eq(CompanyWorkReceiptTable.id, sourceReceiptID))
    .get()!
  const mutation = db
    .select()
    .from(CompanyGraphMutationTable)
    .where(eq(CompanyGraphMutationTable.id, mutationID))
    .get()!
  const addedItems = db
    .select({ id: CompanyWorkItemTable.id })
    .from(CompanyWorkItemTable)
    .where(eq(CompanyWorkItemTable.id, mutationItemID))
    .all()
  const dependencies = db
    .select()
    .from(CompanyWorkItemDependencyTable)
    .where(
      and(
        eq(CompanyWorkItemDependencyTable.work_item_id, mutationItemID),
        eq(CompanyWorkItemDependencyTable.depends_on_id, sourceID),
      ),
    )
    .all()
  const gates = db
    .select({
      id: CompanyValidationGateTable.id,
      status: CompanyValidationGateTable.status,
    })
    .from(CompanyValidationGateTable)
    .orderBy(CompanyValidationGateTable.id)
    .all()
  const orphan = db
    .select({ status: CompanyWorkItemTable.status })
    .from(CompanyWorkItemTable)
    .where(eq(CompanyWorkItemTable.id, orphanID))
    .get()!
  const terminal = db
    .select({ status: CompanyWorkItemTable.status })
    .from(CompanyWorkItemTable)
    .where(eq(CompanyWorkItemTable.id, terminalID))
    .get()!
  const active = db
    .select({ status: CompanyWorkItemTable.status })
    .from(CompanyWorkItemTable)
    .where(eq(CompanyWorkItemTable.id, activeID))
    .get()!
  const projection = db
    .select()
    .from(CompanyWorkProjectionTable)
    .where(eq(CompanyWorkProjectionTable.project_id, projectID))
    .get()!
  const eventCounts = Object.fromEntries(
    [
      "work_receipt.processed",
      "graph_mutation.applied",
      "validation_gate.recovered",
      "attention.requested",
      "work_item.recovered",
    ].map((type) => [
      type,
      db
        .select({ id: CompanyProjectEventTable.id })
        .from(CompanyProjectEventTable)
        .where(and(eq(CompanyProjectEventTable.project_id, projectID), eq(CompanyProjectEventTable.type, type)))
        .all().length,
    ]),
  )
  await output({
    result: "pass",
    mode,
    boundary,
    graph_revision: project.graph_revision,
    source_receipt_status: sourceReceipt.processing_status,
    source_receipt_mutation_id: sourceReceipt.processed_mutation_id,
    mutation_status: mutation.status,
    mutation_items: addedItems.length,
    mutation_dependencies: dependencies.length,
    gates,
    orphan_status: orphan.status,
    terminal_status: terminal.status,
    active_status: active.status,
    projection_version: projection.projector_version,
    projection_rebuilt: projection.source_watermark !== "stale",
    event_counts: eventCounts,
  })
}

throw new Error("Expected prepare, fault, recover, or verify")
