import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { and, count, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { AgentRun } from "../../src/agent-run/agent-run"
import { AgentRunTable } from "../../src/agent-run/agent-run.sql"
import { AgentRunSupervisor } from "../../src/agent-run/supervisor"
import { CompanyAgentTable } from "../../src/company-agent/company-agent.sql"
import {
  CompanyCapabilityNeedTable,
  CompanyProjectAssignmentTable,
  CompanyTeamSelectionTable,
} from "../../src/company-recruitment/company-recruitment.sql"
import { CompanyAttention } from "../../src/company-project"
import {
  CompanyApprovalGateTable,
  CompanyAcceptanceCriterionTable,
  CompanyAcceptanceFactTable,
  CompanyArtifactTable,
  CompanyAttentionTable,
  CompanyPlanTable,
  CompanyProjectActionTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
  CompanyWorkReceiptAcceptanceFactTable,
} from "../../src/company-project/company-project.sql"
import { GoalBriefTable, GoalBriefVersionTable } from "../../src/goal-brief"
import { DispatchCoordinator } from "../../src/project-orchestrator/dispatch"
import { ProjectActionExecutor } from "../../src/project-orchestrator/project-action-executor"
import {
  DeliveryAcceptanceBinding,
  deliveryAcceptanceBindingDigest,
  deliveryAcceptanceSnapshotWithDatabase,
} from "../../src/project-orchestrator/quiescence"
import { Database } from "../../src/storage"
import { WorkflowRuntime } from "../../src/workflow/runtime"
import { resetDatabase } from "../fixture/db"

const calls = {
  pause: [] as string[],
  resume: [] as string[],
  dispatch: [] as string[],
  workflowCancel: [] as string[],
  agentStop: [] as string[],
}
const workflowFailure = {
  runID: "",
  remaining: 0,
}

const dispatchLayer = Layer.succeed(
  DispatchCoordinator.Service,
  DispatchCoordinator.Service.of({
    dispatchReady: (project_id) =>
      Effect.sync(() => {
        calls.dispatch.push(project_id)
        const project = Database.use((db) =>
          db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, project_id)).get(),
        )
        return {
          project_id,
          status: project?.dispatch_paused ? ("paused" as const) : ("idle" as const),
          barrier: project?.dispatch_paused ? ("paused" as const) : ("open" as const),
          eligible_work_item_ids: [],
          dispatched_work_item_ids: [],
        }
      }),
    pauseDispatch: (project_id) =>
      Effect.sync(() => {
        calls.pause.push(project_id)
        const project = Database.use((db) =>
          db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, project_id)).get(),
        )
        if (!project) throw new Error(`Company project not found: ${project_id}`)
        Database.use((db) =>
          db
            .update(CompanyProjectTable)
            .set({ dispatch_paused: true, orchestration_state: "paused" })
            .where(eq(CompanyProjectTable.id, project_id))
            .run(),
        )
        return {
          project_id,
          status: "paused" as const,
          barrier: "paused" as const,
          eligible_work_item_ids: [],
          dispatched_work_item_ids: [],
          barrier_changed: !project.dispatch_paused,
          idempotency_key: `dispatch-barrier:${project_id}:paused`,
          replayed: project.dispatch_paused,
        }
      }),
    resumeDispatch: (project_id) =>
      Effect.sync(() => {
        calls.resume.push(project_id)
        const project = Database.use((db) =>
          db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, project_id)).get(),
        )
        if (!project) throw new Error(`Company project not found: ${project_id}`)
        Database.use((db) =>
          db
            .update(CompanyProjectTable)
            .set({ dispatch_paused: false, orchestration_state: "idle" })
            .where(eq(CompanyProjectTable.id, project_id))
            .run(),
        )
        return {
          project_id,
          status: "idle" as const,
          barrier: "open" as const,
          eligible_work_item_ids: [],
          dispatched_work_item_ids: [],
          barrier_changed: project.dispatch_paused,
          idempotency_key: `dispatch-barrier:${project_id}:open`,
          replayed: !project.dispatch_paused,
        }
      }),
  }),
)

const workflowLayer = Layer.succeed(
  WorkflowRuntime.Service,
  WorkflowRuntime.Service.of({
    cancel: ({ runID }: { runID: string }) =>
      Effect.sync(() => {
        calls.workflowCancel.push(runID)
        if (workflowFailure.runID === runID && workflowFailure.remaining > 0) {
          workflowFailure.remaining -= 1
          throw new Error(`workflow cancel failed: ${runID}`)
        }
      }),
  } as unknown as WorkflowRuntime.Interface),
)

const agentSupervisorLayer = Layer.succeed(
  AgentRunSupervisor.Service,
  AgentRunSupervisor.Service.of({
    stop: (runID: string) =>
      Effect.sync(() => {
        calls.agentStop.push(runID)
        return true
      }),
  } as unknown as AgentRunSupervisor.Interface),
)

const dependencies = Layer.mergeAll(
  CompanyAttention.defaultLayer,
  dispatchLayer,
  workflowLayer,
  AgentRun.defaultLayer,
  agentSupervisorLayer,
)

function executorLayer(hooks: ProjectActionExecutor.Hooks = {}) {
  return Layer.mergeAll(dependencies, ProjectActionExecutor.makeLayer(hooks).pipe(Layer.provide(dependencies)))
}

function execute(input: Parameters<ProjectActionExecutor.Interface["execute"]>[0], layer = executorLayer()) {
  return Effect.runPromise(
    ProjectActionExecutor.Service.use((executor) => executor.execute(input)).pipe(Effect.provide(layer)),
  )
}

function recover(layer = executorLayer()) {
  return Effect.runPromise(
    ProjectActionExecutor.Service.use((executor) => executor.recover()).pipe(Effect.provide(layer)),
  )
}

function attention<T>(fn: (service: CompanyAttention.Interface) => Effect.Effect<T>) {
  return Effect.runPromise(CompanyAttention.Service.use(fn).pipe(Effect.provide(dependencies)))
}

function seedProject(
  id: string,
  input: {
    status?: string
    dispatch_paused?: boolean
    graph_revision?: number
  } = {},
) {
  const now = Date.now()
  Database.use((db) => {
    db.insert(CompanyProjectTable)
      .values({
        id,
        goal: `Goal ${id}`,
        title: `Project ${id}`,
        status: input.status ?? "executing",
        output_dir: `/tmp/${id}`,
        execution_strategy: "seed_and_grow",
        seed_mode: "direct_single",
        orchestration_state: input.dispatch_paused ? "paused" : "idle",
        dispatch_paused: input.dispatch_paused ?? false,
        graph_revision: input.graph_revision ?? 1,
        created_at: now,
        updated_at: now,
      })
      .run()
    db.insert(CompanyPlanTable)
      .values({
        id: `plan-${id}`,
        project_id: id,
        version: 1,
        phase: "execution",
        status: "active",
        summary: "Execute",
        assumptions_json: "[]",
        acceptance_criteria_json: JSON.stringify(["done"]),
        created_at: now,
      })
      .run()
  })
  return id
}

