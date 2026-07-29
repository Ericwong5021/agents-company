import path from "node:path"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { CompanyAgent } from "../../src/company-agent"
import { CompanyAgentTable } from "../../src/company-agent/company-agent.sql"
import {
  CompanyPlanTable,
  CompanyProjectTable,
  CompanyWorkItemTable,
} from "../../src/company-project/company-project.sql"
import { CompanyRecruitment } from "../../src/company-recruitment"
import { CompanyEmploymentReviewTable } from "../../src/company-recruitment/company-recruitment.sql"
import { CompanyTable } from "../../src/company/company.sql"
import type { CompanyID } from "../../src/company/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Database } from "../../src/storage"

export function runRecruitment<A>(fn: (service: CompanyRecruitment.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(
    CompanyRecruitment.Service.use(fn).pipe(Effect.provide(CompanyRecruitment.defaultLayer)),
  )
}

export function runAgents<A>(fn: (service: CompanyAgent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(CompanyAgent.Service.use(fn).pipe(Effect.provide(CompanyAgent.defaultLayer)))
}

export function seedB0Project(input: {
  companyID?: CompanyID
  projectID: string
  workItemID: string
  role?: string
  capabilityPacks?: string[]
}) {
  const now = Date.now()
  Database.transaction((db) => {
    if (input.companyID)
      db
        .insert(CompanyTable)
        .values({
          id: input.companyID,
          name: "B0 Test Company",
          data_version: 1,
          default_provider_id: ProviderID.make("test"),
          default_model_id: ModelID.make("test-model"),
          bootstrap_request_id: crypto.randomUUID(),
          bootstrap_input_path: "/tmp/b0-test",
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .run()
    db.insert(CompanyProjectTable)
      .values({
        id: input.projectID,
        company_id: input.companyID ?? null,
        goal: `B0 goal ${input.projectID}`,
        title: input.projectID,
        status: "planning",
        output_dir: `/tmp/${input.projectID}`,
        created_at: now,
        updated_at: now,
      })
      .run()
    db.insert(CompanyPlanTable)
      .values({
        id: `${input.projectID}-plan`,
        project_id: input.projectID,
        version: 1,
        phase: "execution",
        status: "active",
        summary: "B0 assignment plan",
        assumptions_json: "[]",
        acceptance_criteria_json: "[]",
        change_reason: null,
        created_at: now,
      })
      .run()
    db.insert(CompanyWorkItemTable)
      .values({
        id: input.workItemID,
        project_id: input.projectID,
        plan_id: `${input.projectID}-plan`,
        source_task_key: "b0-work",
        parent_id: null,
        title: "B0 work item",
        description: "Verify the B0 assignment lifecycle",
        kind: "worker",
        work_type: "analysis",
        role: input.role ?? "evidence analyst",
        capability_packs_json: JSON.stringify(input.capabilityPacks ?? ["research-analysis@1"]),
        decision_scope_json: JSON.stringify(["analysis"]),
        resource_scope_json: JSON.stringify([`artifacts/${input.workItemID}`]),
        inputs_json: "[]",
        expected_outputs_json: "[]",
        validators_json: "[]",
        disposition: "retain",
        model_group: "standard",
        risk_level: "medium",
        review_status: "pending",
        status: "pending",
        purpose: "delivery",
        origin_kind: "legacy",
        origin_ref_id: null,
        graph_revision_created: 0,
        validation_mode: "independent_review",
        superseded_by_id: null,
        owner_agent_id: null,
        workflow_run_id: null,
        acceptance_criteria_json: "[]",
        attempt: 0,
        max_attempts: 3,
        error: null,
        started_at: null,
        completed_at: null,
        created_at: now,
        updated_at: now,
      })
      .run()
  })
}

export function identitySnapshot(agentID: string) {
  return Database.use((db) => {
    const agent = db.select().from(CompanyAgentTable).where(eq(CompanyAgentTable.id, agentID)).get()
    if (!agent) throw new Error(`Company agent not found: ${agentID}`)
    return {
      role_key: agent.role_key,
      lifecycle: agent.lifecycle,
      department: agent.department,
      reports_to: agent.reports_to,
      responsibilities: agent.responsibilities,
      employment_reviews: db
        .select()
        .from(CompanyEmploymentReviewTable)
        .all()
        .filter((review) => review.agent_id === agentID).length,
    }
  })
}

export async function writeB0Artifact(name: string, value: Record<string, unknown>) {
  const target = path.join(process.cwd(), ".artifacts", "seed-grow-b0", `${name}.json`)
  await Bun.write(target, `${JSON.stringify(value, null, 2)}\n`)
}
