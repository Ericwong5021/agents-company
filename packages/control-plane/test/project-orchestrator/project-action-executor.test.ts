import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { and, count, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
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
  CompanyArtifactTable,
  CompanyAttentionTable,
  CompanyPlanTable,
  CompanyProjectActionTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "../../src/company-project/company-project.sql"
import { DispatchCoordinator } from "../../src/project-orchestrator/dispatch"
import { ProjectActionExecutor } from "../../src/project-orchestrator/project-action-executor"
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

beforeEach(async () => {
  await resetDatabase()
  Object.values(calls).forEach((entries) => entries.splice(0))
})

afterEach(resetDatabase)

describe.serial("ProjectActionExecutor", () => {
  test.serial("executes pause, resume, and resolve_blocker through durable intents", async () => {
    const project_id = seedProject("action-controls")
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