function seedWorkItem(
  project_id: string,
  id: string,
  input: {
    status: string
    attempt?: number
    max_attempts?: number
    workflow_run_id?: string
    validation_contract_version?: 1 | 2
  },
) {
  const now = Date.now()
  Database.use((db) =>
    db
      .insert(CompanyWorkItemTable)
      .values({
        id,
        project_id,
        plan_id: `plan-${project_id}`,
        title: id,
        description: id,
        kind: "worker",
        work_type: "analysis",
        role: "analyst",
        capability_packs_json: "[]",
        decision_scope_json: "[]",
        resource_scope_json: "[]",
        inputs_json: "[]",
        expected_outputs_json: "[]",
        validators_json: JSON.stringify(["done"]),
        disposition: "retain",
        model_group: "standard",
        risk_level: "medium",
        review_status: "not_required",
        status: input.status,
        purpose: "delivery",
        origin_kind: "seed",
        graph_revision_created: 1,
        validation_mode: "self_check",
        workflow_run_id: input.workflow_run_id ?? null,
        validation_contract_version: input.validation_contract_version ?? 1,
        acceptance_criteria_json: JSON.stringify(["done"]),
        attempt: input.attempt ?? 0,
        max_attempts: input.max_attempts ?? 3,
        error: input.status === "blocked" || input.status === "failed" ? "retained failure" : null,
        started_at: input.attempt ? now - 10 : null,
        created_at: now - 20,
        updated_at: now,
      })
      .run(),
  )
  return id
}

function seedAttempt(project_id: string, work_item_id: string, id: string, status: "running" | "failed") {
  Database.use((db) =>
    db
      .insert(CompanyWorkAttemptTable)
      .values({
        id,
        project_id,
        work_item_id,
        ordinal: 1,
        status,
        failure_kind: status === "failed" ? "implementation" : null,
        safe_summary: status === "failed" ? "retained failure" : null,
        started_at: Date.now() - 10,
        finished_at: status === "failed" ? Date.now() : null,
      })
      .run(),
  )
}

function seedReceipt(project_id: string, work_item_id: string, attempt_id: string, id: string) {
  Database.use((db) =>
    db
      .insert(CompanyWorkReceiptTable)
      .values({
        id,
        project_id,
        work_item_id,
        attempt_id,
        idempotency_key: `${id}-key`,
        outcome: "blocked",
        summary: "Retained failure receipt",
        artifact_ids_json: "[]",
        evidence_refs_json: "[]",
        confirmed_facts_json: "[]",
        invalidated_assumptions_json: "[]",
        unknowns_json: "[]",
        blockers_json: JSON.stringify(["retained failure"]),
        capability_gaps_json: "[]",
        task_proposals_json: "[]",
        dependency_proposals_json: "[]",
        questions_json: "[]",
        processing_status: "processed",
        created_at: Date.now(),
        processed_at: Date.now(),
      })
      .run(),
  )
}

