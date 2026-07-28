import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { CompanyWorkFacts } from "../../src/company-project"
import { CompanyProjectEventTable } from "../../src/company-project/company-project.sql"
import { Database } from "../../src/storage"

const mode = Bun.argv[2]

async function output(value: Record<string, unknown>) {
  await Bun.write(Bun.stdout, `${JSON.stringify(value)}\n`)
  process.exit(0)
}

if (mode === "prepare") {
  const now = 1_800_000_000_000
  const db = Database.Client()
  db.run(
    `INSERT INTO company_project (
      id, goal, title, status, output_dir, created_at, updated_at
    ) VALUES (
      'project-recovery', 'Recover receipt', 'Recover receipt', 'executing', '/tmp', ${now}, ${now}
    )`,
  )
  db.run(
    `INSERT INTO company_plan (
      id, project_id, version, phase, status, summary, assumptions_json,
      acceptance_criteria_json, created_at
    ) VALUES (
      'plan-recovery', 'project-recovery', 1, 'execution', 'active', 'Recover',
      '[]', '["Recovered"]', ${now}
    )`,
  )
  db.run(
    `INSERT INTO company_work_item (
      id, project_id, plan_id, title, description, kind, work_type, role,
      capability_packs_json, decision_scope_json, resource_scope_json, inputs_json,
      expected_outputs_json, validators_json, disposition, model_group, risk_level,
      review_status, status, acceptance_criteria_json, attempt, max_attempts,
      started_at, created_at, updated_at
    ) VALUES (
      'item-recovery', 'project-recovery', 'plan-recovery', 'Recover', 'Recover',
      'worker', 'analysis', 'analyst', '[]', '[]', '[]', '[]', '[]', '[]',
      'retain', 'standard', 'medium', 'not_required', 'running', '["Recovered"]',
      1, 3, ${now}, ${now}, ${now}
    )`,
  )
  db.run(
    `INSERT INTO company_work_attempt (
      id, project_id, work_item_id, ordinal, status, started_at, finished_at
    ) VALUES (
      'attempt-recovery', 'project-recovery', 'item-recovery', 1, 'completed', ${now}, ${now + 1}
    )`,
  )
  db.run(
    `INSERT INTO company_work_receipt (
      id, project_id, work_item_id, attempt_id, idempotency_key, outcome, summary,
      artifact_ids_json, evidence_refs_json, confirmed_facts_json,
      invalidated_assumptions_json, unknowns_json, blockers_json, capability_gaps_json,
      task_proposals_json, dependency_proposals_json, questions_json, processing_status,
      created_at
    ) VALUES (
      'receipt-recovery', 'project-recovery', 'item-recovery', 'attempt-recovery',
      'recovery-key', 'completed', 'Recovered', '[]', '[]',
      '["work_item:item-recovery:completed"]', '[]', '[]', '[]', '[]', '[]', '[]',
      '[]', 'pending', ${now + 1}
    )`,
  )
  Database.close()
  await output({ result: "pass", mode })
} else if (mode === "recover") {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const facts = yield* CompanyWorkFacts.Service
      const explicit = yield* facts.recover()
      const receipts = yield* facts.listReceipts("project-recovery")
      const processedEvents = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyProjectEventTable)
            .where(eq(CompanyProjectEventTable.type, "work_receipt.processed"))
            .all(),
        ),
      )
      return {
        result: "pass",
        mode,
        receipts: receipts.map((receipt) => ({
          id: receipt.id,
          processing_status: receipt.processing_status,
        })),
        processed_events: processedEvents.length,
        explicit_recovery_count: explicit.processed_receipt_ids.length,
      }
    }).pipe(Effect.provide(CompanyWorkFacts.defaultLayer)),
  )
  Database.close()
  await output(result)
} else {
  throw new Error("Expected prepare or recover")
}
