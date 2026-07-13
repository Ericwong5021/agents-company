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
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkItemDependencyTable,
  CompanyWorkItemTable,
} from "./company-project.sql"
import { ApprovalGate, Artifact, GateKind, Plan, type PlanPhase, Project, type ProjectStatus, WorkItem } from "./schema"

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
    decision_note: row.decision_note ?? undefined,
    decided_at: row.decided_at ?? undefined,
  })

const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  intake: ["researching", "blocked"],
  researching: ["awaiting_project_approval", "blocked"],
  awaiting_project_approval: ["planning", "rejected", "researching"],
  planning: ["awaiting_development_approval", "blocked"],
  awaiting_development_approval: ["developing", "rejected", "planning"],
  developing: ["verifying", "blocked"],
  verifying: ["developing", "completed", "blocked"],
  completed: [],
  rejected: ["researching", "planning"],
  blocked: ["researching", "planning", "developing", "verifying", "rejected"],
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
  readonly transition: (input: {
    id: string
    status: ProjectStatus
    actor_id?: string
    reason?: string
  }) => Effect.Effect<Project>
  readonly setActiveRun: (input: { id: string; run_id?: string }) => Effect.Effect<Project>
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
    kind: string
    owner_agent_id?: string
    acceptance_criteria: string[]
    max_attempts?: number
    depends_on?: string[]
  }) => Effect.Effect<WorkItem>
  readonly listWorkItems: (project_id: string) => Effect.Effect<WorkItem[]>
  readonly readyWorkItems: (project_id: string) => Effect.Effect<WorkItem[]>
  readonly startWorkItem: (id: string) => Effect.Effect<WorkItem>
  readonly blockWorkItem: (input: { id: string; error: string }) => Effect.Effect<WorkItem>
  readonly retryWorkItem: (id: string) => Effect.Effect<WorkItem>
  readonly completeWorkItem: (id: string) => Effect.Effect<WorkItem>
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
  readonly initRepository: (project_id: string) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CompanyProject") {}

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
      kind: string
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
              status: "pending",
              owner_agent_id: input.owner_agent_id ?? null,
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
        { work_item_id: id, title: input.title, depends_on: input.depends_on ?? [] },
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
    }) {
      const current = yield* get(input.project_id)
      if (!current) throw new Error(`Company project not found: ${input.project_id}`)
      const expected = input.kind === "project_approval" ? "researching" : "planning"
      if (current.status !== expected)
        throw new Error(`${input.kind} cannot be requested while project is ${current.status}`)
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
        decision_note: null,
        requested_at: Date.now(),
        decided_at: null,
      }
      yield* Effect.sync(() => Database.use((db) => db.insert(CompanyApprovalGateTable).values(row).run()))
      yield* transition({
        id: input.project_id,
        status: input.kind === "project_approval" ? "awaiting_project_approval" : "awaiting_development_approval",
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
      yield* transition({
        id: gate.project_id,
        status: input.decision === "reject" ? "rejected" : gate.kind === "project_approval" ? "planning" : "developing",
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
      const gate = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyApprovalGateTable)
            .where(
              and(
                eq(CompanyApprovalGateTable.project_id, project_id),
                eq(CompanyApprovalGateTable.kind, "development_approval"),
                eq(CompanyApprovalGateTable.status, "approved"),
              ),
            )
            .get(),
        ),
      )
      if (!gate) throw new Error("Development approval is required before repository creation")
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

    return Service.of({
      create,
      get,
      list,
      transition,
      setActiveRun,
      createPlan,
      listPlans,
      createWorkItem,
      listWorkItems,
      readyWorkItems,
      startWorkItem: (id) => updateWorkItem(id, "running"),
      blockWorkItem: (input) => updateWorkItem(input.id, "blocked", input.error),
      retryWorkItem: (id) => updateWorkItem(id, "pending"),
      completeWorkItem: (id) => updateWorkItem(id, "completed"),
      addArtifact,
      listArtifacts,
      requestGate,
      resolveGate,
      listGates,
      initRepository,
    })
  }),
)

export const defaultLayer = layer

export * as CompanyProject from "./company-project"
