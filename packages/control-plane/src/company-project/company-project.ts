import fs from "fs/promises"
import os from "os"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { and, asc, desc, eq, gte, inArray, isNotNull, notInArray } from "drizzle-orm"
import { Database } from "@/storage"
import { Global } from "@/global"
import { Identifier } from "@/id/id"
import { AppFileSystem } from "@agents-company/shared/filesystem"
import {
  ProjectExecutionStrategy,
  SeedMode,
  type ProjectExecutionStrategy as ProjectExecutionStrategyValue,
  type SeedMode as SeedModeValue,
} from "@agents-company/shared/project-orchestration"
import { Company } from "@/company"
import { CompanyProjectAssignmentTable } from "@/company-recruitment/company-recruitment.sql"
import {
  CompanyApprovalGateTable,
  CompanyArtifactTable,
  CompanyPlanTable,
  CompanyProjectCharterTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyWorkItemDependencyTable,
  CompanyWorkItemTable,
  CompanyWorktreeRunTable,
} from "./company-project.sql"
import {
  ApprovalGate,
  Artifact,
  DeliveryPolicy,
  GateKind,
  Plan,
  Project,
  ProjectCharter,
  ProjectEvent,
  type PlanPhase,
  type ProjectStatus,
  WorkItem,
  type WorkAttempt,
  type WorkReceipt,
  type WorkReceiptSubmission,
  WorktreeRun,
  type WorktreeRunStatus,
} from "./schema"
import { CompanyWorkFacts } from "./work-facts"

const parseList = (value: string) => JSON.parse(value) as string[]
const parseRecord = (value: string) => JSON.parse(value) as Record<string, unknown>
const projectFromRow = (row: typeof CompanyProjectTable.$inferSelect) =>
  Project.parse({
    ...row,
    company_id: row.company_id ?? undefined,
    root_need_id: row.root_need_id ?? undefined,
    source_thread_id: row.source_thread_id ?? undefined,
    decision_request_id: row.decision_request_id ?? undefined,
    owner_agent_id: row.owner_agent_id ?? undefined,
    coordinator_session_id: row.coordinator_session_id ?? undefined,
    provider_id: row.provider_id ?? undefined,
    model_id: row.model_id ?? undefined,
    active_run_id: row.active_run_id ?? undefined,
    active_plan_version: row.active_plan_version ?? undefined,
    seed_mode: row.seed_mode ?? undefined,
    completed_at: row.completed_at ?? undefined,
  })
const planFromRow = (row: typeof CompanyPlanTable.$inferSelect) =>
  Plan.parse({
    ...row,
    assumptions: parseList(row.assumptions_json),
    acceptance_criteria: parseList(row.acceptance_criteria_json),
    change_reason: row.change_reason ?? undefined,
  })
const workItemFromRow = (row: typeof CompanyWorkItemTable.$inferSelect, depends_on: string[] = []) =>
  WorkItem.parse({
    ...row,
    source_task_key: row.source_task_key ?? undefined,
    parent_id: row.parent_id ?? undefined,
    origin_ref_id: row.origin_ref_id ?? undefined,
    superseded_by_id: row.superseded_by_id ?? undefined,
    owner_agent_id: row.owner_agent_id ?? undefined,
    workflow_run_id: row.workflow_run_id ?? undefined,
    capability_packs: parseList(row.capability_packs_json),
    decision_scope: parseList(row.decision_scope_json),
    resource_scope: parseList(row.resource_scope_json),
    inputs: parseList(row.inputs_json),
    expected_outputs: parseList(row.expected_outputs_json),
    validators: parseList(row.validators_json),
    depends_on,
    acceptance_criteria: parseList(row.acceptance_criteria_json),
    error: row.error ?? undefined,
    started_at: row.started_at ?? undefined,
    completed_at: row.completed_at ?? undefined,
  })
const hydrateWorkItems = (rows: (typeof CompanyWorkItemTable.$inferSelect)[]) => {
  const dependencies = rows.length
    ? Database.use((db) =>
        db
          .select()
          .from(CompanyWorkItemDependencyTable)
          .where(
            inArray(
              CompanyWorkItemDependencyTable.work_item_id,
              rows.map((row) => row.id),
            ),
          )
          .orderBy(CompanyWorkItemDependencyTable.work_item_id, CompanyWorkItemDependencyTable.depends_on_id)
          .all(),
      )
    : []
  return rows.map((row) =>
    workItemFromRow(
      row,
      dependencies
        .filter((dependency) => dependency.work_item_id === row.id)
        .map((dependency) => dependency.depends_on_id),
    ),
  )
}
const artifactFromRow = (row: typeof CompanyArtifactTable.$inferSelect) =>
  Artifact.parse({
    ...row,
    work_item_id: row.work_item_id ?? undefined,
    path: row.path ?? undefined,
    content: row.content ?? undefined,
    evidence: parseRecord(row.evidence_json),
    created_by_agent_id: row.created_by_agent_id ?? undefined,
  })
const eventFromRow = (row: typeof CompanyProjectEventTable.$inferSelect) =>
  ProjectEvent.parse({
    id: row.id,
    project_id: row.project_id,
    type: row.type,
    actor_id: row.actor_id ?? undefined,
    data: parseRecord(row.data_json),
    created_at: row.created_at,
  })
const gateFromRow = (row: typeof CompanyApprovalGateTable.$inferSelect) =>
  ApprovalGate.parse({
    ...row,
    project_id: row.project_id ?? undefined,
    company_id: row.company_id ?? undefined,
    pre_project_id: row.pre_project_id ?? undefined,
    decision_id: row.decision_id ?? undefined,
    requested_by_agent_id: row.requested_by_agent_id ?? undefined,
    requested_by_actor_kind: row.requested_by_actor_kind ?? undefined,
    requested_by_actor_id: row.requested_by_actor_id ?? undefined,
    work_item_id: row.work_item_id ?? undefined,
    resource_scope: parseList(row.resource_scope_json),
    worktree_run_id: row.worktree_run_id ?? undefined,
    decision_note: row.decision_note ?? undefined,
    decided_at: row.decided_at ?? undefined,
  })
const charterFromRow = (row: typeof CompanyProjectCharterTable.$inferSelect) =>
  ProjectCharter.parse({
    project_id: row.project_id,
    title: row.title,
    value: row.value,
    deliverables: parseList(row.deliverables_json),
    scope: parseList(row.scope_json),
    non_goals: parseList(row.non_goals_json),
    success_criteria: parseList(row.success_criteria_json),
    constraints: parseList(row.constraints_json),
    resources: JSON.parse(row.resources_json),
    risks: JSON.parse(row.risks_json),
    dri_agent_id: row.dri_agent_id,
    milestones: parseList(row.milestones_json),
    open_decisions: parseList(row.open_decisions_json),
    acceptance_criteria: parseList(row.acceptance_criteria_json),
    policy: parseRecord(row.policy_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  })
const worktreeRunFromRow = (row: typeof CompanyWorktreeRunTable.$inferSelect) =>
  WorktreeRun.parse({
    ...row,
    work_item_id: row.work_item_id ?? undefined,
    agent_run_id: row.agent_run_id ?? undefined,
    head_commit: row.head_commit ?? undefined,
    verification_commands: parseList(row.verification_commands_json),
    verification: parseRecord(row.verification_json),
    review: parseRecord(row.review_json),
    merge_gate_id: row.merge_gate_id ?? undefined,
    error: row.error ?? undefined,
    merged_at: row.merged_at ?? undefined,
  })

const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  intake: ["planning", "blocked"],
  planning: ["executing", "reviewing", "awaiting_approval", "completed", "blocked"],
  executing: ["executing", "reviewing", "awaiting_approval", "completed", "blocked"],
  reviewing: ["executing", "reviewing", "awaiting_approval", "completed", "blocked"],
  awaiting_approval: ["executing", "reviewing", "completed", "rejected", "blocked"],
  completed: [],
  rejected: ["planning"],
  blocked: ["planning", "executing", "reviewing", "rejected"],
}

