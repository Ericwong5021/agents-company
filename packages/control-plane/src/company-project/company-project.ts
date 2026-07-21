import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm"
import { Database } from "@/storage"
import { Global } from "@/global"
import { Identifier } from "@/id/id"
import { AppFileSystem } from "@agents-company/shared/filesystem"
import {
  CompanyApprovalGateTable,
  CompanyArtifactTable,
  CompanyPlanTable,
  CompanyProjectCharterTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
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
  type PlanPhase,
  type ProjectStatus,
  WorkItem,
  WorktreeRun,
  type WorktreeRunStatus,
} from "./schema"

const parseList = (value: string) => JSON.parse(value) as string[]
const parseRecord = (value: string) => JSON.parse(value) as Record<string, unknown>
const projectFromRow = (row: typeof CompanyProjectTable.$inferSelect) =>
  Project.parse({
    ...row,
    owner_agent_id: row.owner_agent_id ?? undefined,
    coordinator_session_id: row.coordinator_session_id ?? undefined,
    provider_id: row.provider_id ?? undefined,
    model_id: row.model_id ?? undefined,
    active_run_id: row.active_run_id ?? undefined,
    active_plan_version: row.active_plan_version ?? undefined,
    completed_at: row.completed_at ?? undefined,
  })
const planFromRow = (row: typeof CompanyPlanTable.$inferSelect) =>
  Plan.parse({
    ...row,
    assumptions: parseList(row.assumptions_json),
    acceptance_criteria: parseList(row.acceptance_criteria_json),
    change_reason: row.change_reason ?? undefined,
  })
const workItemFromRow = (row: typeof CompanyWorkItemTable.$inferSelect) =>
  WorkItem.parse({
    ...row,
    parent_id: row.parent_id ?? undefined,
    owner_agent_id: row.owner_agent_id ?? undefined,
    workflow_run_id: row.workflow_run_id ?? undefined,
    capability_packs: parseList(row.capability_packs_json),
    decision_scope: parseList(row.decision_scope_json),
    resource_scope: parseList(row.resource_scope_json),
    acceptance_criteria: parseList(row.acceptance_criteria_json),
    error: row.error ?? undefined,
    started_at: row.started_at ?? undefined,
    completed_at: row.completed_at ?? undefined,
  })
const artifactFromRow = (row: typeof CompanyArtifactTable.$inferSelect) =>
  Artifact.parse({
    ...row,
    work_item_id: row.work_item_id ?? undefined,
    path: row.path ?? undefined,
    content: row.content ?? undefined,
    evidence: parseRecord(row.evidence_json),
    created_by_agent_id: row.created_by_agent_id ?? undefined,
  })
const gateFromRow = (row: typeof CompanyApprovalGateTable.$inferSelect) =>
  ApprovalGate.parse({
    ...row,
    requested_by_agent_id: row.requested_by_agent_id ?? undefined,
    worktree_run_id: row.worktree_run_id ?? undefined,
    decision_note: row.decision_note ?? undefined,
    decided_at: row.decided_at ?? undefined,
  })