function seedBoundDelivery(id: string) {
  const project_id = seedProject(id, { status: "completed" })
  const work_item_id = seedWorkItem(project_id, `work-${id}`, {
    status: "completed",
    attempt: 1,
    validation_contract_version: 2,
  })
  const criterion_ids = [`criterion-${id}-a`, `criterion-${id}-b`].sort()
  const brief_id = `brief-${id}`
  const attempt_id = `attempt-${id}`
  const artifact_id = `artifact-${id}`
  const receipt_id = `receipt-${id}`
  const package_id = `package-${id}`
  const agent_id = `agent-${id}`
  const need_id = `need-${id}`
  const selection_id = `selection-${id}`
  const assignment_id = `assignment-${id}`
  const artifactPath = `/tmp/${artifact_id}.txt`
  const content = JSON.stringify({ delivery: id })
  const content_sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex")
  writeFileSync(artifactPath, `materialized:${id}`)
  const materialized_sha256 = new Bun.CryptoHasher("sha256")
    .update(readFileSync(artifactPath))
    .digest("hex")
  const integrity_sha256 = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ content_sha256, materialized_sha256 }))
    .digest("hex")
  const packageContent = JSON.stringify({ delivery_package: id })
  const packageContentSha256 = new Bun.CryptoHasher("sha256").update(packageContent).digest("hex")
  const packageIntegritySha256 = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ content_sha256: packageContentSha256 }))
    .digest("hex")
  const now = Date.now()
  Database.use((db) => {
    db.update(CompanyProjectTable)
      .set({ active_plan_version: 1 })
      .where(eq(CompanyProjectTable.id, project_id))
      .run()
    db.insert(CompanyAgentTable)
      .values({
        id: agent_id,
        lifecycle: "assigned",
        name: `Agent ${id}`,
        time_created: now,
        time_updated: now,
      })
      .run()
    db.insert(CompanyCapabilityNeedTable)
      .values({
        id: need_id,
        project_id,
        work_item_id,
        need_key: need_id,
        role: "analyst",
        work_type: "analysis",
        capability_packs_json: "[]",
        risk_level: "medium",
        demand_horizon: "project",
        time_created: now,
        time_updated: now,
      })
      .run()
    db.insert(CompanyTeamSelectionTable)
      .values({
        id: selection_id,
        project_id,
        capability_need_id: need_id,
        agent_id,
        decision: "selected",
        source: "company_pool",
        lifecycle_at_selection: "assigned",
        reason: `Delivery ${id}`,
        score_json: "{}",
        time_created: now,
        time_updated: now,
      })
      .run()
    db.insert(CompanyProjectAssignmentTable)
      .values({
        id: assignment_id,
        project_id,
        work_item_id,
        capability_need_id: need_id,
        selection_id,
        agent_id,
        version: 1,
        idempotency_key: assignment_id,
        temporary_role: "analyst",
        responsibility: `Deliver ${id}`,
        decision_scope_json: "[]",
        resource_scope_json: "[]",
        permission_mode: "read_only",
        status: "released",
        assigned_at: now,
        started_at: now,
        released_at: now,
        release_reason: "quiescence",
      })
      .run()
    db.insert(GoalBriefTable)
      .values({ id: brief_id, project_id, created_at: now, updated_at: now })
      .run()
    db.insert(GoalBriefVersionTable)
      .values({
        brief_id,
        version: 1,
        goal: `Goal ${id}`,
        deliverables_json: "[]",
        acceptance_criteria_json: JSON.stringify(
          criterion_ids.map((criterion_id, index) => ({
            id: criterion_id,
            description: `Criterion ${index + 1}`,
            verification: `Verify criterion ${index + 1}`,
          })),
        ),
        constraints_json: "[]",
        non_goals_json: "[]",
        assumptions_json: "[]",
        open_questions_json: "[]",
        risk_level: "low",
        recommended_plan_json: "{}",
        approval_mode: "balanced",
        source: "user_input",
        source_refs_json: "[]",
        created_at: now,
      })
      .run()
    db.insert(CompanyWorkAttemptTable)
      .values({
        id: attempt_id,
        project_id,
        work_item_id,
        ordinal: 1,
        status: "completed",
        started_at: now - 20,
        finished_at: now - 10,
      })
      .run()
    db.insert(CompanyArtifactTable)
      .values({
        id: artifact_id,
        project_id,
        company_id: null,
        scope_type: "project",
        private_owner_id: null,
        work_item_id,
        attempt_id,
        version: 1,
        supersedes_artifact_id: null,
        content_sha256,
        materialized_sha256,
        integrity_sha256,
        kind: "analysis",
        title: `Artifact ${id}`,
        path: artifactPath,
        content,
        evidence_json: "{}",
        created_at: now - 9,
      })
      .run()
    db.insert(CompanyWorkReceiptTable)
      .values({
        id: receipt_id,
        project_id,
        work_item_id,
        attempt_id,
        idempotency_key: `receipt-${id}-key`,
        outcome: "completed",
        summary: `Completed ${id}`,
        artifact_ids_json: JSON.stringify([artifact_id]),
        evidence_refs_json: JSON.stringify([{ kind: "artifact", id: artifact_id }]),
        confirmed_facts_json: JSON.stringify(criterion_ids),
        invalidated_assumptions_json: "[]",
        unknowns_json: "[]",
        blockers_json: "[]",
        capability_gaps_json: "[]",
        task_proposals_json: "[]",
        dependency_proposals_json: "[]",
        questions_json: "[]",
        processing_status: "processed",
        created_at: now - 8,
        processed_at: now - 7,
      })
      .run()
    criterion_ids.forEach((criterion_id, index) => {
      db.insert(CompanyAcceptanceCriterionTable)
        .values({
          id: criterion_id,
          project_id,
          plan_id: `plan-${project_id}`,
          work_item_id,
          ordinal: index + 1,
          statement: `Criterion ${index + 1}`,
          statement_sha256: new Bun.CryptoHasher("sha256").update(`Criterion ${index + 1}`).digest("hex"),
          verification_kind: "deterministic",
          required_authority: "control_plane",
          evaluator: "artifact_digest_v1",
          required: true,
          created_at: now - 6 + index,
        })
        .run()
      const fact_id = `fact-${id}-${index + 1}`
      db.insert(CompanyAcceptanceFactTable)
        .values({
          id: fact_id,
          project_id,
          work_item_id,
          attempt_id,
          artifact_id,
          artifact_integrity_sha256: integrity_sha256,
          criterion_id,
          gate_id: null,
          verdict: "passed",
          authority: "control_plane",
          evaluator: "artifact_digest_v1",
          observation_json: "{}",
          evidence_refs_json: JSON.stringify([{ kind: "artifact", id: artifact_id }]),
          evidence_sha256: new Bun.CryptoHasher("sha256").update(`evidence:${fact_id}`).digest("hex"),
          input_sha256: new Bun.CryptoHasher("sha256").update(`input:${fact_id}`).digest("hex"),
          idempotency_key: `fact-${id}-${index + 1}-key`,
          supersedes_fact_id: null,
          created_at: now - 4 + index,
        })
        .run()
      db.insert(CompanyWorkReceiptAcceptanceFactTable)
        .values({ receipt_id, fact_id, created_at: now - 2 + index })
        .run()
    })
    db.insert(CompanyArtifactTable)
      .values({
        id: package_id,
        project_id,
        company_id: null,
        scope_type: "project",
        private_owner_id: null,
        work_item_id: null,
        attempt_id: null,
        version: 1,
        supersedes_artifact_id: null,
        content_sha256: packageContentSha256,
        materialized_sha256: null,
        integrity_sha256: packageIntegritySha256,
        kind: "delivery_package",
        title: `Package ${id}`,
        path: null,
        content: packageContent,
        evidence_json: "{}",
        created_at: now - 1,
      })
      .run()
    const binding = deliveryAcceptanceSnapshotWithDatabase(db, {
      project_id,
      delivery_package_artifact_id: package_id,
      version: 1,
    })
    db.insert(CompanyProjectEventTable)
      .values({
        id: `event-${id}-ready`,
        project_id,
        type: "delivery.ready",
        actor_id: null,
        data_json: JSON.stringify({
          delivery_id: `delivery:${package_id}`,
          ...binding,
          sha256: deliveryAcceptanceBindingDigest(binding),
        }),
        created_at: now,
      })
      .run()
  })
  return {
    project_id,
    criterion_ids,
    brief_id,
    package_id,
    artifact_id,
    artifactPath,
    receipt_id,
    work_item_id,
    assignment_id,
    selection_id,
    fact_ids: criterion_ids.map((_, index) => `fact-${id}-${index + 1}`),
  }
}

beforeEach(async () => {
  await resetDatabase()
  Object.values(calls).forEach((entries) => entries.splice(0))
  workflowFailure.runID = ""
  workflowFailure.remaining = 0
})

afterEach(resetDatabase)

