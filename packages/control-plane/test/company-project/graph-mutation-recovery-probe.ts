import { Effect } from "effect"
import { and, eq } from "drizzle-orm"
import { CompanyGraphMutation, type Boundary } from "../../src/company-project/graph-mutation"
import {
  CompanyGraphMutationTable,
  CompanyPlanTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemDependencyTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "../../src/company-project/company-project.sql"
import { GraphMutationProposal } from "../../src/company-project/schema"
import { Database } from "../../src/storage"

const mode = Bun.argv[2]
const boundary = (
  [
    "before_transaction",
    "after_mutation_write",
    "after_operations",
    "after_revision",
    "after_event",
    "after_commit",
    "after_broadcast",
  ] as const satisfies readonly Boundary[]
).find((value) => value === Bun.argv[3])
if (!boundary) throw new Error("Expected a valid graph mutation boundary")
const suffix = boundary.replaceAll("_", "-")
const projectID = `project-${suffix}`
const planID = `plan-${suffix}`
const sourceID = `source-${suffix}`
const attemptID = `attempt-${suffix}`
const receiptID = `receipt-${suffix}`
const evidenceID = `evidence-${suffix}`
const itemID = `added-${suffix}`
const now = 1_900_000_000_000

const proposal = GraphMutationProposal.parse({
  project_id: projectID,
  trigger_receipt_id: receiptID,
  expected_revision: 0,
  orchestrator_version: 1,
  idempotency_key: `mutation-${suffix}`,
  decision: "expand",
  rationale: `Recover ${boundary}`,
  evidence_refs: [{ kind: "project_event", id: evidenceID }],
  operations: [
    {
      type: "add_work_item",
      item: {
        id: itemID,
        plan_id: planID,
        title: `Added ${boundary}`,
        description: `Added ${boundary}`,
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
      work_item_id: itemID,
      depends_on_id: sourceID,
    },
  ],
})

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
      goal: `Recover ${boundary}`,
      title: `Recover ${boundary}`,
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
      summary: "Recover",
      assumptions_json: "[]",
      acceptance_criteria_json: '["Recovered"]',
      created_at: now,
    })
    .run()
  db.insert(CompanyWorkItemTable)
    .values({
      id: sourceID,
      project_id: projectID,
      plan_id: planID,
      title: "Source",
      description: "Source",
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
      status: "completed",
      acceptance_criteria_json: '["Recovered"]',
      attempt: 1,
      max_attempts: 3,
      started_at: now,
      completed_at: now + 1,
      created_at: now,
      updated_at: now + 1,
    })
    .run()
  db.insert(CompanyWorkAttemptTable)
    .values({
      id: attemptID,
      project_id: projectID,
      work_item_id: sourceID,
      ordinal: 1,
      status: "completed",
      started_at: now,
      finished_at: now + 1,
    })
    .run()
  db.insert(CompanyProjectEventTable)
    .values({
      id: evidenceID,
      project_id: projectID,
      type: "recovery.evidence",
      data_json: "{}",
      created_at: now + 1,
    })
    .run()
  db.insert(CompanyWorkReceiptTable)
    .values({
      id: receiptID,
      project_id: projectID,
      work_item_id: sourceID,
      attempt_id: attemptID,
      idempotency_key: `receipt-${suffix}`,
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
      processing_status: "processed",
      created_at: now + 1,
      processed_at: now + 1,
    })
    .run()
  await output({ result: "pass", mode, boundary })
} else if (mode === "fault") {
  const exit = await Effect.runPromise(
    Effect.exit(
      CompanyGraphMutation.Service.use((service) => service.apply(proposal)).pipe(
        Effect.provide(
          CompanyGraphMutation.makeLayer({
            onBoundary: (current) => {
              if (current === boundary) throw new Error(`Injected ${boundary}`)
            },
            publish: async () => {},
          }),
        ),
      ),
    ),
  )
  await output({ result: "pass", mode, boundary, faulted: exit._tag === "Failure" })
} else if (mode === "replay") {
  const result = await Effect.runPromise(
    CompanyGraphMutation.Service.use((service) => service.apply(proposal)).pipe(
      Effect.provide(CompanyGraphMutation.makeLayer({ publish: async () => {} })),
    ),
  )
  await output({
    result: "pass",
    mode,
    boundary,
    status: result.status,
    replayed: result.status === "applied" && result.replayed,
  })
} else if (mode === "verify") {
  const db = Database.Client()
  const project = db
    .select({ graph_revision: CompanyProjectTable.graph_revision })
    .from(CompanyProjectTable)
    .where(eq(CompanyProjectTable.id, projectID))
    .get()!
  const mutations = db
    .select({ id: CompanyGraphMutationTable.id })
    .from(CompanyGraphMutationTable)
    .where(eq(CompanyGraphMutationTable.project_id, projectID))
    .all()
  const added = db
    .select({ id: CompanyWorkItemTable.id })
    .from(CompanyWorkItemTable)
    .where(eq(CompanyWorkItemTable.id, itemID))
    .all()
  const dependencies = db
    .select()
    .from(CompanyWorkItemDependencyTable)
    .where(
      and(
        eq(CompanyWorkItemDependencyTable.work_item_id, itemID),
        eq(CompanyWorkItemDependencyTable.depends_on_id, sourceID),
      ),
    )
    .all()
  const appliedEvents = db
    .select({ id: CompanyProjectEventTable.id })
    .from(CompanyProjectEventTable)
    .where(
      and(
        eq(CompanyProjectEventTable.project_id, projectID),
        eq(CompanyProjectEventTable.type, "graph_mutation.applied"),
      ),
    )
    .all()
  const receipt = db
    .select({ processed_mutation_id: CompanyWorkReceiptTable.processed_mutation_id })
    .from(CompanyWorkReceiptTable)
    .where(eq(CompanyWorkReceiptTable.id, receiptID))
    .get()!
  await output({
    result: "pass",
    mode,
    boundary,
    graph_revision: project.graph_revision,
    mutations: mutations.length,
    added_items: added.length,
    dependencies: dependencies.length,
    applied_events: appliedEvents.length,
    receipt_bound: receipt.processed_mutation_id !== null,
  })
} else {
  throw new Error("Expected prepare, fault, replay, or verify")
}