const charterFromRow = (row: typeof CompanyProjectCharterTable.$inferSelect) =>
  ProjectCharter.parse({
    ...row,
    scope: parseList(row.scope_json),
    success_criteria: parseList(row.success_criteria_json),
    constraints: parseList(row.constraints_json),
    acceptance_criteria: parseList(row.acceptance_criteria_json),
    policy: parseRecord(row.policy_json),
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
    goal: string
    title?: string
    owner_agent_id?: string
    coordinator_session_id?: string
    provider_id?: string
    model_id?: string
  }) => Effect.Effect<Project>
  readonly get: (id: string) => Effect.Effect<Project | undefined>
  readonly list: () => Effect.Effect<Project[]>
  readonly createCharter: (input: {
    project_id: string
    scope: string[]
    success_criteria: string[]
    constraints?: string[]
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
    parent_id?: string
    title: string
    description: string
    kind: "planner" | "worker" | "reviewer"
    work_type: "coding" | "decision" | "research" | "writing" | "design" | "analysis"
    role: string
    capability_packs?: string[]
    decision_scope?: string[]
    resource_scope?: string[]
    model_group: "ultra" | "standard" | "lite"
    risk_level?: "low" | "medium" | "high"
    review_status?: "pending" | "running" | "accepted" | "rejected" | "not_required"
    owner_agent_id?: string
    acceptance_criteria: string[]
    max_attempts?: number
    depends_on?: string[]
  }) => Effect.Effect<WorkItem>
  readonly listWorkItems: (project_id: string) => Effect.Effect<WorkItem[]>
  readonly readyWorkItems: (project_id: string) => Effect.Effect<WorkItem[]>
  readonly startWorkItem: (id: string) => Effect.Effect<WorkItem>
  readonly assignWorkItem: (input: { id: string; owner_agent_id: string }) => Effect.Effect<WorkItem>
  readonly setWorkItemRun: (input: { id: string; workflow_run_id?: string }) => Effect.Effect<WorkItem>
  readonly setWorkItemReview: (input: {
    id: string
    review_status: "pending" | "running" | "accepted" | "rejected" | "not_required"
  }) => Effect.Effect<WorkItem>
  readonly blockWorkItem: (input: { id: string; error: string }) => Effect.Effect<WorkItem>
  readonly retryWorkItem: (id: string) => Effect.Effect<WorkItem>
  readonly completeWorkItem: (id: string) => Effect.Effect<WorkItem>
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
  readonly requestGate: (input: {
    project_id: string
    kind: GateKind
    title: string
    summary: string
    requested_by_agent_id?: string
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

    const create = Effect.fn("CompanyProject.create")(function* (input: {
      goal: string
      title?: string
      owner_agent_id?: string
      coordinator_session_id?: string
      provider_id?: string
      model_id?: string
    }) {
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
              goal: input.goal,
              title: input.title ?? input.goal.slice(0, 80),
              status: "intake",
              owner_agent_id: input.owner_agent_id ?? null,
              coordinator_session_id: input.coordinator_session_id ?? null,
              provider_id: input.provider_id ?? null,
              model_id: input.model_id ?? null,
              active_run_id: null,
              output_dir,
              created_at: now,
              updated_at: now,
            })
            .run(),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(output_dir, "project.json"),
          JSON.stringify({ id, goal: input.goal, created_at: now }, null, 2) + "\n",
        ),
      )
      yield* event(id, "project.created", { goal: input.goal }, input.owner_agent_id)
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
          db.select().from(CompanyProjectCharterTable).where(eq(CompanyProjectCharterTable.project_id, project_id)).get(),
        ),
      )
      return row ? charterFromRow(row) : undefined
    })

    const createCharter = Effect.fn("CompanyProject.createCharter")(function* (input: {
      project_id: string
      scope: string[]
      success_criteria: string[]
      constraints?: string[]
      acceptance_criteria: string[]
      policy?: DeliveryPolicy
    }) {
      if (!(yield* get(input.project_id))) throw new Error(`Company project not found: ${input.project_id}`)
      const now = Date.now()
      const policy = DeliveryPolicy.parse(
        input.policy ?? {
          source_approval_preset: "balanced",
          allow_workspace_write: true,
          require_high_risk_approval: true,
          require_human_merge: true,
          require_clean_worktree: true,
          require_main_branch_verification: true,
        },
      )
      const row = {
        project_id: input.project_id,
        scope_json: JSON.stringify(input.scope),
        success_criteria_json: JSON.stringify(input.success_criteria),
        constraints_json: JSON.stringify(input.constraints ?? []),
        acceptance_criteria_json: JSON.stringify(input.acceptance_criteria),
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
                scope_json: row.scope_json,
                success_criteria_json: row.success_criteria_json,
                constraints_json: row.constraints_json,
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

    const createWorkItem = Effect.fn("CompanyProject.createWorkItem")(function* (input: {
      project_id: string
      plan_id: string
      parent_id?: string
      title: string
      description: string
      kind: "planner" | "worker" | "reviewer"
      work_type: "coding" | "decision" | "research" | "writing" | "design" | "analysis"
      role: string
      capability_packs?: string[]
      decision_scope?: string[]
      resource_scope?: string[]
      model_group: "ultra" | "standard" | "lite"
      risk_level?: "low" | "medium" | "high"
      review_status?: "pending" | "running" | "accepted" | "rejected" | "not_required"
      owner_agent_id?: string
      acceptance_criteria: string[]
      max_attempts?: number
      depends_on?: string[]
    }) {
      const id = Identifier.ascending("companyWorkItem")
      const now = Date.now()
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.insert(CompanyWorkItemTable)
            .values({
              id,
              project_id: input.project_id,
              plan_id: input.plan_id,
              parent_id: input.parent_id ?? null,
              title: input.title,
              description: input.description,
              kind: input.kind,
              work_type: input.work_type,
              role: input.role,
              capability_packs_json: JSON.stringify(input.capability_packs ?? []),
              decision_scope_json: JSON.stringify(input.decision_scope ?? []),
              resource_scope_json: JSON.stringify(input.resource_scope ?? []),
              model_group: input.model_group,
              risk_level: input.risk_level ?? "medium",
              review_status: input.review_status ?? (input.kind === "worker" ? "pending" : "not_required"),
              status: "pending",
              owner_agent_id: input.owner_agent_id ?? null,
              workflow_run_id: null,
              acceptance_criteria_json: JSON.stringify(input.acceptance_criteria),
              max_attempts: input.max_attempts ?? 3,
              created_at: now,
              updated_at: now,
            })
            .run()
          if (input.depends_on?.length)
            db.insert(CompanyWorkItemDependencyTable)
              .values(input.depends_on.map((depends_on_id) => ({ work_item_id: id, depends_on_id })))
              .run()
        }),
      )
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
          decision_scope: input.decision_scope ?? [],
          resource_scope: input.resource_scope ?? [],
          depends_on: input.depends_on ?? [],
        },
        input.owner_agent_id,
      )
      return workItemFromRow(
        Database.use((db) => db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, id)).get())!,
      )
    })

    const listWorkItems = Effect.fn("CompanyProject.listWorkItems")(function* (project_id: string) {
      return (yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyWorkItemTable)
            .where(eq(CompanyWorkItemTable.project_id, project_id))
            .orderBy(asc(CompanyWorkItemTable.created_at))
            .all(),
        ),
      )).map(workItemFromRow)
    })

    const readyWorkItems = Effect.fn("CompanyProject.readyWorkItems")(function* (project_id: string) {
      const pending = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyWorkItemTable)
            .where(and(eq(CompanyWorkItemTable.project_id, project_id), eq(CompanyWorkItemTable.status, "pending")))
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
            .all(),
        ),
      )
      const incomplete = new Set(
        (yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select({ id: CompanyWorkItemTable.id })
              .from(CompanyWorkItemTable)
              .where(notInArray(CompanyWorkItemTable.status, ["completed", "cancelled"]))
              .all(),
          ),
        )).map((item) => item.id),
      )
      const blocked = new Set(
        dependencies
          .filter((dependency) => incomplete.has(dependency.depends_on_id))
          .map((dependency) => dependency.work_item_id),
      )
      return pending.filter((item) => !blocked.has(item.id)).map(workItemFromRow)
    })

    const updateWorkItem = Effect.fn("CompanyProject.updateWorkItem")(function* (
      id: string,
      status: "running" | "blocked" | "pending" | "completed",
      error?: string,
    ) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, id)).get()),
      )
      if (!row) throw new Error(`Company work item not found: ${id}`)
      const now = Date.now()
      if (status === "running" && row.status !== "pending") throw new Error(`Work item ${id} is not pending`)
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
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(CompanyWorkItemTable)
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
            .run(),
        ),
      )
      yield* event(row.project_id, `work_item.${status}`, { work_item_id: id, error }, row.owner_agent_id ?? undefined)
      return workItemFromRow(
        Database.use((db) => db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, id)).get())!,
      )
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
      return workItemFromRow(
        Database.use((db) => db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, input.id)).get())!,
      )
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
            .orderBy(asc(CompanyArtifactTable.created_at))
            .all(),
        ),
      )).map(artifactFromRow)
    })

    const requestGate = Effect.fn("CompanyProject.requestGate")(function* (input: {
      project_id: string
      kind: GateKind
      title: string
      summary: string
      requested_by_agent_id?: string
      worktree_run_id?: string
    }) {
      const current = yield* get(input.project_id)
      if (!current) throw new Error(`Company project not found: ${input.project_id}`)
      if (["completed", "rejected", "blocked"].includes(current.status))
        throw new Error(`${input.kind} cannot be requested while project is ${current.status}`)
      if (input.kind === "merge_approval" && !input.worktree_run_id)
        throw new Error("Merge approval must belong to a worktree run")
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
        kind: input.kind,
        status: "pending" as const,
        title: input.title,
        summary: input.summary,
        requested_by_agent_id: input.requested_by_agent_id ?? null,
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
      yield* event(input.project_id, "gate.requested", { gate_id: id, kind: input.kind }, input.requested_by_agent_id)
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
          id: gate.project_id,
          status: input.decision === "reject" ? "rejected" : "executing",
          actor_id: "user",
          reason: input.note,
        })
      yield* event(
        gate.project_id,
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
        project_id ? eq(CompanyApprovalGateTable.project_id, project_id) : undefined,
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
      if (!charter?.policy.allow_workspace_write)
        throw new Error("Project Charter does not allow repository creation")
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
            .orderBy(asc(CompanyWorktreeRunTable.created_at))
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

    const command = (cwd: string, value: string) =>
      Effect.promise(async () => {
        const args = process.platform === "win32" ? ["cmd", "/c", value] : ["/bin/sh", "-lc", value]
        const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        return { command: value, code, output: `${stdout}\n${stderr}`.trim().slice(-8000) }
      })

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
      if (!charter.policy.allow_workspace_write)
        throw new Error("Project Charter does not allow a writable worktree")
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
      yield* updateWorktreeRun({ id: input.id, status: "verifying" })
      const results = yield* Effect.forEach(input.commands, (item) => command(current.directory, item))
      const failed = results.find((item) => item.code !== 0)
      if (!failed) {
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
          const staged = yield* git(current.directory, ["add", "--all"])
          const committed = staged.code === 0
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
      const mainResults = charter.policy.require_main_branch_verification
        ? yield* Effect.forEach(current.verification_commands, (item) => command(current.repository_path, item))
        : []
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
      list,
      createCharter,
      getCharter,
      transition,
      setActiveRun,
      setModel,
      createPlan,
      listPlans,
      createWorkItem,
      listWorkItems,
      readyWorkItems,
      startWorkItem: (id) => updateWorkItem(id, "running"),
      assignWorkItem: (input) => updateWorkItemFields({ id: input.id, owner_agent_id: input.owner_agent_id }),
      setWorkItemRun: (input) =>
        updateWorkItemFields({ id: input.id, workflow_run_id: input.workflow_run_id ?? null }),
      setWorkItemReview: (input) =>
        updateWorkItemFields({ id: input.id, review_status: input.review_status }),
      blockWorkItem: (input) => updateWorkItem(input.id, "blocked", input.error),
      retryWorkItem: (id) => updateWorkItem(id, "pending"),
      completeWorkItem: (id) => updateWorkItem(id, "completed"),
      createWorktreeRun,
      getWorktreeRun,
      listWorktreeRuns,
      startWorktreeRun,
      verifyWorktreeRun,
      requestMergeApproval,
      mergeWorktreeRun,
      addArtifact,
      listArtifacts,
      requestGate,
      resolveGate,
      listGates,
      recordEvent: (input) => event(input.project_id, input.type, input.data ?? {}, input.actor_id),
      initRepository,
    })
  }),
)

export const defaultLayer = layer

export * as CompanyProject from "./company-project"