describe.serial("ProjectActionExecutor", () => {
  test.serial("accepts only the unique criterion set bound to the current delivery snapshot", async () => {
    const exact = seedBoundDelivery("delivery-exact")
    const accepted = await execute({
      project_id: exact.project_id,
      action: "accept_delivery",
      idempotency_key: "accept-delivery-exact",
      expected_revision: 1,
      payload: {
        delivery_id: `delivery:${exact.package_id}`,
        accepted_criterion_ids: exact.criterion_ids.toReversed(),
      },
    })
    expect(accepted.action).toMatchObject({
      status: "applied",
      result: {
        delivery_id: `delivery:${exact.package_id}`,
        accepted_criterion_ids: exact.criterion_ids,
      },
    })
    expect(
      Database.use((db) =>
        db
          .select()
          .from(CompanyProjectEventTable)
          .where(
            and(
              eq(CompanyProjectEventTable.project_id, exact.project_id),
              eq(CompanyProjectEventTable.type, "delivery.accepted"),
            ),
          )
          .get(),
      ),
    ).toBeDefined()

    const duplicate = seedBoundDelivery("delivery-duplicate")
    expect(
      (
        await execute({
          project_id: duplicate.project_id,
          action: "accept_delivery",
          idempotency_key: "accept-delivery-duplicate",
          expected_revision: 1,
          payload: {
            delivery_id: `delivery:${duplicate.package_id}`,
            accepted_criterion_ids: [duplicate.criterion_ids[0]!, duplicate.criterion_ids[0]!],
          },
        })
      ).action,
    ).toMatchObject({ status: "rejected", error: "delivery_acceptance_ids_not_unique" })

    const mismatch = seedBoundDelivery("delivery-mismatch")
    expect(
      (
        await execute({
          project_id: mismatch.project_id,
          action: "accept_delivery",
          idempotency_key: "accept-delivery-mismatch",
          expected_revision: 1,
          payload: {
            delivery_id: `delivery:${mismatch.package_id}`,
            accepted_criterion_ids: [mismatch.criterion_ids[0]!],
          },
        })
      ).action,
    ).toMatchObject({ status: "rejected", error: "delivery_acceptance_criteria_mismatch" })

    const tampered = seedBoundDelivery("delivery-tampered")
    Database.use((db) => {
      const ready = db
        .select()
        .from(CompanyProjectEventTable)
        .where(eq(CompanyProjectEventTable.id, "event-delivery-tampered-ready"))
        .get()!
      db.update(CompanyProjectEventTable)
        .set({ data_json: JSON.stringify({ ...JSON.parse(ready.data_json), sha256: "0".repeat(64) }) })
        .where(eq(CompanyProjectEventTable.id, ready.id))
        .run()
    })
    expect(
      (
        await execute({
          project_id: tampered.project_id,
          action: "accept_delivery",
          idempotency_key: "accept-delivery-tampered",
          expected_revision: 1,
          payload: {
            delivery_id: `delivery:${tampered.package_id}`,
            accepted_criterion_ids: tampered.criterion_ids,
          },
        })
      ).action,
    ).toMatchObject({ status: "rejected", error: "delivery_acceptance_snapshot_invalid" })
  })

  test.serial("rejects delivery acceptance after the active Plan or Goal Brief drifts", async () => {
    const planDrift = seedBoundDelivery("delivery-plan-drift")
    Database.use((db) => {
      db.update(CompanyPlanTable)
        .set({ status: "superseded" })
        .where(eq(CompanyPlanTable.id, `plan-${planDrift.project_id}`))
        .run()
      db.insert(CompanyPlanTable)
        .values({
          id: `plan-${planDrift.project_id}-v2`,
          project_id: planDrift.project_id,
          version: 2,
          phase: "execution",
          status: "active",
          summary: "Changed Plan",
          assumptions_json: "[]",
          acceptance_criteria_json: JSON.stringify(["changed"]),
          created_at: Date.now(),
        })
        .run()
      db.update(CompanyProjectTable)
        .set({ active_plan_version: 2 })
        .where(eq(CompanyProjectTable.id, planDrift.project_id))
        .run()
    })
    expect(
      (
        await execute({
          project_id: planDrift.project_id,
          action: "accept_delivery",
          idempotency_key: "accept-delivery-plan-drift",
          expected_revision: 1,
          payload: {
            delivery_id: `delivery:${planDrift.package_id}`,
            accepted_criterion_ids: planDrift.criterion_ids,
          },
        })
      ).action,
    ).toMatchObject({ status: "rejected", error: "stale_delivery" })

    const briefDrift = seedBoundDelivery("delivery-brief-drift")
    Database.use((db) => {
      const previous = db
        .select()
        .from(GoalBriefVersionTable)
        .where(eq(GoalBriefVersionTable.brief_id, briefDrift.brief_id))
        .get()!
      db.insert(GoalBriefVersionTable)
        .values({ ...previous, version: 2, created_at: Date.now() })
        .run()
    })
    expect(
      (
        await execute({
          project_id: briefDrift.project_id,
          action: "accept_delivery",
          idempotency_key: "accept-delivery-brief-drift",
          expected_revision: 1,
          payload: {
            delivery_id: `delivery:${briefDrift.package_id}`,
            accepted_criterion_ids: briefDrift.criterion_ids,
          },
        })
      ).action,
    ).toMatchObject({ status: "rejected", error: "stale_delivery" })

    const criterionDrift = seedBoundDelivery("delivery-criterion-drift")
    Database.use((db) =>
      db
        .update(CompanyAcceptanceCriterionTable)
        .set({
          statement: "Changed criterion",
          statement_sha256: new Bun.CryptoHasher("sha256").update("Changed criterion").digest("hex"),
        })
        .where(eq(CompanyAcceptanceCriterionTable.id, criterionDrift.criterion_ids[0]!))
        .run(),
    )
    expect(
      (
        await execute({
          project_id: criterionDrift.project_id,
          action: "accept_delivery",
          idempotency_key: "accept-delivery-criterion-drift",
          expected_revision: 1,
          payload: {
            delivery_id: `delivery:${criterionDrift.package_id}`,
            accepted_criterion_ids: criterionDrift.criterion_ids,
          },
        })
      ).action,
    ).toMatchObject({ status: "rejected", error: "stale_delivery" })
  })

  test.serial("reopens the delivery work on request_change and records a redelivery boundary", async () => {
    const delivery = seedBoundDelivery("delivery-request-change")
    const changed = await execute({
      project_id: delivery.project_id,
      action: "request_change",
      idempotency_key: "request-delivery-change",
      expected_revision: 1,
      payload: {
        delivery_id: `delivery:${delivery.package_id}`,
        reason: "Please revise the delivery",
      },
    })
    expect(changed.action).toMatchObject({
      status: "applied",
      result: {
        delivery_id: `delivery:${delivery.package_id}`,
        rework_work_item_ids: [delivery.work_item_id],
      },
    })
    expect(
      Database.use((db) =>
        db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, delivery.work_item_id)).get(),
      ),
    ).toMatchObject({ status: "pending", completed_at: null })
    expect(
      Database.use((db) =>
        db
          .select()
          .from(CompanyProjectAssignmentTable)
          .where(eq(CompanyProjectAssignmentTable.id, delivery.assignment_id))
          .get(),
      ),
    ).toMatchObject({ status: "assigned", released_at: null, release_reason: null })
    expect(
      Database.use((db) =>
        db.select().from(CompanyTeamSelectionTable).where(eq(CompanyTeamSelectionTable.id, delivery.selection_id)).get(),
      )?.time_released,
    ).toBeNull()
    expect(
      Database.use((db) =>
        db
          .select()
          .from(CompanyProjectEventTable)
          .where(
            and(
              eq(CompanyProjectEventTable.project_id, delivery.project_id),
              eq(CompanyProjectEventTable.type, "delivery.revision_requested"),
            ),
          )
          .get(),
      ),
    ).toBeDefined()
  })

  test.serial("rejects delivery acceptance after Artifact, Fact, Receipt, or graph drift", async () => {
    const artifactDrift = seedBoundDelivery("delivery-artifact-drift")
    writeFileSync(artifactDrift.artifactPath, "tampered")
    expect(
      (
        await execute({
          project_id: artifactDrift.project_id,
          action: "accept_delivery",
          idempotency_key: "accept-delivery-artifact-drift",
          expected_revision: 1,
          payload: {
            delivery_id: `delivery:${artifactDrift.package_id}`,
            accepted_criterion_ids: artifactDrift.criterion_ids,
          },
        })
      ).action,
    ).toMatchObject({ status: "rejected", error: "stale_delivery" })

    const factDrift = seedBoundDelivery("delivery-fact-drift")
    Database.use((db) =>
      db
        .update(CompanyAcceptanceFactTable)
        .set({ observation_json: JSON.stringify({ changed: true }) })
        .where(eq(CompanyAcceptanceFactTable.id, factDrift.fact_ids[0]!))
        .run(),
    )
    expect(
      (
        await execute({
          project_id: factDrift.project_id,
          action: "accept_delivery",
          idempotency_key: "accept-delivery-fact-drift",
          expected_revision: 1,
          payload: {
            delivery_id: `delivery:${factDrift.package_id}`,
            accepted_criterion_ids: factDrift.criterion_ids,
          },
        })
      ).action,
    ).toMatchObject({ status: "rejected", error: "stale_delivery" })

    const receiptDrift = seedBoundDelivery("delivery-receipt-drift")
    Database.use((db) =>
      db
        .update(CompanyWorkReceiptTable)
        .set({ summary: "changed" })
        .where(eq(CompanyWorkReceiptTable.id, receiptDrift.receipt_id))
        .run(),
    )
    expect(
      (
        await execute({
          project_id: receiptDrift.project_id,
          action: "accept_delivery",
          idempotency_key: "accept-delivery-receipt-drift",
          expected_revision: 1,
          payload: {
            delivery_id: `delivery:${receiptDrift.package_id}`,
            accepted_criterion_ids: receiptDrift.criterion_ids,
          },
        })
      ).action,
    ).toMatchObject({ status: "rejected", error: "stale_delivery" })

    const graphDrift = seedBoundDelivery("delivery-graph-drift")
    Database.use((db) =>
      db
        .update(CompanyProjectTable)
        .set({ graph_revision: 2 })
        .where(eq(CompanyProjectTable.id, graphDrift.project_id))
        .run(),
    )
    expect(
      (
        await execute({
          project_id: graphDrift.project_id,
          action: "accept_delivery",
          idempotency_key: "accept-delivery-graph-drift",
          expected_revision: 2,
          payload: {
            delivery_id: `delivery:${graphDrift.package_id}`,
            accepted_criterion_ids: graphDrift.criterion_ids,
          },
        })
      ).action,
    ).toMatchObject({ status: "rejected", error: "stale_delivery" })
  })

  test.serial("rejects legacy delivery.ready events as unverified", async () => {
    const project_id = seedProject("delivery-legacy", { status: "completed" })
    Database.use((db) =>
      db
        .insert(CompanyProjectEventTable)
        .values({
          id: "event-delivery-legacy-ready",
          project_id,
          type: "delivery.ready",
          actor_id: null,
          data_json: JSON.stringify({
            delivery_id: `delivery:${project_id}`,
            version: 1,
            artifact_ids: [],
          }),
          created_at: Date.now(),
        })
        .run(),
    )
    expect(
      (
        await execute({
          project_id,
          action: "accept_delivery",
          idempotency_key: "accept-delivery-legacy",
          expected_revision: 1,
          payload: {
            delivery_id: `delivery:${project_id}`,
            accepted_criterion_ids: ["legacy-criterion"],
          },
        })
      ).action,
    ).toMatchObject({ status: "rejected", error: "delivery_legacy_unverified" })

    const empty = seedBoundDelivery("delivery-empty-criteria")
    Database.use((db) => {
      const ready = db
        .select()
        .from(CompanyProjectEventTable)
        .where(eq(CompanyProjectEventTable.id, "event-delivery-empty-criteria-ready"))
        .get()!
      const readyData = JSON.parse(ready.data_json) as Record<string, unknown>
      const binding = DeliveryAcceptanceBinding.parse(
        Object.fromEntries(Object.entries(readyData).filter(([key]) => key !== "delivery_id" && key !== "sha256")),
      )
      const emptyBinding = DeliveryAcceptanceBinding.parse({ ...binding, criterion_ids: [] })
      db.update(CompanyProjectEventTable)
        .set({
          data_json: JSON.stringify({
            delivery_id: `delivery:${empty.package_id}`,
            ...emptyBinding,
            sha256: deliveryAcceptanceBindingDigest(emptyBinding),
          }),
        })
        .where(eq(CompanyProjectEventTable.id, ready.id))
        .run()
    })
    expect(
      (
        await execute({
          project_id: empty.project_id,
          action: "accept_delivery",
          idempotency_key: "accept-delivery-empty-criteria",
          expected_revision: 1,
          payload: {
            delivery_id: `delivery:${empty.package_id}`,
            accepted_criterion_ids: ["invented-criterion"],
          },
        })
      ).action,
    ).toMatchObject({ status: "rejected", error: "delivery_legacy_unverified" })
  })

  test.serial("executes pause, resume, and resolve_blocker through durable intents", async () => {
    const project_id = seedProject("action-controls")
    const work_item_id = seedWorkItem(project_id, "work-action-controls", { status: "pending" })
    expect(
      await execute({
        project_id,
        action: "pause_work",
        idempotency_key: "pause-1",
        expected_revision: 1,
        payload: { reason: "inspect" },
      }),
    ).toMatchObject({ action: { status: "applied" }, replayed: false })
    expect(
      Database.use((db) => db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, project_id)).get())
        ?.dispatch_paused,
    ).toBe(true)
    expect(
      await execute({
        project_id,
        action: "resume_work",
        idempotency_key: "resume-1",
        expected_revision: 1,
        payload: { reason: "continue" },
      }),
    ).toMatchObject({ action: { status: "applied" } })

    const opened = await attention((service) =>
      service.create({
        project_id,
        idempotency_key: "material-attention",
        issue: {
          issue_kind: "permission_required",
          risk: "high",
          materiality: "permission",
        },
        title: "Permission",
        summary: "Permission is required",
        source_refs: [{ kind: "project", id: project_id }],
      }),
    )
    Database.use((db) =>
      db
        .insert(CompanyApprovalGateTable)
        .values({
          id: "gate-action-controls",
          project_id,
          kind: "risk_approval",
          status: "pending",
          title: "Permission",
          summary: "Approve",
          work_item_id,
          resource_scope_json: "[]",
          requested_at: Date.now(),
        })
        .run(),
    )
    const resolved = await execute({
      project_id,
      attention_id: opened.record.id,
      action: "resolve_blocker",
      idempotency_key: "resolve-1",
      expected_revision: 1,
      payload: {
        resolution: "Approved",
        approval_gate_id: "gate-action-controls",
        decision: "approve",
      },
    })
    expect(resolved).toMatchObject({
      action: {
        status: "applied",
        result: {
          attention_id: opened.record.id,
          approval_gate_id: "gate-action-controls",
          dispatch_resumed: true,
        },
      },
    })
    expect(
      Database.use((db) =>
        db.select().from(CompanyAttentionTable).where(eq(CompanyAttentionTable.id, opened.record.id)).get(),
      )?.status,
    ).toBe("resolved")
    expect(
      Database.use((db) =>
        db.select().from(CompanyApprovalGateTable).where(eq(CompanyApprovalGateTable.id, "gate-action-controls")).get(),
      )?.status,
    ).toBe("approved")
    expect(calls.pause).toEqual([project_id])
    expect(calls.resume).toEqual([project_id])
    expect(calls.dispatch).toEqual([project_id])

    const changeAttention = await attention((service) =>
      service.create({
        project_id,
        idempotency_key: "change-attention",
        issue: {
          issue_kind: "permission_required",
          risk: "high",
          materiality: "permission",
        },
        title: "Permission change",
        summary: "More evidence is required",
        source_refs: [{ kind: "project", id: project_id }],
      }),
    )
    Database.use((db) =>
      db
        .insert(CompanyApprovalGateTable)
        .values({
          id: "gate-change-request",
          project_id,
          kind: "risk_approval",
          status: "pending",
          title: "Permission change",
          summary: "Review scope",
          work_item_id,
          resource_scope_json: "[]",
          requested_at: Date.now(),
        })
        .run(),
    )
    expect(
      await execute({
        project_id,
        attention_id: changeAttention.record.id,
        action: "resolve_blocker",
        idempotency_key: "request-gate-change",
        expected_revision: 1,
        payload: {
          resolution: "Narrow the resource scope",
          approval_gate_id: "gate-change-request",
          decision: "request_change",
        },
      }),
    ).toMatchObject({ action: { status: "applied" } })
    expect(
      Database.use((db) =>
        db.select().from(CompanyAttentionTable).where(eq(CompanyAttentionTable.id, changeAttention.record.id)).get(),
      ),
    ).toMatchObject({ status: "open" })
    expect(
      Database.use((db) =>
        db.select().from(CompanyApprovalGateTable).where(eq(CompanyApprovalGateTable.id, "gate-change-request")).get(),
      ),
    ).toMatchObject({ status: "pending", decision_note: "Narrow the resource scope" })
  })

  test.serial("fails closed on idempotency collisions and stale graph revisions", async () => {
    const project_id = seedProject("action-cas")
    const input = {
      project_id,
      action: "pause_work" as const,
      idempotency_key: "pause-cas",
      expected_revision: 1,
      payload: { reason: "same" },
    }
    expect((await execute(input)).replayed).toBe(false)
    expect((await execute(input)).replayed).toBe(true)
    expect(calls.pause).toEqual([project_id])
    await expect(execute({ ...input, payload: { reason: "different" } })).rejects.toThrow("different facts")
    const stale = await execute({
      project_id,
      action: "resume_work",
      idempotency_key: "resume-stale",
      expected_revision: 0,
      payload: {},
    })
    expect(stale.action).toMatchObject({
      status: "rejected",
      error: "project_revision_conflict",
    })
    expect(calls.resume).toEqual([])
  })

  test.serial("recovers request, claim, and effect boundaries without duplicate effects", async () => {
    const requestedProject = seedProject("action-request-crash")
    let requestCrash = true
    const requestLayer = executorLayer({
      onBoundary: (boundary) => {
        if (boundary !== "after_request" || !requestCrash) return
        requestCrash = false
        throw new Error("request boundary crash")
      },
    })
    await expect(
      execute(
        {
          project_id: requestedProject,
          action: "pause_work",
          idempotency_key: "request-crash",
          expected_revision: 1,
          payload: {},
        },
        requestLayer,
      ),
    ).rejects.toThrow("request boundary crash")
    expect(
      Database.use((db) =>
        db
          .select()
          .from(CompanyProjectActionTable)
          .where(eq(CompanyProjectActionTable.project_id, requestedProject))
          .get(),
      )?.status,
    ).toBe("requested")
    expect(await recover()).toMatchObject({
      applied_action_ids: [expect.any(String)],
      replayed: false,
    })

    const effectProject = seedProject("action-effect-crash")
    let effectCrash = true
    const effectLayer = executorLayer({
      onBoundary: (boundary) => {
        if (boundary !== "after_effect" || !effectCrash) return
        effectCrash = false
        throw new Error("effect boundary crash")
      },
    })
    await expect(
      execute(
        {
          project_id: effectProject,
          action: "pause_work",
          idempotency_key: "effect-crash",
          expected_revision: 1,
          payload: {},
        },
        effectLayer,
      ),
    ).rejects.toThrow("effect boundary crash")
    expect(
      Database.use((db) =>
        db
          .select()
          .from(CompanyProjectActionTable)
          .where(eq(CompanyProjectActionTable.project_id, effectProject))
          .get(),
      )?.status,
    ).toBe("claimed")
    const pauseCount = calls.pause.filter((id) => id === effectProject).length
    Database.use((db) =>
      db.update(CompanyProjectTable).set({ graph_revision: 2 }).where(eq(CompanyProjectTable.id, effectProject)).run(),
    )
    await recover()
    expect(calls.pause.filter((id) => id === effectProject)).toHaveLength(pauseCount)
    expect(
      Database.use((db) =>
        db
          .select()
          .from(CompanyProjectActionTable)
          .where(eq(CompanyProjectActionTable.project_id, effectProject))
          .get(),
      )?.status,
    ).toBe("applied")
  })

  test.serial("stops real runtimes and atomically retains historical evidence", async () => {
    const project_id = seedProject("action-stop")
    seedWorkItem(project_id, "item-running", {
      status: "running",
      attempt: 1,
      workflow_run_id: "workflow-running",
    })
    seedAttempt(project_id, "item-running", "attempt-running", "running")
    seedWorkItem(project_id, "item-failed", {
      status: "failed",
      attempt: 1,
    })
    seedAttempt(project_id, "item-failed", "attempt-failed", "failed")
    seedReceipt(project_id, "item-failed", "attempt-failed", "receipt-failed")
    Database.use((db) => {
      db.update(CompanyProjectTable)
        .set({ active_run_id: "workflow-running" })
        .where(eq(CompanyProjectTable.id, project_id))
        .run()
      db.insert(CompanyArtifactTable)
        .values({
          id: "artifact-failed",
          project_id,
          work_item_id: "item-failed",
          kind: "attempt_failure",
          title: "Retained failure",
          content: "{}",
          evidence_json: "{}",
          created_at: Date.now(),
        })
        .run()
      db.insert(AgentRunTable)
        .values({
          id: "agent-run-stop",
          agent_id: "agent-stop",
          runtime: "pi",
          lifecycle: "on_demand",
          permission_mode: "workspace_write",
          state: "running",
          company_project_id: project_id,
          work_item_id: "item-running",
          cwd: "/tmp",
          runtime_home_path: "/tmp/agent-run-stop",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
    })

    const stopInput = {
      project_id,
      action: "stop_work" as const,
      idempotency_key: "stop-1",
      expected_revision: 1,
      payload: { reason: "Owner stopped work" },
    }
    const stopped = await execute(stopInput)
    expect(stopped.action).toMatchObject({
      status: "applied",
      result: {
        cancelled_work_item_ids: ["item-failed", "item-running"],
        stopped_attempt_ids: ["attempt-running"],
        cancelled_workflow_run_ids: ["workflow-running"],
        stopped_agent_run_ids: ["agent-run-stop"],
      },
    })
    expect(calls.workflowCancel).toEqual(["workflow-running"])
    expect(calls.agentStop).toEqual(["agent-run-stop"])
    expect((await execute(stopInput)).replayed).toBe(true)
    expect(calls.workflowCancel).toEqual(["workflow-running"])
    expect(calls.agentStop).toEqual(["agent-run-stop"])
    expect(
      Database.use((db) =>
        db
          .select({ id: CompanyWorkItemTable.id, status: CompanyWorkItemTable.status })
          .from(CompanyWorkItemTable)
          .where(eq(CompanyWorkItemTable.project_id, project_id))
          .all(),
      ).sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual([
      { id: "item-failed", status: "cancelled" },
      { id: "item-running", status: "cancelled" },
    ])
    expect(
      Database.use((db) =>
        db
          .select({ id: CompanyWorkAttemptTable.id, status: CompanyWorkAttemptTable.status })
          .from(CompanyWorkAttemptTable)
          .where(eq(CompanyWorkAttemptTable.project_id, project_id))
          .all(),
      ).sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual([
      { id: "attempt-failed", status: "failed" },
      { id: "attempt-running", status: "stopped" },
    ])
    expect(
      Database.use((db) =>
        db
          .select({ value: count() })
          .from(CompanyWorkReceiptTable)
          .where(eq(CompanyWorkReceiptTable.project_id, project_id))
          .get(),
      )?.value,
    ).toBe(1)
    expect(
      Database.use((db) =>
        db
          .select({ value: count() })
          .from(CompanyArtifactTable)
          .where(eq(CompanyArtifactTable.project_id, project_id))
          .get(),
      )?.value,
    ).toBe(1)
    expect(
      Database.use((db) => db.select().from(AgentRunTable).where(eq(AgentRunTable.id, "agent-run-stop")).get())?.state,
    ).toBe("stopped")
    expect(
      Database.use((db) => db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, project_id)).get()),
    ).toMatchObject({
      status: "blocked",
      dispatch_paused: true,
      orchestration_state: "paused",
      active_run_id: null,
    })
    expect(
      Database.use((db) =>
        db
          .select({ value: count() })
          .from(CompanyProjectEventTable)
          .where(
            and(
              eq(CompanyProjectEventTable.project_id, project_id),
              eq(CompanyProjectEventTable.type, "work.cancelled"),
            ),
          )
          .get(),
      )?.value,
    ).toBe(1)
  })

  test.serial("recovers a partially applied stop without repeating completed external effects", async () => {
    const project_id = seedProject("action-stop-recovery")
    seedWorkItem(project_id, "item-workflow-a", {
      status: "running",
      attempt: 1,
      workflow_run_id: "workflow-a",
    })
    seedWorkItem(project_id, "item-workflow-b", {
      status: "running",
      attempt: 1,
      workflow_run_id: "workflow-b",
    })
    seedAttempt(project_id, "item-workflow-a", "attempt-workflow-a", "running")
    seedAttempt(project_id, "item-workflow-b", "attempt-workflow-b", "running")
    Database.use((db) =>
      db
        .update(CompanyProjectTable)
        .set({ active_run_id: "workflow-a" })
        .where(eq(CompanyProjectTable.id, project_id))
        .run(),
    )
    workflowFailure.runID = "workflow-b"
    workflowFailure.remaining = 1

    const input = {
      project_id,
      action: "stop_work" as const,
      idempotency_key: "stop-recovery",
      expected_revision: 1,
      payload: { reason: "Recover partial stop" },
    }
    const interrupted = await execute(input, executorLayer())
    expect(interrupted.action.status).toBe("claimed")
    expect(calls.pause).toEqual([project_id])
    expect(calls.workflowCancel).toEqual(["workflow-a", "workflow-b"])
    expect(
      Database.use((db) =>
        db
          .select({ id: CompanyWorkItemTable.id, status: CompanyWorkItemTable.status })
          .from(CompanyWorkItemTable)
          .where(eq(CompanyWorkItemTable.project_id, project_id))
          .all(),
      ).sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual([
      { id: "item-workflow-a", status: "running" },
      { id: "item-workflow-b", status: "running" },
    ])
    Database.use((db) =>
      db.update(CompanyProjectTable).set({ graph_revision: 2 }).where(eq(CompanyProjectTable.id, project_id)).run(),
    )

    expect(await recover(executorLayer())).toMatchObject({
      action_ids: [interrupted.action.id],
      applied_action_ids: [interrupted.action.id],
      rejected_action_ids: [],
      replayed: false,
    })
    expect(calls.pause).toEqual([project_id])
    expect(calls.workflowCancel).toEqual(["workflow-a", "workflow-b", "workflow-b"])
    expect(
      Database.use((db) =>
        db
          .select({ id: CompanyWorkItemTable.id, status: CompanyWorkItemTable.status })
          .from(CompanyWorkItemTable)
          .where(eq(CompanyWorkItemTable.project_id, project_id))
          .all(),
      ).sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual([
      { id: "item-workflow-a", status: "cancelled" },
      { id: "item-workflow-b", status: "cancelled" },
    ])
    expect(
      Database.use((db) =>
        db
          .select({ id: CompanyWorkAttemptTable.id, status: CompanyWorkAttemptTable.status })
          .from(CompanyWorkAttemptTable)
          .where(eq(CompanyWorkAttemptTable.project_id, project_id))
          .all(),
      ).sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual([
      { id: "attempt-workflow-a", status: "stopped" },
      { id: "attempt-workflow-b", status: "stopped" },
    ])
    expect(
      Database.use((db) => db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, project_id)).get()),
    ).toMatchObject({
      status: "blocked",
      active_run_id: null,
      dispatch_paused: true,
      orchestration_state: "paused",
    })
    expect(
      Database.use((db) =>
        db
          .select()
          .from(CompanyProjectActionTable)
          .where(eq(CompanyProjectActionTable.id, interrupted.action.id))
          .get(),
      ),
    ).toMatchObject({ status: "applied" })

    expect(await recover(executorLayer())).toMatchObject({
      action_ids: [],
      replayed: true,
    })
    expect(calls.pause).toEqual([project_id])
    expect(calls.workflowCancel).toEqual(["workflow-a", "workflow-b", "workflow-b"])
  })

  test.serial("retries only eligible nodes and keeps failed attempts and receipts immutable", async () => {
    const project_id = seedProject("action-retry", { status: "blocked" })
    seedWorkItem(project_id, "item-retry", {
      status: "failed",
      attempt: 1,
      max_attempts: 3,
    })
    seedAttempt(project_id, "item-retry", "attempt-retry", "failed")
    seedReceipt(project_id, "item-retry", "attempt-retry", "receipt-retry")
    const beforeAttempt = Database.use((db) =>
      db.select().from(CompanyWorkAttemptTable).where(eq(CompanyWorkAttemptTable.id, "attempt-retry")).get(),
    )
    const beforeReceipt = Database.use((db) =>
      db.select().from(CompanyWorkReceiptTable).where(eq(CompanyWorkReceiptTable.id, "receipt-retry")).get(),
    )
    const retried = await execute({
      project_id,
      action: "retry",
      idempotency_key: "retry-1",
      expected_revision: 1,
      payload: { work_item_ids: ["item-retry"], reason: "Try corrected implementation" },
    })
    expect(retried.action).toMatchObject({
      status: "applied",
      result: {
        retried_work_item_ids: ["item-retry"],
        retained_attempt_ids: ["attempt-retry"],
      },
    })
    expect(
      Database.use((db) =>
        db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, "item-retry")).get(),
      ),
    ).toMatchObject({ status: "pending", attempt: 1, max_attempts: 3 })
    expect(
      Database.use((db) =>
        db.select().from(CompanyWorkAttemptTable).where(eq(CompanyWorkAttemptTable.id, "attempt-retry")).get(),
      ),
    ).toEqual(beforeAttempt)
    expect(
      Database.use((db) =>
        db.select().from(CompanyWorkReceiptTable).where(eq(CompanyWorkReceiptTable.id, "receipt-retry")).get(),
      ),
    ).toEqual(beforeReceipt)
    expect(calls.dispatch).toEqual([project_id])
  })

  test.serial("reconciles Assignment and internal Attention before replaying claimed actions", async () => {
    const project_id = seedProject("action-s27")
    seedWorkItem(project_id, "item-s27", { status: "pending" })
    Database.use((db) => {
      db.insert(CompanyAgentTable)
        .values({
          id: "agent-s27",
          lifecycle: "assigned",
          name: "Recovery agent",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
      db.insert(CompanyCapabilityNeedTable)
        .values({
          id: "need-s27",
          project_id,
          work_item_id: "item-s27",
          need_key: "need-s27",
          role: "analyst",
          work_type: "analysis",
          capability_packs_json: "[]",
          risk_level: "medium",
          demand_horizon: "project",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
      db.insert(CompanyTeamSelectionTable)
        .values({
          id: "selection-s27",
          project_id,
          capability_need_id: "need-s27",
          agent_id: "agent-s27",
          decision: "selected",
          source: "company_pool",
          lifecycle_at_selection: "assigned",
          reason: "Recovery fixture",
          score_json: "{}",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
      db.insert(CompanyProjectAssignmentTable)
        .values({
          id: "assignment-s27",
          project_id,
          work_item_id: "item-s27",
          capability_need_id: "need-s27",
          selection_id: "selection-s27",
          agent_id: "agent-s27",
          version: 1,
          idempotency_key: "assignment-s27",
          temporary_role: "analyst",
          responsibility: "Recover",
          decision_scope_json: "[]",
          resource_scope_json: "[]",
          permission_mode: "read_only",
          status: "active",
          assigned_at: Date.now(),
          started_at: Date.now(),
        })
        .run()
    })
    const internal = await attention((service) =>
      service.create({
        project_id,
        idempotency_key: "attention-s27",
        issue: {
          issue_kind: "runtime_transient",
          risk: "medium",
          materiality: "internal",
        },
        title: "Transient runtime",
        summary: "Recover automatically",
        source_refs: [{ kind: "project", id: project_id }],
      }),
    )
    const requested = await attention((service) =>
      service.requestAction({
        project_id,
        action: "pause_work",
        idempotency_key: "action-s27",
        expected_revision: 1,
        payload: { reason: "Recovered pause" },
      }),
    )
    await attention((service) => service.claimAction(requested.record.id))

    const report = await recover()
    expect(report).toMatchObject({
      assignment_ids: ["assignment-s27"],
      attention_ids: [internal.record.id],
      action_ids: [requested.record.id],
      applied_action_ids: [requested.record.id],
      rejected_action_ids: [],
      replayed: false,
    })
    expect(
      Database.use((db) =>
        db
          .select()
          .from(CompanyProjectAssignmentTable)
          .where(eq(CompanyProjectAssignmentTable.id, "assignment-s27"))
          .get(),
      )?.status,
    ).toBe("assigned")
    expect(
      Database.use((db) =>
        db.select().from(CompanyAttentionTable).where(eq(CompanyAttentionTable.id, internal.record.id)).get(),
      )?.status,
    ).toBe("resolved")
    expect(
      Database.use((db) =>
        db.select().from(CompanyProjectActionTable).where(eq(CompanyProjectActionTable.id, requested.record.id)).get(),
      )?.status,
    ).toBe("applied")
    expect(calls.pause).toEqual([project_id])
    expect(await recover()).toMatchObject({
      assignment_ids: [],
      attention_ids: [],
      action_ids: [],
      replayed: true,
    })
    expect(calls.pause).toEqual([project_id])
  })
})