export interface Interface {
  readonly create: (input: {
    company_id?: string
    root_need_id?: string
    source_thread_id?: string
    decision_request_id?: string
    goal: string
    title?: string
    owner_agent_id?: string
    coordinator_session_id?: string
    provider_id?: string
    model_id?: string
    execution_strategy?: ProjectExecutionStrategyValue
    seed_mode?: SeedModeValue
  }) => Effect.Effect<Project>
  readonly get: (id: string) => Effect.Effect<Project | undefined>
  readonly findBySourceThread: (source_thread_id: string) => Effect.Effect<Project | undefined>
  readonly findByDecisionRequest: (decision_request_id: string) => Effect.Effect<Project | undefined>
  readonly list: () => Effect.Effect<Project[]>
  readonly createCharter: (input: {
    project_id: string
    title?: string
    value?: string
    deliverables?: string[]
    scope: string[]
    non_goals?: string[]
    success_criteria: string[]
    constraints?: string[]
    resources?: {
      kind: "file" | "application" | "web" | "data" | "repository" | "other"
      scope: string
      disposition: string
    }[]
    risks?: { description: string; mitigation: string }[]
    dri_agent_id?: string
    milestones?: string[]
    open_decisions?: string[]
    acceptance_criteria: string[]
    policy?: DeliveryPolicy
  }) => Effect.Effect<ProjectCharter>
  readonly getCharter: (project_id: string) => Effect.Effect<ProjectCharter | undefined>
  readonly transition: (input: {
    id: string
    status: ProjectStatus
    actor_id?: string
    reason?: string
  }) => Effect.Effect<Project>
  readonly setActiveRun: (input: { id: string; run_id?: string }) => Effect.Effect<Project>
  readonly setModel: (input: { id: string; provider_id?: string; model_id?: string }) => Effect.Effect<Project>
  readonly createPlan: (input: {
    project_id: string
    phase: PlanPhase
    summary: string
    assumptions?: string[]
    acceptance_criteria: string[]
    change_reason?: string
  }) => Effect.Effect<Plan>
  readonly listPlans: (project_id: string) => Effect.Effect<Plan[]>
  readonly createWorkItem: (input: {
    project_id: string
    plan_id: string
    source_task_key?: string
    parent_id?: string
    title: string
    description: string
    kind: "planner" | "worker" | "reviewer"
    work_type: "coding" | "decision" | "research" | "writing" | "design" | "analysis" | "knowledge_reading"
    role: string
    capability_packs?: string[]
    decision_scope?: string[]
    resource_scope?: string[]
    inputs?: string[]
    expected_outputs?: string[]
    validators?: string[]
    disposition?: string
    model_group: "ultra" | "standard" | "lite"
    risk_level?: "low" | "medium" | "high"
    review_status?: "pending" | "running" | "accepted" | "rejected" | "not_required"
    purpose?: "discovery" | "first_slice" | "delivery" | "verification" | "recovery" | "closeout"
    origin_kind?: "legacy" | "seed" | "receipt" | "graph_mutation" | "user"
    origin_ref_id?: string
    graph_revision_created?: number
    validation_mode?: "self_check" | "machine" | "independent_review" | "review_and_user_gate"
    owner_agent_id?: string
    acceptance_criteria: string[]
    max_attempts?: number
    depends_on?: string[]
  }) => Effect.Effect<WorkItem>
  readonly setWorkItemSourceTaskKey: (input: { id: string; source_task_key: string }) => Effect.Effect<WorkItem>
  readonly reworkRejectedReview: (input: {
    worker_id: string
    reviewer_id: string
  }) => Effect.Effect<{ worker: WorkItem; reviewer: WorkItem }>
  readonly listWorkItems: (project_id: string) => Effect.Effect<WorkItem[]>
  readonly readyWorkItems: (project_id: string) => Effect.Effect<WorkItem[]>
  readonly startWorkItem: (id: string) => Effect.Effect<WorkItem>
  readonly assignWorkItem: (input: { id: string; owner_agent_id: string; reason: string }) => Effect.Effect<WorkItem>
  readonly setWorkItemRun: (input: { id: string; workflow_run_id?: string }) => Effect.Effect<WorkItem>
  readonly setWorkItemReview: (input: {
    id: string
    review_status: "pending" | "running" | "accepted" | "rejected" | "not_required"
  }) => Effect.Effect<WorkItem>
  readonly blockWorkItem: (input: { id: string; error: string }) => Effect.Effect<WorkItem>
  readonly retryWorkItem: (id: string) => Effect.Effect<WorkItem>
  readonly completeWorkItem: (id: string) => Effect.Effect<WorkItem>
  readonly completeWorkItemWithReceipt: (input: {
    id: string
    receipt: WorkReceiptSubmission
  }) => Effect.Effect<WorkItem>
  readonly createWorktreeRun: (input: {
    project_id: string
    work_item_id?: string
    agent_run_id?: string
  }) => Effect.Effect<WorktreeRun>
  readonly getWorktreeRun: (id: string) => Effect.Effect<WorktreeRun | undefined>
  readonly listWorktreeRuns: (project_id: string) => Effect.Effect<WorktreeRun[]>
  readonly startWorktreeRun: (input: { id: string; agent_run_id?: string }) => Effect.Effect<WorktreeRun>
  readonly verifyWorktreeRun: (input: { id: string; commands: string[] }) => Effect.Effect<WorktreeRun>
  readonly requestMergeApproval: (input: {
    id: string
    title: string
    summary: string
    requested_by_agent_id?: string
    review?: Record<string, unknown>
  }) => Effect.Effect<ApprovalGate>
  readonly mergeWorktreeRun: (id: string) => Effect.Effect<WorktreeRun>
  readonly addArtifact: (input: {
    project_id: string
    work_item_id?: string
    kind: string
    title: string
    path?: string
    content?: string
    evidence?: Record<string, unknown>
    created_by_agent_id?: string
  }) => Effect.Effect<Artifact>
  readonly listArtifacts: (project_id: string) => Effect.Effect<Artifact[]>
  readonly listWorkAttempts: (project_id: string) => Effect.Effect<WorkAttempt[]>
  readonly listWorkReceipts: (
    project_id: string,
    page?: { limit: number; offset: number },
  ) => Effect.Effect<WorkReceipt[]>
  readonly listEvents: (project_id: string) => Effect.Effect<ProjectEvent[]>
  readonly requestGate: (input: {
    project_id: string
    kind: GateKind
    title: string
    summary: string
    requested_by_agent_id?: string
    work_item_id?: string
    resource_scope?: string[]
    worktree_run_id?: string
  }) => Effect.Effect<ApprovalGate>
  readonly resolveGate: (input: {
    id: string
    decision: "approve" | "reject"
    note?: string
  }) => Effect.Effect<ApprovalGate>
  readonly listGates: (
    project_id?: string,
    status?: "pending" | "approved" | "rejected",
  ) => Effect.Effect<ApprovalGate[]>
  readonly recordEvent: (input: {
    project_id: string
    type: string
    data?: Record<string, unknown>
    actor_id?: string
  }) => Effect.Effect<void>
  readonly initRepository: (project_id: string) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyProject") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const company = yield* Company.Service
    const facts = yield* CompanyWorkFacts.Service
    const event = (project_id: string, type: string, data: Record<string, unknown>, actor_id?: string) =>
      Effect.sync(() => {
        Database.use((db) =>
          db
            .insert(CompanyProjectEventTable)
            .values({
              id: Identifier.ascending("event"),
              project_id,
              type,
              actor_id: actor_id ?? null,
              data_json: JSON.stringify(data),
              created_at: Date.now(),
            })
            .run(),
        )
      })

    const get = Effect.fn("CompanyProject.get")(function* (id: string) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, id)).get()),
      )
      return row ? projectFromRow(row) : undefined
    })

    const findBySourceThread = Effect.fn("CompanyProject.findBySourceThread")(function* (source_thread_id: string) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.source_thread_id, source_thread_id)).get(),
        ),
      )
      return row ? projectFromRow(row) : undefined
    })

    const findByDecisionRequest = Effect.fn("CompanyProject.findByDecisionRequest")(function* (
      decision_request_id: string,
    ) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyProjectTable)
            .where(eq(CompanyProjectTable.decision_request_id, decision_request_id))
            .get(),
        ),
      )
      return row ? projectFromRow(row) : undefined
    })

    const create = Effect.fn("CompanyProject.create")(function* (input: {
      company_id?: string
      root_need_id?: string
      source_thread_id?: string
      decision_request_id?: string
      goal: string
      title?: string
      owner_agent_id?: string
      coordinator_session_id?: string
      provider_id?: string
      model_id?: string
      execution_strategy?: ProjectExecutionStrategyValue
      seed_mode?: SeedModeValue
    }) {
      if (input.source_thread_id) {
        const existing = yield* findBySourceThread(input.source_thread_id)
        if (existing) return existing
      }
      if (input.decision_request_id) {
        const existing = yield* findByDecisionRequest(input.decision_request_id)
        if (existing) return existing
      }
      const execution_strategy = ProjectExecutionStrategy.parse(input.execution_strategy ?? "legacy_full_plan")
      const seed_mode = input.seed_mode === undefined ? undefined : SeedMode.parse(input.seed_mode)
      if (execution_strategy === "legacy_full_plan" && seed_mode)
        throw new Error("Legacy company projects cannot persist a seed mode")
      if (execution_strategy === "seed_and_grow" && !seed_mode)
        throw new Error("Seed-and-Grow company projects require a pinned seed mode")
      const id = Identifier.ascending("companyProject")
      const now = Date.now()
      const output_dir = path.join(Global.Path.data, "workspace", "projects", id)
      yield* Effect.promise(() =>
        Promise.all([
          fs.mkdir(path.join(output_dir, "artifacts", "research"), { recursive: true }),
          fs.mkdir(path.join(output_dir, "artifacts", "product"), { recursive: true }),
          fs.mkdir(path.join(output_dir, "artifacts", "engineering"), { recursive: true }),
          fs.mkdir(path.join(output_dir, "artifacts", "verification"), { recursive: true }),
        ]),
      )
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(CompanyProjectTable)
            .values({
              id,
              company_id: input.company_id ?? null,
              root_need_id: input.root_need_id ?? null,
              source_thread_id: input.source_thread_id ?? null,
              decision_request_id: input.decision_request_id ?? null,
              goal: input.goal,
              title: input.title ?? input.goal.slice(0, 80),
              status: "intake",
              owner_agent_id: input.owner_agent_id ?? null,
              coordinator_session_id: input.coordinator_session_id ?? null,
              provider_id: input.provider_id ?? null,
              model_id: input.model_id ?? null,
              active_run_id: null,
              output_dir,
              execution_strategy,
              seed_mode: seed_mode ?? null,
              created_at: now,
              updated_at: now,
            })
            .run(),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(output_dir, "project.json"),
          JSON.stringify({ id, goal: input.goal, execution_strategy, seed_mode, created_at: now }, null, 2) + "\n",
        ),
      )
      yield* event(id, "project.created", { goal: input.goal, execution_strategy, seed_mode }, input.owner_agent_id)
      return (yield* get(id))!
    })

    const list = Effect.fn("CompanyProject.list")(function* () {
      return (yield* Effect.sync(() =>
        Database.use((db) => db.select().from(CompanyProjectTable).orderBy(desc(CompanyProjectTable.updated_at)).all()),
      )).map(projectFromRow)
    })

    const setModel = Effect.fn("CompanyProject.setModel")(function* (input: {
      id: string
      provider_id?: string
      model_id?: string
    }) {
      if (!(yield* get(input.id))) throw new Error(`Company project not found: ${input.id}`)
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(CompanyProjectTable)
            .set({
              provider_id: input.provider_id ?? null,
              model_id: input.model_id ?? null,
              updated_at: Date.now(),
            })
            .where(eq(CompanyProjectTable.id, input.id))
            .run(),
        ),
      )
      yield* event(input.id, "project.model_changed", {
        provider_id: input.provider_id,
        model_id: input.model_id,
      })
      return (yield* get(input.id))!
    })

    const getCharter = Effect.fn("CompanyProject.getCharter")(function* (project_id: string) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyProjectCharterTable)
            .where(eq(CompanyProjectCharterTable.project_id, project_id))
            .get(),
        ),
      )
      return row ? charterFromRow(row) : undefined
    })

    const createCharter = Effect.fn("CompanyProject.createCharter")(function* (input: {
      project_id: string
      title?: string
      value?: string
      deliverables?: string[]
      scope: string[]
      non_goals?: string[]
      success_criteria: string[]
      constraints?: string[]
      resources?: {
        kind: "file" | "application" | "web" | "data" | "repository" | "other"
        scope: string
        disposition: string
      }[]
      risks?: { description: string; mitigation: string }[]
      dri_agent_id?: string
      milestones?: string[]
      open_decisions?: string[]
      acceptance_criteria: string[]
      policy?: DeliveryPolicy
    }) {
      const project = yield* get(input.project_id)
      if (!project) throw new Error(`Company project not found: ${input.project_id}`)
      const now = Date.now()
      const companyState = yield* company.current().pipe(Effect.orDie)
      if (companyState.state !== "ready") throw new Error("Company approval policy is unavailable")
      const preset = companyState.company.approval_policy.preset
      const policy = DeliveryPolicy.parse(
        input.policy ?? {
          source_approval_preset: preset,
          allow_workspace_write: preset !== "strict",
          require_high_risk_approval: preset !== "autonomous",
          require_human_merge: preset !== "autonomous",
          require_clean_worktree: true,
          require_main_branch_verification: true,
        },
      )
      const row = {
        project_id: input.project_id,
        title: input.title ?? project.title,
        value: input.value ?? project.goal,
        deliverables_json: JSON.stringify(
          input.deliverables?.length
            ? input.deliverables
            : input.success_criteria.length
              ? input.success_criteria
              : [project.goal],
        ),
        scope_json: JSON.stringify(input.scope.length ? input.scope : [project.goal]),
        non_goals_json: JSON.stringify(
          input.non_goals?.length ? input.non_goals : ["不执行当前 Project Charter 范围外工作"],
        ),
        success_criteria_json: JSON.stringify(input.success_criteria),
        constraints_json: JSON.stringify(
          input.constraints?.length ? input.constraints : ["遵守当前公司权限与审批策略"],
        ),
        resources_json: JSON.stringify(
          input.resources?.length
            ? input.resources
            : [{ kind: "other", scope: project.output_dir, disposition: "retain" }],
        ),
        risks_json: JSON.stringify(input.risks ?? []),
        dri_agent_id: input.dri_agent_id ?? project.owner_agent_id ?? "project-owner-unassigned",
        milestones_json: JSON.stringify(
          input.milestones?.length
            ? input.milestones
            : input.deliverables?.length
              ? input.deliverables
              : input.success_criteria.length
                ? input.success_criteria
                : [project.goal],
        ),
        open_decisions_json: JSON.stringify(input.open_decisions ?? []),
        acceptance_criteria_json: JSON.stringify(
          input.acceptance_criteria.length
            ? input.acceptance_criteria
            : input.success_criteria.length
              ? input.success_criteria
              : [project.goal],
        ),
        policy_json: JSON.stringify(policy),
        created_at: now,
        updated_at: now,
      }
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(CompanyProjectCharterTable)
            .values(row)
            .onConflictDoUpdate({
              target: CompanyProjectCharterTable.project_id,
              set: {
                title: row.title,
                value: row.value,
                deliverables_json: row.deliverables_json,
                scope_json: row.scope_json,
                non_goals_json: row.non_goals_json,
                success_criteria_json: row.success_criteria_json,
                constraints_json: row.constraints_json,
                resources_json: row.resources_json,
                risks_json: row.risks_json,
                dri_agent_id: row.dri_agent_id,
                milestones_json: row.milestones_json,
                open_decisions_json: row.open_decisions_json,
                acceptance_criteria_json: row.acceptance_criteria_json,
                policy_json: row.policy_json,
                updated_at: row.updated_at,
              },
            })
            .run(),
        ),
      )
      yield* event(input.project_id, "charter.saved", { policy, scope: input.scope })
      return (yield* getCharter(input.project_id))!
    })

    const setActiveRun = Effect.fn("CompanyProject.setActiveRun")(function* (input: { id: string; run_id?: string }) {
      if (!(yield* get(input.id))) throw new Error(`Company project not found: ${input.id}`)
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(CompanyProjectTable)
            .set({
              active_run_id: input.run_id ?? null,
              updated_at: Date.now(),
            })
            .where(eq(CompanyProjectTable.id, input.id))
            .run(),
        ),
      )
      yield* event(input.id, input.run_id ? "workflow.started" : "workflow.finished", { run_id: input.run_id })
      return (yield* get(input.id))!
    })

    const transition = Effect.fn("CompanyProject.transition")(function* (input: {
      id: string
      status: ProjectStatus
      actor_id?: string
      reason?: string
    }) {
      const current = yield* get(input.id)
      if (!current) throw new Error(`Company project not found: ${input.id}`)
      if (current.status !== input.status && !PROJECT_TRANSITIONS[current.status].includes(input.status)) {
        throw new Error(`Invalid company project transition: ${current.status} -> ${input.status}`)
      }
      const now = Date.now()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(CompanyProjectTable)
            .set({
              status: input.status,
              updated_at: now,
              completed_at: input.status === "completed" ? now : (current.completed_at ?? null),
            })
            .where(eq(CompanyProjectTable.id, input.id))
            .run(),
        ),
      )
      yield* event(
        input.id,
        "project.status_changed",
        { from: current.status, to: input.status, reason: input.reason },
        input.actor_id,
      )
      return (yield* get(input.id))!
    })

    const listPlans = Effect.fn("CompanyProject.listPlans")(function* (project_id: string) {
      return (yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyPlanTable)
            .where(eq(CompanyPlanTable.project_id, project_id))
            .orderBy(asc(CompanyPlanTable.version))
            .all(),
        ),
      )).map(planFromRow)
    })

    const createPlan = Effect.fn("CompanyProject.createPlan")(function* (input: {
      project_id: string
      phase: PlanPhase
      summary: string
      assumptions?: string[]
      acceptance_criteria: string[]
      change_reason?: string
    }) {
      if (!(yield* get(input.project_id))) throw new Error(`Company project not found: ${input.project_id}`)
      const previous = yield* listPlans(input.project_id)
      const version = (previous.at(-1)?.version ?? 0) + 1
      const id = Identifier.ascending("companyPlan")
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.update(CompanyPlanTable)
            .set({ status: "superseded" })
            .where(and(eq(CompanyPlanTable.project_id, input.project_id), eq(CompanyPlanTable.status, "active")))
            .run()
          db.insert(CompanyPlanTable)
            .values({
              id,
              project_id: input.project_id,
              version,
              phase: input.phase,
              status: "active",
              summary: input.summary,
              assumptions_json: JSON.stringify(input.assumptions ?? []),
              acceptance_criteria_json: JSON.stringify(input.acceptance_criteria),
              change_reason: input.change_reason ?? null,
              created_at: Date.now(),
            })
            .run()
          db.update(CompanyProjectTable)
            .set({ active_plan_version: version, updated_at: Date.now() })
            .where(eq(CompanyProjectTable.id, input.project_id))
            .run()
        }),
      )
      yield* event(input.project_id, "plan.created", { plan_id: id, version, phase: input.phase })
      return planFromRow(
        Database.use((db) => db.select().from(CompanyPlanTable).where(eq(CompanyPlanTable.id, id)).get())!,
      )
    })

    const createWorkItem = Effect.fn("CompanyProject.createWorkItem")(function* (
      input: Parameters<Interface["createWorkItem"]>[0],
    ) {
      if (
        input.source_task_key !== undefined &&
        (!input.source_task_key.trim() || input.source_task_key.trim() !== input.source_task_key)
      )
        throw new Error("Work item source task key must be a non-empty trimmed string")
      const depends_on = [...new Set(input.depends_on ?? [])].sort()
      const review_status = input.review_status ?? (input.kind === "worker" ? "pending" : "not_required")
      const validation_mode =
        input.validation_mode ?? (review_status === "not_required" ? "self_check" : "independent_review")
      const facts = {
        parent_id: input.parent_id,
        title: input.title,
        description: input.description,
        kind: input.kind,
        work_type: input.work_type,
        role: input.role,
        capability_packs: input.capability_packs ?? [],
        decision_scope: input.decision_scope ?? [],
        resource_scope: input.resource_scope ?? [],
        inputs: input.inputs ?? [],
        expected_outputs: input.expected_outputs ?? [],
        validators: input.validators ?? input.acceptance_criteria,
        disposition: input.disposition ?? "retain",
        model_group: input.model_group,
        risk_level: input.risk_level ?? "medium",
        review_status,
        purpose: input.purpose ?? "delivery",
        origin_kind: input.origin_kind ?? "legacy",
        origin_ref_id: input.origin_ref_id,
        graph_revision_created: input.graph_revision_created ?? 0,
        validation_mode,
        owner_agent_id: input.owner_agent_id,
        acceptance_criteria: input.acceptance_criteria,
        max_attempts: input.max_attempts ?? 3,
        depends_on,
      }
      const reconcile = (row: typeof CompanyWorkItemTable.$inferSelect) => {
        const existing = hydrateWorkItems([row])[0]!
        const existingFacts = {
          parent_id: existing.parent_id,
          title: existing.title,
          description: existing.description,
          kind: existing.kind,
          work_type: existing.work_type,
          role: existing.role,
          capability_packs: existing.capability_packs,
          decision_scope: existing.decision_scope,
          resource_scope: existing.resource_scope,
          inputs: existing.inputs,
          expected_outputs: existing.expected_outputs,
          validators: existing.validators,
          disposition: existing.disposition,
          model_group: existing.model_group,
          risk_level: existing.risk_level,
          review_status: existing.review_status,
          purpose: existing.purpose,
          origin_kind: existing.origin_kind,
          origin_ref_id: existing.origin_ref_id,
          graph_revision_created: existing.graph_revision_created,
          validation_mode: existing.validation_mode,
          owner_agent_id: existing.owner_agent_id,
          acceptance_criteria: existing.acceptance_criteria,
          max_attempts: existing.max_attempts,
          depends_on: [...new Set(existing.depends_on)].sort(),
        }
        if (JSON.stringify(existingFacts) !== JSON.stringify(facts))
          throw new Error(
            `Work item source task key conflict for ${input.source_task_key} (${input.kind}): existing facts or dependencies differ`,
          )
        return existing
      }
      const id = Identifier.ascending("companyWorkItem")
      const now = Date.now()
      const existingRow = yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const existing =
              input.source_task_key === undefined
                ? undefined
                : db
                    .select()
                    .from(CompanyWorkItemTable)
                    .where(
                      and(
                        eq(CompanyWorkItemTable.project_id, input.project_id),
                        eq(CompanyWorkItemTable.plan_id, input.plan_id),
                        eq(CompanyWorkItemTable.source_task_key, input.source_task_key),
                        eq(CompanyWorkItemTable.kind, input.kind),
                      ),
                    )
                    .get()
            if (existing) return existing
            db.insert(CompanyWorkItemTable)
              .values({
                id,
                project_id: input.project_id,
                plan_id: input.plan_id,
                source_task_key: input.source_task_key ?? null,
                parent_id: input.parent_id ?? null,
                title: input.title,
                description: input.description,
                kind: input.kind,
                work_type: input.work_type,
                role: input.role,
                capability_packs_json: JSON.stringify(input.capability_packs ?? []),
                decision_scope_json: JSON.stringify(input.decision_scope ?? []),
                resource_scope_json: JSON.stringify(input.resource_scope ?? []),
                inputs_json: JSON.stringify(input.inputs ?? []),
                expected_outputs_json: JSON.stringify(input.expected_outputs ?? []),
                validators_json: JSON.stringify(input.validators ?? input.acceptance_criteria),
                disposition: input.disposition ?? "retain",
                model_group: input.model_group,
                risk_level: input.risk_level ?? "medium",
                review_status,
                status: "pending",
                purpose: input.purpose ?? "delivery",
                origin_kind: input.origin_kind ?? "legacy",
                origin_ref_id: input.origin_ref_id ?? null,
                graph_revision_created: input.graph_revision_created ?? 0,
                validation_mode,
                superseded_by_id: null,
                owner_agent_id: input.owner_agent_id ?? null,
                workflow_run_id: null,
                acceptance_criteria_json: JSON.stringify(input.acceptance_criteria),
                max_attempts: input.max_attempts ?? 3,
                created_at: now,
                updated_at: now,
              })
              .run()
            if (depends_on.length)
              db.insert(CompanyWorkItemDependencyTable)
                .values(depends_on.map((depends_on_id) => ({ work_item_id: id, depends_on_id })))
                .onConflictDoNothing()
                .run()
            return undefined
          },
          { behavior: "immediate" },
        ),
      )
      if (existingRow) return reconcile(existingRow)
      yield* event(
        input.project_id,
        "work_item.created",
        {
          work_item_id: id,
          title: input.title,
          kind: input.kind,
          work_type: input.work_type,
          role: input.role,
          model_group: input.model_group,
          source_task_key: input.source_task_key,
          decision_scope: input.decision_scope ?? [],
          resource_scope: input.resource_scope ?? [],
          inputs: input.inputs ?? [],
          expected_outputs: input.expected_outputs ?? [],
          validators: input.validators ?? input.acceptance_criteria,
          disposition: input.disposition ?? "retain",
          purpose: input.purpose ?? "delivery",
          origin_kind: input.origin_kind ?? "legacy",
          origin_ref_id: input.origin_ref_id,
          graph_revision_created: input.graph_revision_created ?? 0,
          validation_mode,
          depends_on,
        },
        input.owner_agent_id,
      )
      return hydrateWorkItems([
        Database.use((db) => db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, id)).get())!,
      ])[0]!
    })

    const setWorkItemSourceTaskKey = Effect.fn("CompanyProject.setWorkItemSourceTaskKey")(function* (input: {
      id: string
      source_task_key: string
    }) {
      if (!input.source_task_key.trim() || input.source_task_key.trim() !== input.source_task_key)
        throw new Error("Work item source task key must be a non-empty trimmed string")
      const changed = yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const current = db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, input.id)).get()
            if (!current) throw new Error(`Company work item not found: ${input.id}`)
            if (current.source_task_key === input.source_task_key) return false
            if (current.source_task_key)
              throw new Error(`Work item ${input.id} already has source task key ${current.source_task_key}`)
            const conflict = db
              .select({ id: CompanyWorkItemTable.id })
              .from(CompanyWorkItemTable)
              .where(
                and(
                  eq(CompanyWorkItemTable.project_id, current.project_id),
                  eq(CompanyWorkItemTable.plan_id, current.plan_id),
                  eq(CompanyWorkItemTable.source_task_key, input.source_task_key),
                  eq(CompanyWorkItemTable.kind, current.kind),
                ),
              )
              .get()
            if (conflict)
              throw new Error(
                `Work item source task key conflict for ${input.source_task_key} (${current.kind}): already assigned to ${conflict.id}`,
              )
            db.update(CompanyWorkItemTable)
              .set({ source_task_key: input.source_task_key, updated_at: Date.now() })
              .where(eq(CompanyWorkItemTable.id, input.id))
              .run()
            return true
          },
          { behavior: "immediate" },
        ),
      )
      const row = Database.use((db) =>
        db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, input.id)).get(),
      )!
      if (changed)
        yield* event(row.project_id, "work_item.source_task_key_set", {
          work_item_id: input.id,
          source_task_key: input.source_task_key,
        })
      return hydrateWorkItems([row])[0]!
    })

    const reworkRejectedReview = Effect.fn("CompanyProject.reworkRejectedReview")(function* (input: {
      worker_id: string
      reviewer_id: string
    }) {
      const projectID = yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const worker = db
              .select()
              .from(CompanyWorkItemTable)
              .where(eq(CompanyWorkItemTable.id, input.worker_id))
              .get()
            const reviewer = db
              .select()
              .from(CompanyWorkItemTable)
              .where(eq(CompanyWorkItemTable.id, input.reviewer_id))
              .get()
            if (!worker || worker.kind !== "worker") throw new Error(`Worker not found: ${input.worker_id}`)
            if (!reviewer || reviewer.kind !== "reviewer" || reviewer.parent_id !== worker.id)
              throw new Error(`Reviewer ${input.reviewer_id} does not review worker ${input.worker_id}`)
            if (!["completed", "blocked"].includes(worker.status) || worker.review_status !== "rejected")
              throw new Error(`Worker ${worker.id} is not awaiting rejected-review rework`)
            if (!["blocked", "failed"].includes(reviewer.status))
              throw new Error(`Reviewer ${reviewer.id} cannot request rework from ${reviewer.status}`)
            const now = Date.now()
            db.update(CompanyWorkItemTable)
              .set({
                status: "pending",
                review_status: "pending",
                workflow_run_id: null,
                error: null,
                completed_at: null,
                max_attempts: Math.max(worker.max_attempts, worker.attempt + 1),
                updated_at: now,
              })
              .where(eq(CompanyWorkItemTable.id, worker.id))
              .run()
            db.update(CompanyWorkItemTable)
              .set({
                status: "pending",
                workflow_run_id: null,
                error: null,
                completed_at: null,
                max_attempts: Math.max(reviewer.max_attempts, reviewer.attempt + 1),
                updated_at: now,
              })
              .where(eq(CompanyWorkItemTable.id, reviewer.id))
              .run()
            return worker.project_id
          },
          { behavior: "immediate" },
        ),
      )
      yield* event(projectID, "work_item.rework_requested", {
        worker_id: input.worker_id,
        reviewer_id: input.reviewer_id,
      })
      const items = yield* listWorkItems(projectID)
      return {
        worker: items.find((item) => item.id === input.worker_id)!,
        reviewer: items.find((item) => item.id === input.reviewer_id)!,
      }
    })

    const assignWorkItem = Effect.fn("CompanyProject.assignWorkItem")(function* (input: {
      id: string
      owner_agent_id: string
      reason: string
    }) {
      const reason = input.reason.trim()
      if (!reason) throw new Error("Work item assignment reason must be non-empty")
      if (!input.owner_agent_id.trim() || input.owner_agent_id.trim() !== input.owner_agent_id)
        throw new Error("Work item owner agent ID must be a non-empty trimmed string")
      yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const current = db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, input.id)).get()
            if (!current) throw new Error(`Company work item not found: ${input.id}`)
            if (!["pending", "blocked", "failed", "completed"].includes(current.status))
              throw new Error(`Work item ${input.id} cannot be reassigned from ${current.status}`)
            if (current.owner_agent_id === input.owner_agent_id)
              throw new Error(`Work item ${input.id} is already assigned to ${input.owner_agent_id}`)
            const now = Date.now()
            db.update(CompanyWorkItemTable)
              .set({ owner_agent_id: input.owner_agent_id, updated_at: now })
              .where(eq(CompanyWorkItemTable.id, input.id))
              .run()
            db.insert(CompanyProjectEventTable)
              .values({
                id: Identifier.ascending("event"),
                project_id: current.project_id,
                type: "work_item.reassigned",
                actor_id: null,
                data_json: JSON.stringify({
                  work_item_id: current.id,
                  from_agent_id: current.owner_agent_id,
                  to_agent_id: input.owner_agent_id,
                  reason,
                }),
                created_at: now,
              })
              .run()
          },
          { behavior: "immediate" },
        ),
      )
      return hydrateWorkItems([
        Database.use((db) =>
          db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, input.id)).get(),
        )!,
      ])[0]!
    })

    const listWorkItems = Effect.fn("CompanyProject.listWorkItems")(function* (project_id: string) {
      return hydrateWorkItems(
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(CompanyWorkItemTable)
              .where(eq(CompanyWorkItemTable.project_id, project_id))
              .orderBy(asc(CompanyWorkItemTable.created_at))
              .all(),
          ),
        ),
      )
    })

    const readyWorkItems = Effect.fn("CompanyProject.readyWorkItems")(function* (project_id: string) {
      const activePlan = yield* Effect.sync(() =>
        Database.use((db) => {
          const project = db
            .select({ active_plan_version: CompanyProjectTable.active_plan_version })
            .from(CompanyProjectTable)
            .where(eq(CompanyProjectTable.id, project_id))
            .get()
          if (!project?.active_plan_version) return
          return db
            .select({ id: CompanyPlanTable.id })
            .from(CompanyPlanTable)
            .where(
              and(
                eq(CompanyPlanTable.project_id, project_id),
                eq(CompanyPlanTable.version, project.active_plan_version),
                eq(CompanyPlanTable.status, "active"),
              ),
            )
            .get()
        }),
      )
      if (!activePlan) return []
      const pending = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyWorkItemTable)
            .where(
              and(
                eq(CompanyWorkItemTable.project_id, project_id),
                eq(CompanyWorkItemTable.plan_id, activePlan.id),
                eq(CompanyWorkItemTable.status, "pending"),
              ),
            )
            .all(),
        ),
      )
      if (!pending.length) return []
      const dependencies = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyWorkItemDependencyTable)
            .where(
              inArray(
                CompanyWorkItemDependencyTable.work_item_id,
                pending.map((item) => item.id),
              ),
            )
            .orderBy(CompanyWorkItemDependencyTable.work_item_id, CompanyWorkItemDependencyTable.depends_on_id)
            .all(),
        ),
      )
      const incomplete = new Set(
        (yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select({ id: CompanyWorkItemTable.id })
              .from(CompanyWorkItemTable)
              .where(notInArray(CompanyWorkItemTable.status, ["completed", "superseded", "cancelled"]))
              .all(),
          ),
        )).map((item) => item.id),
      )
      const reviewableParents = new Set(
        pending
          .filter((item) => item.kind === "reviewer" && Boolean(item.parent_id))
          .filter((item) =>
            Database.use((db) => {
              const parent = db
                .select({
                  status: CompanyWorkItemTable.status,
                  started_at: CompanyWorkItemTable.started_at,
                })
                .from(CompanyWorkItemTable)
                .where(eq(CompanyWorkItemTable.id, item.parent_id!))
                .get()
              if (parent?.status !== "running" || parent.started_at === null) return false
              return Boolean(
                db
                  .select({ id: CompanyArtifactTable.id })
                  .from(CompanyArtifactTable)
                  .where(
                    and(
                      eq(CompanyArtifactTable.project_id, project_id),
                      eq(CompanyArtifactTable.work_item_id, item.parent_id!),
                      gte(CompanyArtifactTable.created_at, parent.started_at),
                    ),
                  )
                  .get(),
              )
            }),
          )
          .map((item) => item.parent_id!),
      )
      const pendingByID = new Map(pending.map((item) => [item.id, item]))
      const blocked = new Set(
        dependencies
          .filter(
            (dependency) =>
              incomplete.has(dependency.depends_on_id) &&
              !(
                pendingByID.get(dependency.work_item_id)?.kind === "reviewer" &&
                pendingByID.get(dependency.work_item_id)?.parent_id === dependency.depends_on_id &&
                reviewableParents.has(dependency.depends_on_id)
              ),
          )
          .map((dependency) => dependency.work_item_id),
      )
      ;(yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({ blocking_work_item_ids_json: CompanyValidationGateTable.blocking_work_item_ids_json })
            .from(CompanyValidationGateTable)
            .where(
              and(
                eq(CompanyValidationGateTable.project_id, project_id),
                notInArray(CompanyValidationGateTable.status, ["passed", "superseded"]),
              ),
            )
            .all(),
        ),
      )).forEach((gate) =>
        parseList(gate.blocking_work_item_ids_json).forEach((work_item_id) => blocked.add(work_item_id)),
      )
      return pending
        .filter((item) => !blocked.has(item.id))
        .map((item) =>
          workItemFromRow(
            item,
            dependencies
              .filter((dependency) => dependency.work_item_id === item.id)
              .map((dependency) => dependency.depends_on_id),
          ),
        )
    })

    const updateWorkItem = Effect.fn("CompanyProject.updateWorkItem")(function* (
      id: string,
      status: "running" | "blocked" | "pending" | "completed",
      error?: string,
      receipt?: WorkReceiptSubmission,
    ) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, id)).get()),
      )
      if (!row) throw new Error(`Company work item not found: ${id}`)
      const now = Date.now()
      if (status === "running" && row.status !== "pending") throw new Error(`Work item ${id} is not pending`)
      if (status === "blocked" && row.status !== "running")
        throw new Error(`Work item ${id} cannot block from ${row.status}`)
      if (status === "completed" && row.status !== "running") throw new Error(`Work item ${id} is not running`)
      if (status === "pending" && !["blocked", "failed"].includes(row.status))
        throw new Error(`Work item ${id} cannot retry from ${row.status}`)
      const attempt = status === "running" ? row.attempt + 1 : row.attempt
      if (status === "running" && attempt > row.max_attempts) throw new Error(`Work item ${id} exceeded max attempts`)
      if (status === "completed") {
        const artifact = yield* Effect.sync(() =>
          Database.use((db) =>
            db.select().from(CompanyArtifactTable).where(eq(CompanyArtifactTable.work_item_id, id)).get(),
          ),
        )
        if (!artifact) throw new Error(`Work item ${id} cannot complete without an artifact`)
      }
      if (status === "completed" || status === "blocked") {
        yield* facts.finalizeWorkItem({
          project_id: row.project_id,
          work_item_id: row.id,
          ordinal: row.attempt,
          status: status === "completed" ? "completed" : "failed",
          outcome: status === "completed" ? "completed" : "blocked",
          summary: status === "completed" ? `Work item ${row.id} completed` : (error ?? `Work item ${row.id} blocked`),
          failure_kind: status === "blocked" ? "unknown" : undefined,
          actor_id: row.owner_agent_id ?? undefined,
          receipt,
        })
      }
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.update(CompanyWorkItemTable)
            .set({
              status,
              attempt,
              max_attempts: status === "pending" ? Math.max(row.max_attempts, row.attempt + 1) : row.max_attempts,
              error: error ?? null,
              started_at: status === "running" ? now : row.started_at,
              completed_at: status === "completed" ? now : null,
              updated_at: now,
            })
            .where(eq(CompanyWorkItemTable.id, id))
            .run()
          if (status === "running")
            db.update(CompanyProjectAssignmentTable)
              .set({ status: "active", started_at: now })
              .where(
                and(
                  eq(CompanyProjectAssignmentTable.work_item_id, id),
                  eq(CompanyProjectAssignmentTable.status, "assigned"),
                ),
              )
              .run()
        }),
      )
      if (status === "running") {
        yield* facts.startAttempt({
          project_id: row.project_id,
          work_item_id: row.id,
          ordinal: attempt,
          actor_id: row.owner_agent_id ?? undefined,
        })
      }
      yield* event(row.project_id, `work_item.${status}`, { work_item_id: id, error }, row.owner_agent_id ?? undefined)
      return hydrateWorkItems([
        Database.use((db) => db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, id)).get())!,
      ])[0]!
    })

    const updateWorkItemFields = Effect.fn("CompanyProject.updateWorkItemFields")(function* (input: {
      id: string
      owner_agent_id?: string
      workflow_run_id?: string | null
      review_status?: "pending" | "running" | "accepted" | "rejected" | "not_required"
    }) {
      const current = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, input.id)).get()),
      )
      if (!current) throw new Error(`Company work item not found: ${input.id}`)
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(CompanyWorkItemTable)
            .set({
              ...(input.owner_agent_id !== undefined ? { owner_agent_id: input.owner_agent_id } : {}),
              ...(input.workflow_run_id !== undefined ? { workflow_run_id: input.workflow_run_id } : {}),
              ...(input.review_status !== undefined ? { review_status: input.review_status } : {}),
              updated_at: Date.now(),
            })
            .where(eq(CompanyWorkItemTable.id, input.id))
            .run(),
        ),
      )
      return hydrateWorkItems([
        Database.use((db) =>
          db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, input.id)).get(),
        )!,
      ])[0]!
    })

    const addArtifact = Effect.fn("CompanyProject.addArtifact")(function* (input: {
      project_id: string
      work_item_id?: string
      kind: string
      title: string
      path?: string
      content?: string
      evidence?: Record<string, unknown>
      created_by_agent_id?: string
    }) {
      const project = yield* get(input.project_id)
      if (!project) throw new Error(`Company project not found: ${input.project_id}`)
      const artifactPath = input.path ? path.resolve(project.output_dir, input.path) : undefined
      if (artifactPath && !AppFileSystem.contains(project.output_dir, artifactPath))
        throw new Error("Artifact path escapes project directory")
      if (artifactPath && input.content !== undefined)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(artifactPath), { recursive: true })
          await Bun.write(artifactPath, input.content!)
        })
      const id = Identifier.ascending("artifact")
      const row = {
        id,
        project_id: input.project_id,
        company_id: null,
        scope_type: "project" as const,
        private_owner_id: null,
        work_item_id: input.work_item_id ?? null,
        kind: input.kind,
        title: input.title,
        path: artifactPath ?? null,
        content: input.content ?? null,
        evidence_json: JSON.stringify(input.evidence ?? {}),
        created_by_agent_id: input.created_by_agent_id ?? null,
        created_at: Date.now(),
      }
      yield* Effect.sync(() => Database.use((db) => db.insert(CompanyArtifactTable).values(row).run()))
      yield* event(
        input.project_id,
        "artifact.created",
        { artifact_id: id, work_item_id: input.work_item_id, kind: input.kind, path: artifactPath },
        input.created_by_agent_id,
      )
      return artifactFromRow(row)
    })

    const listArtifacts = Effect.fn("CompanyProject.listArtifacts")(function* (project_id: string) {
      return (yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyArtifactTable)
            .where(eq(CompanyArtifactTable.project_id, project_id))
            .orderBy(asc(CompanyArtifactTable.created_at), asc(CompanyArtifactTable.id))
            .all(),
        ),
      )).map(artifactFromRow)
    })

    const listEvents = Effect.fn("CompanyProject.listEvents")(function* (project_id: string) {
      return (yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyProjectEventTable)
            .where(eq(CompanyProjectEventTable.project_id, project_id))
            .orderBy(asc(CompanyProjectEventTable.created_at), asc(CompanyProjectEventTable.id))
            .all(),
        ),
      )).map(eventFromRow)
    })

    const requestGate = Effect.fn("CompanyProject.requestGate")(function* (input: {
      project_id: string
      kind: GateKind
      title: string
      summary: string
      requested_by_agent_id?: string
      work_item_id?: string
      resource_scope?: string[]
      worktree_run_id?: string
    }) {
      if (input.kind === "founder_red") throw new Error("Founder red gates must be requested through Governance Service")
      const current = yield* get(input.project_id)
      if (!current) throw new Error(`Company project not found: ${input.project_id}`)
      if (["completed", "rejected", "blocked"].includes(current.status))
        throw new Error(`${input.kind} cannot be requested while project is ${current.status}`)
      if (input.kind === "merge_approval" && !input.worktree_run_id)
        throw new Error("Merge approval must belong to a worktree run")
      if (input.kind === "risk_approval" && (!input.work_item_id || !input.resource_scope?.length))
        throw new Error("Risk approval must belong to a WorkItem and resource scope")
      if (input.kind === "risk_approval") {
        const item = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select({
                project_id: CompanyWorkItemTable.project_id,
                resource_scope_json: CompanyWorkItemTable.resource_scope_json,
              })
              .from(CompanyWorkItemTable)
              .where(eq(CompanyWorkItemTable.id, input.work_item_id!))
              .get(),
          ),
        )
        if (!item || item.project_id !== input.project_id)
          throw new Error("Risk approval WorkItem does not belong to its project")
        if (item.resource_scope_json !== JSON.stringify(input.resource_scope))
          throw new Error("Risk approval resource scope differs from its WorkItem")
      }
      const pending = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyApprovalGateTable)
            .where(
              and(
                eq(CompanyApprovalGateTable.project_id, input.project_id),
                eq(CompanyApprovalGateTable.kind, input.kind),
                eq(CompanyApprovalGateTable.status, "pending"),
                input.kind === "risk_approval"
                  ? eq(CompanyApprovalGateTable.work_item_id, input.work_item_id!)
                  : input.worktree_run_id
                    ? eq(CompanyApprovalGateTable.worktree_run_id, input.worktree_run_id)
                    : undefined,
              ),
            )
            .get(),
        ),
      )
      if (pending) throw new Error(`Pending ${input.kind} already exists for project ${input.project_id}`)
      const id = Identifier.ascending("gate")
      const row = {
        id,
        project_id: input.project_id,
        company_id: current.company_id ?? null,
        scope_type: "project" as const,
        pre_project_id: null,
        decision_id: null,
        kind: input.kind,
        status: "pending" as const,
        title: input.title,
        summary: input.summary,
        requested_by_agent_id: input.requested_by_agent_id ?? null,
        requested_by_actor_kind: null,
        requested_by_actor_id: null,
        work_item_id: input.work_item_id ?? null,
        resource_scope_json: JSON.stringify(input.resource_scope ?? []),
        worktree_run_id: input.worktree_run_id ?? null,
        decision_note: null,
        requested_at: Date.now(),
        decided_at: null,
      }
      yield* Effect.sync(() => Database.use((db) => db.insert(CompanyApprovalGateTable).values(row).run()))
      if (current.status !== "awaiting_approval")
        yield* transition({
          id: input.project_id,
          status: "awaiting_approval",
          actor_id: input.requested_by_agent_id,
        })
      yield* event(
        input.project_id,
        "gate.requested",
        {
          gate_id: id,
          kind: input.kind,
          work_item_id: input.work_item_id,
          resource_scope: input.resource_scope,
        },
        input.requested_by_agent_id,
      )
      return gateFromRow(row)
    })

    const resolveGate = Effect.fn("CompanyProject.resolveGate")(function* (input: {
      id: string
      decision: "approve" | "reject"
      note?: string
    }) {
      const gate = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(CompanyApprovalGateTable).where(eq(CompanyApprovalGateTable.id, input.id)).get(),
        ),
      )
      if (!gate) throw new Error(`Approval gate not found: ${input.id}`)
      if (gate.status !== "pending") throw new Error(`Approval gate ${input.id} is already ${gate.status}`)
      if (!gate.project_id) throw new Error(`Founder approval gate ${input.id} must be resolved through Governance Service`)
      const projectID = gate.project_id
      if (gate.kind === "risk_approval" && input.decision === "approve") {
        const item = yield* Effect.sync(() =>
          Database.use((db) =>
            gate.work_item_id
              ? db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, gate.work_item_id)).get()
              : undefined,
          ),
        )
        const plan = item
          ? yield* Effect.sync(() =>
              Database.use((db) =>
                db.select().from(CompanyPlanTable).where(eq(CompanyPlanTable.id, item.plan_id)).get(),
              ),
            )
          : undefined
        if (
          !item ||
          item.project_id !== projectID ||
          item.resource_scope_json !== gate.resource_scope_json ||
          ["completed", "superseded", "cancelled"].includes(item.status) ||
          plan?.status !== "active"
        )
          throw new Error(`Risk approval ${gate.id} no longer matches an active WorkItem scope`)
      }
      const status = input.decision === "approve" ? "approved" : "rejected"
      const decided_at = Date.now()
      const updated = yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const current = db
              .select({ status: CompanyApprovalGateTable.status })
              .from(CompanyApprovalGateTable)
              .where(eq(CompanyApprovalGateTable.id, input.id))
              .get()
            if (current?.status !== "pending") return false
            db.update(CompanyApprovalGateTable)
              .set({ status, decision_note: input.note ?? null, decided_at })
              .where(eq(CompanyApprovalGateTable.id, input.id))
              .run()
            return true
          },
          { behavior: "immediate" },
        ),
      )
      if (!updated) throw new Error(`Approval gate ${input.id} was resolved concurrently`)
      if (gate.kind === "merge_approval" && gate.worktree_run_id)
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(CompanyWorktreeRunTable)
              .set({
                status: input.decision === "approve" ? "approved" : "review_rejected",
                updated_at: decided_at,
              })
              .where(eq(CompanyWorktreeRunTable.id, gate.worktree_run_id as string))
              .run(),
          ),
        )
      if (gate.kind === "risk_approval")
        yield* transition({
          id: projectID,
          status: input.decision === "reject" ? "rejected" : "executing",
          actor_id: "user",
          reason: input.note,
        })
      yield* event(
        projectID,
        "gate.resolved",
        { gate_id: input.id, kind: gate.kind, decision: input.decision, note: input.note },
        "user",
      )
      return gateFromRow({ ...gate, status, decision_note: input.note ?? null, decided_at })
    })

    const listGates = Effect.fn("CompanyProject.listGates")(function* (
      project_id?: string,
      status?: "pending" | "approved" | "rejected",
    ) {
      const conditions = [
        project_id
          ? eq(CompanyApprovalGateTable.project_id, project_id)
          : isNotNull(CompanyApprovalGateTable.project_id),
        status ? eq(CompanyApprovalGateTable.status, status) : undefined,
      ].filter((condition): condition is NonNullable<typeof condition> => !!condition)
      return (yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyApprovalGateTable)
            .where(conditions.length ? and(...conditions) : undefined)
            .orderBy(desc(CompanyApprovalGateTable.requested_at))
            .all(),
        ),
      )).map(gateFromRow)
    })

    const initRepository = Effect.fn("CompanyProject.initRepository")(function* (project_id: string) {
      const project = yield* get(project_id)
      if (!project) throw new Error(`Company project not found: ${project_id}`)
      const charter = yield* getCharter(project_id)
      if (!charter?.policy.allow_workspace_write) throw new Error("Project Charter does not allow repository creation")
      const repo = path.join(project.output_dir, "repo")
      yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
      if (!(yield* Effect.promise(() => Bun.file(path.join(repo, ".git", "HEAD")).exists()))) {
        const process = Bun.spawn(["git", "init", "--initial-branch=main"], {
          cwd: repo,
          stdout: "pipe",
          stderr: "pipe",
        })
        const code = yield* Effect.promise(() => process.exited)
        if (code !== 0)
          throw new Error(
            `Failed to initialize project repository: ${yield* Effect.promise(() => new Response(process.stderr).text())}`,
          )
      }
      yield* event(project_id, "repository.created", { path: repo }, "system")
      return repo
    })

    const getWorktreeRun = Effect.fn("CompanyProject.getWorktreeRun")(function* (id: string) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(CompanyWorktreeRunTable).where(eq(CompanyWorktreeRunTable.id, id)).get()),
      )
      return row ? worktreeRunFromRow(row) : undefined
    })

    const listWorktreeRuns = Effect.fn("CompanyProject.listWorktreeRuns")(function* (project_id: string) {
      return (yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyWorktreeRunTable)
            .where(eq(CompanyWorktreeRunTable.project_id, project_id))
            .orderBy(asc(CompanyWorktreeRunTable.created_at), asc(CompanyWorktreeRunTable.id))
            .all(),
        ),
      )).map(worktreeRunFromRow)
    })

    const git = (cwd: string, args: string[]) =>
      Effect.promise(async () => {
        const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        return { code, output: `${stdout}\n${stderr}`.trim() }
      })

    const sandboxPath = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')

    const command = (cwd: string, value: string, writeScope: string[] = []) =>
      Effect.promise(async () => {
        const sandbox = process.platform === "darwin" ? Bun.which("sandbox-exec") : Bun.which("bwrap")
        if (!sandbox)
          return {
            command: value,
            code: 126,
            output: `Verification sandbox is unavailable on ${process.platform}`,
          }
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-company-sandbox-"))
        const home = path.join(root, "home")
        const tmp = path.join(root, "tmp")
        await Promise.all([fs.mkdir(home), fs.mkdir(tmp)])
        const writablePaths = writeScope.map((scope) => path.resolve(scope ? path.join(cwd, scope) : cwd))
        const linuxSystemBinds =
          process.platform === "linux"
            ? (
                await Promise.all(
                  ["/lib", "/lib64"].map((directory) =>
                    fs.access(directory).then(
                      () => ["--ro-bind", directory, directory],
                      () => [],
                    ),
                  ),
                )
              ).flat()
            : []
        const args =
          process.platform === "darwin"
            ? [
                "-p",
                [
                  "(version 1)",
                  "(deny default)",
                  "(allow process*)",
                  "(allow signal (target self))",
                  "(allow sysctl-read)",
                  "(allow mach-lookup)",
                  `(allow file-read* (literal "/") (subpath "${sandboxPath(cwd)}") (subpath "/System") (subpath "/Library") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "${sandboxPath(path.dirname(process.execPath))}"))`,
                  `(allow file-write* (subpath "${sandboxPath(root)}"))`,
                  ...writablePaths.flatMap((target) => [
                    `(allow file-write* (literal "${sandboxPath(target)}"))`,
                    `(allow file-write* (subpath "${sandboxPath(target)}"))`,
                  ]),
                  "(deny network*)",
                ].join("\n"),
                "/bin/sh",
                "-lc",
                value,
              ]
            : [
                "--die-with-parent",
                "--new-session",
                "--unshare-all",
                "--clearenv",
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--ro-bind",
                "/usr",
                "/usr",
                "--ro-bind",
                "/bin",
                "/bin",
                ...linuxSystemBinds,
                "--dir",
                "/opt",
                "--dir",
                "/opt/agent-company",
                "--ro-bind",
                process.execPath,
                "/opt/agent-company/bun",
                "--ro-bind",
                cwd,
                "/workspace",
                "--bind",
                root,
                "/sandbox",
                ...writablePaths.flatMap((target) => [
                  "--bind",
                  target,
                  target === path.resolve(cwd)
                    ? "/workspace"
                    : `/workspace/${path.relative(cwd, target).split(path.sep).join("/")}`,
                ]),
                "--chdir",
                "/workspace",
                "--setenv",
                "HOME",
                "/sandbox/home",
                "--setenv",
                "TMPDIR",
                "/sandbox/tmp",
                "--setenv",
                "PATH",
                "/opt/agent-company:/usr/bin:/bin",
                "/bin/sh",
                "-lc",
                value,
              ]
        const child = Bun.spawn([sandbox, ...args], {
          cwd,
          env: {
            HOME: home,
            TMPDIR: tmp,
            PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            CI: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        })
        const timeoutState = { expired: false }
        const timeout = setTimeout(() => {
          timeoutState.expired = true
          child.kill("SIGKILL")
        }, 15 * 60_000)
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        clearTimeout(timeout)
        await fs.rm(root, { recursive: true, force: true })
        return {
          command: value,
          code,
          output: `${stdout}\n${stderr}${timeoutState.expired ? "\nVerification command exceeded 15 minutes" : ""}`
            .trim()
            .slice(-8000),
        }
      })

    const changedPaths = (cwd: string) =>
      Effect.gen(function* () {
        const [tracked, untracked] = yield* Effect.all([
          git(cwd, ["diff", "--no-renames", "--name-only", "-z", "HEAD"]),
          git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
        ])
        if (tracked.code !== 0 || untracked.code !== 0)
          throw new Error(`Failed to inspect worktree changes: ${tracked.output || untracked.output}`)
        return [...new Set(`${tracked.output}\0${untracked.output}`.split("\0").filter(Boolean))].sort()
      })

    const allowedWorktreePaths = (
      current: Pick<WorktreeRun, "repository_path" | "directory">,
      scopes: string[],
      outputDir: string,
    ) =>
      scopes.map((scope) => {
        if (scope.includes("*") || scope.includes("?") || scope.includes("["))
          throw new Error(`Resource scope must be an exact path or directory: ${scope}`)
        const repository = path.resolve(current.repository_path)
        const worktree = path.resolve(current.directory)
        const absolute = path.resolve(path.isAbsolute(scope) ? scope : path.join(repository, scope))
        const relative =
          absolute === path.resolve(outputDir)
            ? ""
            : absolute === repository || absolute.startsWith(`${repository}${path.sep}`)
              ? path.relative(repository, absolute)
              : absolute === worktree || absolute.startsWith(`${worktree}${path.sep}`)
                ? path.relative(worktree, absolute)
                : undefined
        if (relative === undefined || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          throw new Error(`Resource scope exceeds repository boundary: ${scope}`)
        return relative.split(path.sep).join("/")
      })

    const outOfScopePaths = (paths: string[], scopes: string[]) =>
      paths.filter(
        (candidate) =>
          !scopes.some(
            (scope) => !scope || candidate === scope || candidate.startsWith(`${scope.replace(/\/+$/, "")}/`),
          ),
      )

    const updateWorktreeRun = Effect.fn("CompanyProject.updateWorktreeRun")(function* (input: {
      id: string
      status: WorktreeRunStatus
      agent_run_id?: string
      head_commit?: string
      verification_commands?: string[]
      verification?: Record<string, unknown>
      review?: Record<string, unknown>
      merge_gate_id?: string
      error?: string
      merged_at?: number
    }) {
      if (!(yield* getWorktreeRun(input.id))) throw new Error(`Company worktree run not found: ${input.id}`)
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(CompanyWorktreeRunTable)
            .set({
              status: input.status,
              agent_run_id: input.agent_run_id,
              head_commit: input.head_commit,
              verification_commands_json: input.verification_commands
                ? JSON.stringify(input.verification_commands)
                : undefined,
              verification_json: input.verification ? JSON.stringify(input.verification) : undefined,
              review_json: input.review ? JSON.stringify(input.review) : undefined,
              merge_gate_id: input.merge_gate_id,
              error: input.error,
              merged_at: input.merged_at,
              updated_at: Date.now(),
            })
            .where(eq(CompanyWorktreeRunTable.id, input.id))
            .run(),
        ),
      )
      return (yield* getWorktreeRun(input.id))!
    })

    const createWorktreeRun = Effect.fn("CompanyProject.createWorktreeRun")(function* (input: {
      project_id: string
      work_item_id?: string
      agent_run_id?: string
    }) {
      const project = yield* get(input.project_id)
      if (!project) throw new Error(`Company project not found: ${input.project_id}`)
      const charter = yield* getCharter(input.project_id)
      if (!charter) throw new Error("Project Charter is required before creating a worktree run")
      if (!charter.policy.allow_workspace_write) throw new Error("Project Charter does not allow a writable worktree")
      const repository_path = yield* initRepository(input.project_id)
      const initial = yield* git(repository_path, ["rev-parse", "HEAD"])
      if (initial.code !== 0) {
        const committed = yield* git(repository_path, [
          "-c",
          "user.name=AgentCompany",
          "-c",
          "user.email=agentcompany@local",
          "commit",
          "--allow-empty",
          "-m",
          "Initialize Agent Company project",
        ])
        if (committed.code !== 0) throw new Error(`Failed to initialize project history: ${committed.output}`)
      }
      const base = yield* git(repository_path, ["rev-parse", "HEAD"])
      if (base.code !== 0) throw new Error(`Failed to resolve project base commit: ${base.output}`)
      const id = Identifier.ascending("worktreeRun")
      const directory = path.join(project.output_dir, "worktrees", id)
      const branch = `agent-company/${id}`
      const now = Date.now()
      const row = {
        id,
        project_id: input.project_id,
        work_item_id: input.work_item_id ?? null,
        agent_run_id: input.agent_run_id ?? null,
        status: "preparing",
        repository_path,
        directory,
        branch,
        base_commit: base.output,
        head_commit: null,
        verification_commands_json: "[]",
        verification_json: "{}",
        review_json: "{}",
        merge_gate_id: null,
        error: null,
        created_at: now,
        updated_at: now,
        merged_at: null,
      }
      yield* Effect.sync(() => Database.use((db) => db.insert(CompanyWorktreeRunTable).values(row).run()))
      yield* Effect.promise(() => fs.mkdir(path.dirname(directory), { recursive: true }))
      const created = yield* git(repository_path, ["worktree", "add", "-b", branch, directory, "main"])
      if (created.code !== 0) {
        yield* updateWorktreeRun({ id, status: "failed", error: created.output })
        throw new Error(`Failed to create project worktree: ${created.output}`)
      }
      const ready = yield* updateWorktreeRun({ id, status: "ready" })
      yield* event(input.project_id, "worktree_run.created", { worktree_run_id: id, branch, directory })
      return ready
    })

    const startWorktreeRun = Effect.fn("CompanyProject.startWorktreeRun")(function* (input: {
      id: string
      agent_run_id?: string
    }) {
      const current = yield* getWorktreeRun(input.id)
      if (!current) throw new Error(`Company worktree run not found: ${input.id}`)
      if (current.status !== "ready") throw new Error(`Worktree run ${input.id} is not ready`)
      const started = yield* updateWorktreeRun({ id: input.id, status: "running", agent_run_id: input.agent_run_id })
      yield* event(started.project_id, "worktree_run.started", { worktree_run_id: started.id }, started.agent_run_id)
      return started
    })

    const verifyWorktreeRun = Effect.fn("CompanyProject.verifyWorktreeRun")(function* (input: {
      id: string
      commands: string[]
    }) {
      const current = yield* getWorktreeRun(input.id)
      if (!current) throw new Error(`Company worktree run not found: ${input.id}`)
      if (current.status !== "running") throw new Error(`Worktree run ${input.id} is not running`)
      if (!input.commands.length) throw new Error("At least one verification command is required")
      if (!current.work_item_id) throw new Error(`Worktree run ${input.id} has no WorkItem`)
      const scope = yield* Effect.sync(() =>
        Database.use((db) => {
          const item = db
            .select()
            .from(CompanyWorkItemTable)
            .where(eq(CompanyWorkItemTable.id, current.work_item_id!))
            .get()
          const project = db
            .select({ output_dir: CompanyProjectTable.output_dir })
            .from(CompanyProjectTable)
            .where(eq(CompanyProjectTable.id, current.project_id))
            .get()
          const assignment = db
            .select()
            .from(CompanyProjectAssignmentTable)
            .where(
              and(
                eq(CompanyProjectAssignmentTable.project_id, current.project_id),
                eq(CompanyProjectAssignmentTable.work_item_id, current.work_item_id!),
                inArray(CompanyProjectAssignmentTable.status, ["assigned", "active"]),
              ),
            )
            .orderBy(desc(CompanyProjectAssignmentTable.assigned_at))
            .get()
          if (!item || !assignment || !project) throw new Error(`Worktree run ${input.id} has no active Assignment`)
          const itemScope = parseList(item.resource_scope_json)
          const assignmentScope = parseList(assignment.resource_scope_json)
          if (JSON.stringify(itemScope) !== JSON.stringify(assignmentScope))
            throw new Error(`Worktree run ${input.id} Assignment scope differs from its WorkItem`)
          return allowedWorktreePaths(current, itemScope, project.output_dir)
        }),
      )
      const existingOutOfScope = outOfScopePaths(yield* changedPaths(current.directory), scope)
      if (existingOutOfScope.length)
        throw new Error(`Worktree has changes outside its Assignment scope: ${existingOutOfScope.join(", ")}`)
      yield* updateWorktreeRun({ id: input.id, status: "verifying" })
      const results = yield* Effect.forEach(input.commands, (item) => command(current.directory, item, scope))
      const failed = results.find((item) => item.code !== 0)
      if (!failed) {
        const paths = yield* changedPaths(current.directory)
        const outside = outOfScopePaths(paths, scope)
        if (outside.length) {
          const error = `Verification changed paths outside its Assignment scope: ${outside.join(", ")}`
          const failedRun = yield* updateWorktreeRun({
            id: input.id,
            status: "failed",
            verification_commands: input.commands,
            verification: { passed: false, worktree: results },
            error,
          })
          yield* event(current.project_id, "worktree_run.verification_failed", {
            worktree_run_id: current.id,
            error,
          })
          return failedRun
        }
        const dirty = yield* git(current.directory, ["status", "--porcelain"])
        if (dirty.code !== 0) {
          const failedRun = yield* updateWorktreeRun({
            id: input.id,
            status: "failed",
            verification_commands: input.commands,
            verification: { passed: false, worktree: results },
            error: dirty.output,
          })
          yield* event(current.project_id, "worktree_run.verification_failed", {
            worktree_run_id: current.id,
            error: dirty.output,
          })
          return failedRun
        }
        if (dirty.output) {
          const staged = yield* git(current.directory, ["add", "--", ...paths])
          const committed =
            staged.code === 0
              ? yield* git(current.directory, [
                  "-c",
                  "user.name=AgentCompany",
                  "-c",
                  "user.email=agentcompany@local",
                  "commit",
                  "-m",
                  `AgentCompany delivery ${current.work_item_id}`,
                ])
              : staged
          if (committed.code !== 0) {
            const failedRun = yield* updateWorktreeRun({
              id: input.id,
              status: "failed",
              verification_commands: input.commands,
              verification: { passed: false, worktree: results },
              error: committed.output,
            })
            yield* event(current.project_id, "worktree_run.verification_failed", {
              worktree_run_id: current.id,
              error: committed.output,
            })
            return failedRun
          }
        }
      }
      const head = yield* git(current.directory, ["rev-parse", "HEAD"])
      if (!failed && head.code === 0) {
        const verified = yield* updateWorktreeRun({
          id: input.id,
          status: "awaiting_merge_approval",
          head_commit: head.output,
          verification_commands: input.commands,
          verification: { passed: true, worktree: results },
        })
        yield* event(current.project_id, "worktree_run.verified", { worktree_run_id: current.id, results })
        return verified
      }
      const error = failed ? `${failed.command}\n${failed.output}` : head.output
      const failedRun = yield* updateWorktreeRun({
        id: input.id,
        status: "failed",
        verification_commands: input.commands,
        verification: { passed: false, worktree: results },
        error,
      })
      yield* event(current.project_id, "worktree_run.verification_failed", { worktree_run_id: current.id, error })
      return failedRun
    })

    const requestMergeApproval = Effect.fn("CompanyProject.requestMergeApproval")(function* (input: {
      id: string
      title: string
      summary: string
      requested_by_agent_id?: string
      review?: Record<string, unknown>
    }) {
      const current = yield* getWorktreeRun(input.id)
      if (!current) throw new Error(`Company worktree run not found: ${input.id}`)
      if (current.status !== "awaiting_merge_approval")
        throw new Error(`Worktree run ${input.id} is not ready for merge approval`)
      const gate = yield* requestGate({
        project_id: current.project_id,
        kind: "merge_approval",
        title: input.title,
        summary: input.summary,
        requested_by_agent_id: input.requested_by_agent_id,
        worktree_run_id: input.id,
      })
      yield* updateWorktreeRun({
        id: input.id,
        status: "awaiting_merge_approval",
        merge_gate_id: gate.id,
        review: input.review,
      })
      return gate
    })

    const mergeWorktreeRun = Effect.fn("CompanyProject.mergeWorktreeRun")(function* (id: string) {
      const current = yield* getWorktreeRun(id)
      if (!current) throw new Error(`Company worktree run not found: ${id}`)
      if (current.status !== "approved") throw new Error(`Worktree run ${id} is not approved for merge`)
      const charter = yield* getCharter(current.project_id)
      if (!charter) throw new Error("Project Charter is missing")
      const clean = yield* git(current.directory, ["status", "--porcelain"])
      if (clean.code !== 0) throw new Error(`Failed to inspect worktree: ${clean.output}`)
      if (charter.policy.require_clean_worktree && clean.output) {
        yield* updateWorktreeRun({ id, status: "failed", error: `Worktree has uncommitted changes:\n${clean.output}` })
        throw new Error(`Worktree has uncommitted changes:\n${clean.output}`)
      }
      const merged = yield* git(current.repository_path, ["merge", "--no-ff", "--no-edit", current.branch])
      if (merged.code !== 0) {
        yield* updateWorktreeRun({ id, status: "failed", error: merged.output })
        throw new Error(`Failed to merge worktree branch: ${merged.output}`)
      }
      const verificationDirectory = path.join(path.dirname(current.directory), `${current.id}-merged-verification`)
      const prepared = charter.policy.require_main_branch_verification
        ? yield* git(current.repository_path, ["worktree", "add", "--detach", verificationDirectory, "HEAD"])
        : undefined
      if (prepared && prepared.code !== 0)
        throw new Error(`Failed to create isolated main verification worktree: ${prepared.output}`)
      const mainResults = charter.policy.require_main_branch_verification
        ? yield* Effect.forEach(current.verification_commands, (item) => command(verificationDirectory, item))
        : []
      if (prepared) yield* git(current.repository_path, ["worktree", "remove", "--force", verificationDirectory])
      const failed = mainResults.find((item) => item.code !== 0)
      if (failed) {
        yield* updateWorktreeRun({
          id,
          status: "failed",
          verification: { ...current.verification, main: mainResults },
          error: `${failed.command}\n${failed.output}`,
        })
        throw new Error(`Main branch verification failed: ${failed.command}\n${failed.output}`)
      }
      const head = yield* git(current.repository_path, ["rev-parse", "HEAD"])
      if (head.code !== 0) throw new Error(`Failed to resolve merged commit: ${head.output}`)
      const completed = yield* updateWorktreeRun({
        id,
        status: "merged",
        head_commit: head.output,
        verification: { ...current.verification, main: mainResults },
        merged_at: Date.now(),
      })
      yield* event(current.project_id, "worktree_run.merged", { worktree_run_id: id, head_commit: head.output })
      return completed
    })

    return Service.of({
      create,
      get,
      findBySourceThread,
      findByDecisionRequest,
      list,
      createCharter,
      getCharter,
      transition,
      setActiveRun,
      setModel,
      createPlan,
      listPlans,
      createWorkItem,
      setWorkItemSourceTaskKey,
      reworkRejectedReview,
      listWorkItems,
      readyWorkItems,
      startWorkItem: (id) => updateWorkItem(id, "running"),
      assignWorkItem,
      setWorkItemRun: (input) => updateWorkItemFields({ id: input.id, workflow_run_id: input.workflow_run_id ?? null }),
      setWorkItemReview: (input) => updateWorkItemFields({ id: input.id, review_status: input.review_status }),
      blockWorkItem: (input) => updateWorkItem(input.id, "blocked", input.error),
      retryWorkItem: (id) => updateWorkItem(id, "pending"),
      completeWorkItem: (id) => updateWorkItem(id, "completed"),
      completeWorkItemWithReceipt: (input) => updateWorkItem(input.id, "completed", undefined, input.receipt),
      createWorktreeRun,
      getWorktreeRun,
      listWorktreeRuns,
      startWorktreeRun,
      verifyWorktreeRun,
      requestMergeApproval,
      mergeWorktreeRun,
      addArtifact,
      listArtifacts,
      listWorkAttempts: facts.listAttempts,
      listWorkReceipts: facts.listReceipts,
      listEvents,
      requestGate,
      resolveGate,
      listGates,
      recordEvent: (input) => event(input.project_id, input.type, input.data ?? {}, input.actor_id),
      initRepository,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Company.defaultLayer),
  Layer.provide(CompanyWorkFacts.defaultLayer),
)

export const recoveryControlledLayer = layer.pipe(
  Layer.provide(Company.defaultLayer),
  Layer.provide(CompanyWorkFacts.makeLayer({ recoverOnStart: false })),
)

export * as CompanyProject from "./company-project"
