import { Context, Effect, Layer } from "effect"
import { and, asc, eq } from "drizzle-orm"
import z from "zod"
import { AgentRunTable } from "@/agent-run/agent-run.sql"
import { Company } from "@/company"
import { CompanyAgent } from "@/company-agent"
import { CompanyAgentID } from "@/company-agent/schema"
import {
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkItemTable,
} from "@/company-project/company-project.sql"
import { ProjectStatus } from "@/company-project/schema"
import { CompanyTable } from "@/company/company.sql"
import { CompanyID } from "@/company/schema"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import {
  CompanyAgentPerformanceTable,
  CompanyCapabilityNeedTable,
  CompanyDepartmentTable,
  CompanyEmploymentReviewTable,
  CompanyProjectAssignmentTable,
  CompanyTeamSelectionTable,
} from "./company-recruitment.sql"
import {
  AgentPerformance,
  CapabilityNeed,
  CreateCapabilityNeedInput,
  Department,
  DepartmentRecurringDemandNotProven,
  EmploymentReview,
  EnsureDepartmentInput,
  PerformanceProjectNotCompleted,
  ProjectAssignment,
  RecordPerformanceInput,
  ReassignProjectAssignmentInput,
  ReviewEmploymentInput,
  SelectionScore,
  SelectAndAssignInput,
  SelectForNeedInput,
  TeamSelection,
} from "./schema"
import { stableCandidateAgentID } from "./identity"
import {
  compatibleRuntimeForNeed,
  evaluateSelectionConstraints,
  permissionModeForNeed,
} from "./selection-policy"

const parseList = (value: string) => z.array(z.string()).parse(JSON.parse(value))
const needFromRow = (row: typeof CompanyCapabilityNeedTable.$inferSelect) =>
  CapabilityNeed.parse({
    ...row,
    company_id: row.company_id ?? undefined,
    work_item_id: row.work_item_id ?? undefined,
    source_receipt_id: row.source_receipt_id ?? undefined,
    capability_packs: parseList(row.capability_packs_json),
    department_key: row.department_key ?? undefined,
    required_runtime_capabilities: parseList(row.required_runtime_capabilities_json),
    required_tools: parseList(row.required_tools_json),
    allowed_permission_modes: parseList(row.allowed_permission_modes_json),
    workspace_scopes: parseList(row.workspace_scopes_json),
    independent_from_agent_ids: parseList(row.independent_from_agent_ids_json),
  })
const selectionFromRow = (row: typeof CompanyTeamSelectionTable.$inferSelect) =>
  TeamSelection.parse({
    ...row,
    company_id: row.company_id ?? undefined,
    score: JSON.parse(row.score_json),
    constraint_results: JSON.parse(row.constraint_results_json),
    time_released: row.time_released ?? undefined,
  })
const assignmentFromRow = (row: typeof CompanyProjectAssignmentTable.$inferSelect) =>
  ProjectAssignment.parse({
    ...row,
    company_id: row.company_id ?? undefined,
    supersedes_assignment_id: row.supersedes_assignment_id ?? undefined,
    decision_scope: parseList(row.decision_scope_json),
    resource_scope: parseList(row.resource_scope_json),
    source_receipt_id: row.source_receipt_id ?? undefined,
    started_at: row.started_at ?? undefined,
    released_at: row.released_at ?? undefined,
    release_reason: row.release_reason ?? undefined,
  })
const performanceFromRow = (row: typeof CompanyAgentPerformanceTable.$inferSelect) => AgentPerformance.parse(row)
const reviewFromRow = (row: typeof CompanyEmploymentReviewTable.$inferSelect) =>
  EmploymentReview.parse({
    ...row,
    decision_note: row.decision_note ?? undefined,
    time_decided: row.time_decided ?? undefined,
  })
const departmentFromRow = (row: typeof CompanyDepartmentTable.$inferSelect) =>
  Department.parse({
    ...row,
    evidence: JSON.parse(row.evidence_json),
  })
const normalizeCapabilityPacks = (values: string[]) => [...new Set(values)].toSorted()
const normalizeList = (values: string[]) => [...new Set(values)].toSorted()
const terms = (value: string) =>
  new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length > 1),
  )

type SelectionResult = {
  need: CapabilityNeed
  agent: CompanyAgent.Info
  selections: TeamSelection[]
}

type AssignmentSelectionResult = SelectionResult & {
  assignment: ProjectAssignment
}

export interface Interface {
  readonly createNeed: (input: CreateCapabilityNeedInput) => Effect.Effect<CapabilityNeed>
  readonly selectForNeed: (input: SelectForNeedInput) => Effect.Effect<SelectionResult>
  readonly selectAndAssign: (input: SelectAndAssignInput) => Effect.Effect<AssignmentSelectionResult>
  readonly reassign: (input: ReassignProjectAssignmentInput) => Effect.Effect<ProjectAssignment>
  readonly listAssignments: (input: {
    project_id: string
    work_item_id?: string
  }) => Effect.Effect<ProjectAssignment[]>
  readonly releaseProject: (input: { company_id?: CompanyID; project_id: string }) => Effect.Effect<TeamSelection[]>
  readonly recordPerformance: (input: RecordPerformanceInput) => Effect.Effect<AgentPerformance>
  readonly reviewEmployment: (
    input: ReviewEmploymentInput,
  ) => Effect.Effect<{ review: EmploymentReview; eligible: boolean; unmet_conditions: string[] }>
  readonly ensureDepartment: (input: EnsureDepartmentInput) => Effect.Effect<Department>
  readonly snapshot: (input: { company_id: CompanyID; project_id?: string }) => Effect.Effect<{
    needs: CapabilityNeed[]
    selections: TeamSelection[]
    assignments: ProjectAssignment[]
    performances: AgentPerformance[]
    employment_reviews: EmploymentReview[]
    departments: Department[]
    candidate_pool: CompanyAgent.Info[]
    assigned_candidates: CompanyAgent.Info[]
  }>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyRecruitment") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const company = yield* Company.Service
    yield* company.current().pipe(Effect.ignore)
    const agents = yield* CompanyAgent.Service

    const getNeed = Effect.fn("CompanyRecruitment.getNeed")(function* (id: string) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(CompanyCapabilityNeedTable).where(eq(CompanyCapabilityNeedTable.id, id)).get(),
        ),
      )
      return row ? needFromRow(row) : undefined
    })

    const listSelections = Effect.fn("CompanyRecruitment.listSelections")(function* (input: {
      company_id?: CompanyID
      project_id?: string
      capability_need_id?: string
    }) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyTeamSelectionTable)
            .orderBy(asc(CompanyTeamSelectionTable.time_created), asc(CompanyTeamSelectionTable.id))
            .all(),
        ),
      )
      return rows
        .filter((row) => (row.company_id ?? undefined) === input.company_id)
        .filter((row) => !input.project_id || row.project_id === input.project_id)
        .filter((row) => !input.capability_need_id || row.capability_need_id === input.capability_need_id)
        .map(selectionFromRow)
    })

    const listAssignments = Effect.fn("CompanyRecruitment.listAssignments")(function* (input: {
      project_id: string
      work_item_id?: string
    }) {
      return yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyProjectAssignmentTable)
            .where(eq(CompanyProjectAssignmentTable.project_id, input.project_id))
            .orderBy(
              asc(CompanyProjectAssignmentTable.assigned_at),
              asc(CompanyProjectAssignmentTable.id),
            )
            .all()
            .filter((row) => !input.work_item_id || row.work_item_id === input.work_item_id)
            .map(assignmentFromRow),
        ),
      )
    })

    const createNeed = Effect.fn("CompanyRecruitment.createNeed")(function* (raw: CreateCapabilityNeedInput) {
      const parsed = CreateCapabilityNeedInput.parse(raw)
      const input = {
        ...parsed,
        capability_packs: normalizeCapabilityPacks(parsed.capability_packs),
        required_runtime_capabilities: normalizeList(parsed.required_runtime_capabilities),
        required_tools: normalizeList(parsed.required_tools),
        allowed_permission_modes: normalizeList(parsed.allowed_permission_modes),
        workspace_scopes: normalizeList(parsed.workspace_scopes),
        independent_from_agent_ids: normalizeList(parsed.independent_from_agent_ids),
      }
      return yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const company = input.company_id
              ? db.select().from(CompanyTable).where(eq(CompanyTable.id, input.company_id)).get()
              : undefined
            const project = db
              .select()
              .from(CompanyProjectTable)
              .where(eq(CompanyProjectTable.id, input.project_id))
              .get()
            if (input.company_id && !company) throw new Error(`Company not found: ${input.company_id}`)
            if (!project) throw new Error(`Company project not found: ${input.project_id}`)
            if ((project.company_id ?? undefined) !== input.company_id)
              throw new Error(`Company project ${input.project_id} belongs to another company`)
            const workItem = db
              .select()
              .from(CompanyWorkItemTable)
              .where(eq(CompanyWorkItemTable.id, input.work_item_id))
              .get()
            if (!workItem || workItem.project_id !== input.project_id)
              throw new Error(`Company work item ${input.work_item_id} does not belong to project ${input.project_id}`)
            const now = Date.now()
            db.insert(CompanyCapabilityNeedTable)
              .values({
                id: Identifier.ascending("capabilityNeed"),
                company_id: input.company_id ?? null,
                project_id: input.project_id,
                work_item_id: input.work_item_id,
                source_receipt_id: input.source_receipt_id ?? null,
                need_key: input.need_key,
                role: input.role,
                work_type: input.work_type,
                capability_packs_json: JSON.stringify(input.capability_packs),
                risk_level: input.risk_level,
                demand_horizon: input.demand_horizon,
                department_key: input.department_key ?? null,
                required_runtime_capabilities_json: JSON.stringify(input.required_runtime_capabilities),
                required_tools_json: JSON.stringify(input.required_tools),
                allowed_permission_modes_json: JSON.stringify(input.allowed_permission_modes),
                workspace_scopes_json: JSON.stringify(input.workspace_scopes),
                independent_from_agent_ids_json: JSON.stringify(input.independent_from_agent_ids),
                time_created: now,
                time_updated: now,
              })
              .onConflictDoNothing()
              .run()
            const row = db
              .select()
              .from(CompanyCapabilityNeedTable)
              .where(
                and(
                  eq(CompanyCapabilityNeedTable.project_id, input.project_id),
                  eq(CompanyCapabilityNeedTable.need_key, input.need_key),
                ),
              )
              .get()
            if (!row) throw new Error(`Capability need was not persisted: ${input.need_key}`)
            const current = needFromRow(row)
            if (
              current.company_id !== input.company_id ||
              current.work_item_id !== input.work_item_id ||
              current.source_receipt_id !== input.source_receipt_id ||
              current.role !== input.role ||
              current.work_type !== input.work_type ||
              JSON.stringify(normalizeCapabilityPacks(current.capability_packs)) !==
                JSON.stringify(input.capability_packs) ||
              current.risk_level !== input.risk_level ||
              current.demand_horizon !== input.demand_horizon ||
              current.department_key !== input.department_key ||
              JSON.stringify(current.required_runtime_capabilities) !==
                JSON.stringify(input.required_runtime_capabilities) ||
              JSON.stringify(current.required_tools) !== JSON.stringify(input.required_tools) ||
              JSON.stringify(current.allowed_permission_modes) !== JSON.stringify(input.allowed_permission_modes) ||
              JSON.stringify(current.workspace_scopes) !== JSON.stringify(input.workspace_scopes) ||
              JSON.stringify(current.independent_from_agent_ids) !==
                JSON.stringify(input.independent_from_agent_ids)
            )
              throw new Error(`Capability need key already exists with different facts: ${input.need_key}`)
            if (JSON.stringify(current.capability_packs) === JSON.stringify(input.capability_packs)) return current
            db.update(CompanyCapabilityNeedTable)
              .set({
                capability_packs_json: JSON.stringify(input.capability_packs),
                time_updated: now,
              })
              .where(eq(CompanyCapabilityNeedTable.id, current.id))
              .run()
            return needFromRow({
              ...row,
              capability_packs_json: JSON.stringify(input.capability_packs),
              time_updated: now,
            })
          },
          { behavior: "immediate" },
        ),
      )
    })

    const candidateScore = Effect.fn("CompanyRecruitment.candidateScore")(function* (
      need: CapabilityNeed,
      agent: CompanyAgent.Info,
    ) {
      const wanted = terms([need.role, need.work_type, ...need.capability_packs].join(" "))
      const profile = terms(
        [agent.name, agent.role_key, agent.description, ...(agent.skills ?? []), ...(agent.responsibilities ?? [])].join(
          " ",
        ),
      )
      const capability_match = [...wanted].filter((term) => profile.has(term)).length
      const state = yield* Effect.sync(() =>
        Database.use((db) => {
          const active = db
            .select()
            .from(AgentRunTable)
            .where(eq(AgentRunTable.agent_id, agent.id))
            .all()
            .filter((run) =>
              ["queued", "starting", "running", "interrupting", "awaiting_recovery"].includes(run.state),
            ).length
          const history = db
            .select()
            .from(CompanyAgentPerformanceTable)
            .where(eq(CompanyAgentPerformanceTable.agent_id, agent.id))
            .all()
          return {
            active,
            quality: history.length
              ? Math.round(history.reduce((sum, item) => sum + item.quality_score, 0) / history.length)
              : 50,
            reliability: history.length
              ? Math.round(history.reduce((sum, item) => sum + item.reliability_score, 0) / history.length)
              : 50,
            cost: history.length
              ? Math.round(history.reduce((sum, item) => sum + item.cost_score, 0) / history.length)
              : 50,
            speed: history.length
              ? Math.round(history.reduce((sum, item) => sum + item.speed_score, 0) / history.length)
              : 50,
          }
        }),
      )
      const riskFit =
        need.risk_level === "high"
          ? agent.lifecycle === "employee"
            ? 100
            : state.quality >= 80 && state.reliability >= 80
              ? 80
              : 40
          : 80
      return SelectionScore.parse({
        capability_match,
        availability: Math.max(0, 100 - state.active * 35),
        historical_quality: state.quality,
        historical_reliability: state.reliability,
        cost_efficiency: state.cost,
        speed: state.speed,
        risk_fit: riskFit,
        reuse_value: agent.lifecycle === "candidate" ? 100 : agent.lifecycle === "employee" ? 70 : 40,
        total:
          capability_match * 30 +
          Math.max(0, 100 - state.active * 35) +
          Math.round(state.quality / 3) +
          Math.round(state.reliability / 4) +
          Math.round(state.cost / 10) +
          Math.round(state.speed / 10) +
          Math.round(riskFit / 5) +
          (agent.lifecycle === "candidate" ? 20 : agent.lifecycle === "employee" ? 10 : 0),
      })
    })

    const selectForNeed = Effect.fn("CompanyRecruitment.selectForNeed")(function* (raw: SelectForNeedInput) {
      const input = SelectForNeedInput.parse(raw)
      const need = yield* getNeed(input.capability_need_id)
      if (!need) throw new Error(`Capability need not found: ${input.capability_need_id}`)
      if (!need.work_item_id) throw new Error(`Capability need ${need.id} is not bound to a work item`)
      const previous = yield* listSelections({
        company_id: need.company_id,
        capability_need_id: need.id,
      })
      const previousSelected = previous.find((item) => item.decision === "selected" && !item.time_released)
      if (previousSelected) {
        const agent = yield* agents.get(CompanyAgentID.make(previousSelected.agent_id))
        if (!agent) throw new Error(`Selected company agent not found: ${previousSelected.agent_id}`)
        const constraints = evaluateSelectionConstraints(need, agent)
        if (
          constraints.eligible &&
          !input.exclude_agent_ids.includes(agent.id) &&
          (!input.required_agent_id || input.required_agent_id === agent.id)
        )
          return { need, agent, selections: previous }
      }

      const pool = (yield* agents.list(need.company_id ? { company_id: need.company_id } : undefined)).filter(
        (agent) =>
          agent.lifecycle !== "archived" &&
          (agent.company_id ?? undefined) === need.company_id,
      )
      const scored = yield* Effect.forEach(pool, (agent) =>
        Effect.map(candidateScore(need, agent), (score) => {
          const constraints = evaluateSelectionConstraints(need, agent)
          return {
            agent,
            score,
            constraints,
            excluded:
              input.exclude_agent_ids.includes(agent.id) ||
              Boolean(input.required_agent_id && input.required_agent_id !== agent.id),
          }
        }),
      )
      const selected = scored
        .filter((item) => !item.excluded && item.constraints.eligible && item.score.capability_match > 0)
        .toSorted(
          (left, right) => right.score.total - left.score.total || left.agent.id.localeCompare(right.agent.id),
        )[0]
      const chosen = selected
        ? { ...selected, source: "company_pool" as const }
        : yield* Effect.gen(function* () {
            if (input.required_agent_id)
              throw new Error(
                `Required agent ${input.required_agent_id} does not satisfy capability need ${need.id}`,
              )
            const preferredRuntime = compatibleRuntimeForNeed(need)
            if (!preferredRuntime)
              throw new Error(`Capability need ${need.id} has unsatisfied runtime, tool or permission constraints`)
            const id = stableCandidateAgentID({
              ...need,
              company_id: need.company_id ?? "standalone",
            })
            const existing = yield* agents.get(id)
            if (existing && existing.company_id !== need.company_id)
              throw new Error(`Generated candidate ID is already owned by another company: ${id}`)
            const agent =
              existing ??
              (yield* agents.create({
                id,
                company_id: need.company_id,
                name: need.role,
                lifecycle: "candidate",
                description: `为“${need.role}”能力需求进入候选池的 ${need.work_type} Agent。`,
                system_prompt: `你以候选 Agent 身份承担“${need.role}”临时责任，只在当前 Work Item 的能力、资源和权限边界内行动。`,
                model: need.risk_level === "high" ? "ultra" : "standard",
                preferred_runtime: preferredRuntime,
                org_layer: "execution",
                responsibilities: [need.role, need.work_type, ...need.capability_packs],
              }))
            const constraints = evaluateSelectionConstraints(need, agent)
            if (!constraints.eligible)
              throw new Error(`Generated candidate ${agent.id} does not satisfy capability need ${need.id}`)
            return {
              agent,
              score: SelectionScore.parse({
                capability_match: terms([need.role, need.work_type, ...need.capability_packs].join(" ")).size,
                availability: 100,
                historical_quality: 50,
                historical_reliability: 50,
                cost_efficiency: 50,
                speed: 50,
                risk_fit: need.risk_level === "high" ? 40 : 80,
                reuse_value: 0,
                total: 100,
              }),
              constraints,
              excluded: false,
              source: "new_candidate" as const,
            }
          })

      const now = Date.now()
      const persisted = yield* Effect.sync(() =>
        Database.transaction(
          (tx) => {
            const active = tx
              .select()
              .from(CompanyTeamSelectionTable)
              .where(eq(CompanyTeamSelectionTable.capability_need_id, need.id))
              .all()
              .find((row) => row.decision === "selected" && row.time_released === null)
            const activeCandidate = active
              ? scored.find((item) => item.agent.id === active.agent_id)
              : undefined
            if (
              active &&
              active.id !== previousSelected?.id &&
              activeCandidate?.constraints.eligible &&
              !activeCandidate.excluded
            )
              return { existing_selection_id: active.id }
            if (active)
              tx
                .update(CompanyTeamSelectionTable)
                .set({ time_released: now, time_updated: now })
                .where(eq(CompanyTeamSelectionTable.id, active.id))
                .run()
            const selectionRound =
              Math.max(
                0,
                ...tx
                  .select({ selection_round: CompanyTeamSelectionTable.selection_round })
                  .from(CompanyTeamSelectionTable)
                  .where(eq(CompanyTeamSelectionTable.capability_need_id, need.id))
                  .all()
                  .map((row) => row.selection_round),
              ) + 1
            const candidates = scored.some((item) => item.agent.id === chosen.agent.id)
              ? scored
              : [...scored, chosen]
            const rows = candidates.map((item) => ({
              id: Identifier.ascending("teamSelection"),
              company_id: need.company_id ?? null,
              project_id: need.project_id,
              capability_need_id: need.id,
              selection_round: selectionRound,
              agent_id: item.agent.id,
              decision: item.agent.id === chosen.agent.id ? "selected" : "rejected",
              source: item.agent.id === chosen.agent.id ? chosen.source : "company_pool",
              lifecycle_at_selection: item.agent.lifecycle,
              reason:
                item.agent.id === chosen.agent.id
                  ? `入选：通过全部硬约束，能力匹配 ${item.score.capability_match} 项，总评 ${item.score.total}。`
                  : item.excluded
                    ? "未入选：与当前任务的显式候选或独立性边界冲突。"
                    : !item.constraints.eligible
                      ? `未入选：${item.constraints.results
                          .filter((result) => !result.passed)
                          .map((result) => result.reason)
                          .join("；")}`
                      : item.score.capability_match === 0
                        ? `未入选：与“${need.role}”及其能力包没有可验证的能力匹配。`
                        : `未入选：能力匹配 ${item.score.capability_match} 项、总评 ${item.score.total}，低于入选者 ${chosen.score.total}。`,
              score_json: JSON.stringify(item.score),
              constraint_results_json: JSON.stringify(item.constraints.results),
              time_released: null,
              time_created: now,
              time_updated: now,
            }))
            tx.insert(CompanyTeamSelectionTable).values(rows).run()
            return {
              selected_selection_id: rows.find((row) => row.decision === "selected")!.id,
            }
          },
          { behavior: "immediate" },
        ),
      )
      const selectionID =
        "existing_selection_id" in persisted
          ? persisted.existing_selection_id
          : persisted.selected_selection_id
      if (!selectionID) throw new Error(`Capability need ${need.id} did not persist a selected decision`)
      const selectedRow = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(CompanyTeamSelectionTable).where(eq(CompanyTeamSelectionTable.id, selectionID)).get(),
        ),
      )
      if (!selectedRow) throw new Error(`Selected team decision not found: ${selectionID}`)
      const agent = yield* agents.get(CompanyAgentID.make(selectedRow.agent_id))
      if (!agent) throw new Error(`Selected company agent not found: ${selectedRow.agent_id}`)
      return {
        need,
        agent,
        selections: yield* listSelections({ company_id: need.company_id, capability_need_id: need.id }),
      }
    })

    const assignSelection = Effect.fn("CompanyRecruitment.assignSelection")(function* (input: {
      selection_id: string
      permission_mode?: "read_only" | "workspace_write" | "full_access"
      replace_current?: boolean
      release_reason?: string
      expected_assignment_id?: string
      idempotency_key?: string
    }) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(CompanyTeamSelectionTable).where(eq(CompanyTeamSelectionTable.id, input.selection_id)).get(),
        ),
      )
      if (!row || row.decision !== "selected" || row.time_released)
        throw new Error(`Current selected team decision not found: ${input.selection_id}`)
      const need = yield* getNeed(row.capability_need_id)
      if (!need?.work_item_id) throw new Error(`Capability need ${row.capability_need_id} is not bound to a work item`)
      const permissionMode = input.permission_mode ?? permissionModeForNeed(need)
      if (!permissionMode || !need.allowed_permission_modes.includes(permissionMode))
        throw new Error(`Capability need ${need.id} cannot use permission mode ${input.permission_mode ?? ""}`)
      const assignment = yield* Effect.sync(() =>
        Database.transaction(
          (tx) => {
            const selection = tx
              .select()
              .from(CompanyTeamSelectionTable)
              .where(eq(CompanyTeamSelectionTable.id, input.selection_id))
              .get()
            if (!selection || selection.decision !== "selected" || selection.time_released)
              throw new Error(`Current selected team decision not found: ${input.selection_id}`)
            const workItem = tx
              .select()
              .from(CompanyWorkItemTable)
              .where(eq(CompanyWorkItemTable.id, need.work_item_id!))
              .get()
            if (!workItem || workItem.project_id !== need.project_id)
              throw new Error(`Company work item ${need.work_item_id} does not belong to project ${need.project_id}`)
            const idempotent = input.idempotency_key
              ? tx
                  .select()
                  .from(CompanyProjectAssignmentTable)
                  .where(
                    and(
                      eq(CompanyProjectAssignmentTable.project_id, need.project_id),
                      eq(CompanyProjectAssignmentTable.idempotency_key, input.idempotency_key),
                    ),
                  )
                  .get()
              : undefined
            if (idempotent) {
              if (idempotent.selection_id !== selection.id)
                throw new Error(`Assignment idempotency key ${input.idempotency_key} has different facts`)
              return idempotent
            }
            const existing = tx
              .select()
              .from(CompanyProjectAssignmentTable)
              .where(eq(CompanyProjectAssignmentTable.selection_id, selection.id))
              .get()
            if (existing) return existing
            const current = tx
              .select()
              .from(CompanyProjectAssignmentTable)
              .where(eq(CompanyProjectAssignmentTable.work_item_id, workItem.id))
              .all()
              .find((item) => item.status === "assigned" || item.status === "active")
            if (input.expected_assignment_id && current?.id !== input.expected_assignment_id)
              throw new Error(
                `Work item ${workItem.id} current assignment changed from ${input.expected_assignment_id} to ${current?.id ?? "none"}`,
              )
            if (current && !input.replace_current)
              throw new Error(`Work item ${workItem.id} already has current assignment ${current.id}`)
            const now = Date.now()
            if (current)
              tx
                .update(CompanyProjectAssignmentTable)
                .set({
                  status: "released",
                  released_at: now,
                  release_reason: input.release_reason ?? "reassigned",
                })
                .where(eq(CompanyProjectAssignmentTable.id, current.id))
                .run()
            const version =
              Math.max(
                0,
                ...tx
                  .select({ version: CompanyProjectAssignmentTable.version })
                  .from(CompanyProjectAssignmentTable)
                  .where(eq(CompanyProjectAssignmentTable.work_item_id, workItem.id))
                  .all()
                  .map((item) => item.version),
              ) + 1
            const id = Identifier.ascending("projectAssignment")
            const status = workItem.status === "running" ? "active" : "assigned"
            tx.insert(CompanyProjectAssignmentTable)
              .values({
                id,
                company_id: need.company_id ?? null,
                project_id: need.project_id,
                work_item_id: workItem.id,
                capability_need_id: need.id,
                selection_id: selection.id,
                agent_id: selection.agent_id,
                version,
                idempotency_key: input.idempotency_key ?? `selection:${selection.id}`,
                supersedes_assignment_id: current?.id ?? null,
                temporary_role: need.role,
                responsibility: workItem.description,
                decision_scope_json: workItem.decision_scope_json,
                resource_scope_json: workItem.resource_scope_json,
                permission_mode: permissionMode,
                source_receipt_id: need.source_receipt_id ?? null,
                status,
                assigned_at: now,
                started_at: status === "active" ? now : null,
                released_at: null,
                release_reason: null,
              })
              .run()
            tx.update(CompanyWorkItemTable)
              .set({ owner_agent_id: selection.agent_id, updated_at: now })
              .where(eq(CompanyWorkItemTable.id, workItem.id))
              .run()
            tx.insert(CompanyProjectEventTable)
              .values({
                id: Identifier.ascending("event"),
                project_id: need.project_id,
                type: current ? "project_assignment.reassigned" : "project_assignment.assigned",
                actor_id: selection.agent_id,
                data_json: JSON.stringify({
                  assignment_id: id,
                  work_item_id: workItem.id,
                  selection_id: selection.id,
                  agent_id: selection.agent_id,
                  version,
                  supersedes_assignment_id: current?.id,
                  reason: input.release_reason,
                }),
                created_at: now,
              })
              .run()
            return tx
              .select()
              .from(CompanyProjectAssignmentTable)
              .where(eq(CompanyProjectAssignmentTable.id, id))
              .get()!
          },
          { behavior: "immediate" },
        ),
      )
      return assignmentFromRow(assignment)
    })

    const selectAndAssign = Effect.fn("CompanyRecruitment.selectAndAssign")(function* (raw: SelectAndAssignInput) {
      const input = SelectAndAssignInput.parse(raw)
      const selected = yield* selectForNeed(input)
      const selection = selected.selections.find(
        (item) => item.decision === "selected" && !item.time_released,
      )
      if (!selection) throw new Error(`Capability need ${input.capability_need_id} has no current selection`)
      return {
        ...selected,
        assignment: yield* assignSelection({
          selection_id: selection.id,
          permission_mode: input.permission_mode,
        }),
      }
    })

    const reassign = Effect.fn("CompanyRecruitment.reassign")(function* (raw: ReassignProjectAssignmentInput) {
      const input = ReassignProjectAssignmentInput.parse(raw)
      const replay = input.idempotency_key
        ? yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .select()
                .from(CompanyProjectAssignmentTable)
                .where(eq(CompanyProjectAssignmentTable.idempotency_key, input.idempotency_key!))
                .all()
                .find(
                  (assignment) =>
                    assignment.work_item_id === input.work_item_id &&
                    assignment.agent_id === input.owner_agent_id,
                ),
            ),
          )
        : undefined
      if (replay) return assignmentFromRow(replay)
      const current = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyProjectAssignmentTable)
            .where(eq(CompanyProjectAssignmentTable.work_item_id, input.work_item_id))
            .all()
            .find((item) => item.status === "assigned" || item.status === "active"),
        ),
      )
      if (!current) throw new Error(`Work item ${input.work_item_id} has no current assignment`)
      if (input.expected_assignment_id && current.id !== input.expected_assignment_id)
        throw new Error(
          `Work item ${input.work_item_id} current assignment changed from ${input.expected_assignment_id} to ${current.id}`,
        )
      if (current.agent_id === input.owner_agent_id)
        throw new Error(`Work item ${input.work_item_id} is already assigned to ${input.owner_agent_id}`)
      const selected = yield* selectForNeed({
        capability_need_id: current.capability_need_id,
        exclude_agent_ids: [current.agent_id],
        required_agent_id: input.owner_agent_id,
      })
      const selection = selected.selections.find(
        (item) =>
          item.decision === "selected" &&
          !item.time_released &&
          item.agent_id === input.owner_agent_id,
      )
      if (!selection) throw new Error(`Agent ${input.owner_agent_id} was not selected for work item ${input.work_item_id}`)
      return yield* assignSelection({
        selection_id: selection.id,
        replace_current: true,
        release_reason: input.reason,
        expected_assignment_id: input.expected_assignment_id ?? current.id,
        idempotency_key: input.idempotency_key,
      })
    })

    const releaseProject = Effect.fn("CompanyRecruitment.releaseProject")(function* (input: {
      company_id?: CompanyID
      project_id: string
    }) {
      const selected = (yield* listSelections(input)).filter(
        (item) => item.decision === "selected" && !item.time_released,
      )
      const releasedAt = Date.now()
      yield* Effect.sync(() =>
        Database.transaction((tx) => {
          selected.forEach((item) =>
            tx
              .update(CompanyTeamSelectionTable)
              .set({ time_released: releasedAt, time_updated: releasedAt })
              .where(eq(CompanyTeamSelectionTable.id, item.id))
              .run(),
          )
          tx
            .select()
            .from(CompanyProjectAssignmentTable)
            .where(eq(CompanyProjectAssignmentTable.project_id, input.project_id))
            .all()
            .filter((item) => item.status === "assigned" || item.status === "active")
            .forEach((item) => {
              tx.update(CompanyProjectAssignmentTable)
                .set({
                  status: "released",
                  released_at: releasedAt,
                  release_reason: "project_terminal",
                })
                .where(eq(CompanyProjectAssignmentTable.id, item.id))
                .run()
              tx.insert(CompanyProjectEventTable)
                .values({
                  id: Identifier.ascending("event"),
                  project_id: input.project_id,
                  type: "project_assignment.released",
                  actor_id: item.agent_id,
                  data_json: JSON.stringify({
                    assignment_id: item.id,
                    work_item_id: item.work_item_id,
                    reason: "project_terminal",
                  }),
                  created_at: releasedAt,
                })
                .run()
            })
        }),
      )
      return (yield* listSelections(input)).filter((item) => item.decision === "selected")
    })

    const recordPerformance = Effect.fn("CompanyRecruitment.recordPerformance")(function* (
      raw: RecordPerformanceInput,
    ) {
      const input = RecordPerformanceInput.parse(raw)
      const selection = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(CompanyTeamSelectionTable).where(eq(CompanyTeamSelectionTable.id, input.selection_id)).get(),
        ),
      )
      if (!selection || selection.decision !== "selected")
        throw new Error(`Selected team assignment not found: ${input.selection_id}`)
      if (!selection.company_id)
        throw new Error(`Standalone selection ${input.selection_id} cannot enter company performance review`)
      const project = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, selection.project_id)).get(),
        ),
      )
      if (!project) throw new Error(`Company project not found: ${selection.project_id}`)
      const projectStatus = ProjectStatus.parse(project.status)
      if (projectStatus !== "completed")
        throw new PerformanceProjectNotCompleted({
          selection_id: selection.id,
          project_id: project.id,
          project_status: projectStatus,
          required_project_status: "completed",
          message: `Performance for selection ${selection.id} requires completed project ${project.id}`,
        })
      const now = Date.now()
      const existing = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyAgentPerformanceTable)
            .where(eq(CompanyAgentPerformanceTable.selection_id, input.selection_id))
            .get(),
        ),
      )
      const row = {
        id: existing?.id ?? Identifier.ascending("agentPerformance"),
        company_id: selection.company_id,
        project_id: selection.project_id,
        selection_id: selection.id,
        agent_id: selection.agent_id,
        outcome: input.outcome,
        quality_score: input.quality_score,
        reliability_score: input.reliability_score,
        cost_score: input.cost_score,
        speed_score: input.speed_score,
        review_summary: input.review_summary,
        time_created: existing?.time_created ?? now,
        time_updated: now,
      }
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(CompanyAgentPerformanceTable)
            .values(row)
            .onConflictDoUpdate({
              target: CompanyAgentPerformanceTable.selection_id,
              set: {
                outcome: row.outcome,
                quality_score: row.quality_score,
                reliability_score: row.reliability_score,
                cost_score: row.cost_score,
                speed_score: row.speed_score,
                review_summary: row.review_summary,
                time_updated: row.time_updated,
              },
            })
            .run(),
        ),
      )
      return performanceFromRow(row)
    })

    const reviewEmployment = Effect.fn("CompanyRecruitment.reviewEmployment")(function* (raw: ReviewEmploymentInput) {
      const input = ReviewEmploymentInput.parse(raw)
      const agent = yield* agents.get(CompanyAgentID.make(input.agent_id))
      if (!agent || agent.company_id !== input.company_id)
        throw new Error(`Company candidate not found: ${input.agent_id}`)
      if (agent.lifecycle === "archived")
        throw new Error(`Archived candidate cannot enter employment review: ${agent.id}`)
      const evidence = yield* Effect.sync(() =>
        Database.use((db) => {
          const selections = db
            .select()
            .from(CompanyTeamSelectionTable)
            .where(eq(CompanyTeamSelectionTable.agent_id, input.agent_id))
            .all()
            .filter((item) => item.decision === "selected")
          const performances = db
            .select()
            .from(CompanyAgentPerformanceTable)
            .where(eq(CompanyAgentPerformanceTable.agent_id, input.agent_id))
            .all()
            .filter(
              (item) =>
                db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, item.project_id)).get()
                  ?.status === "completed",
            )
          const successfulSelectionIDs = new Set(
            performances.filter((item) => item.outcome === "success").map((item) => item.selection_id),
          )
          const needIDs = new Set(
            selections
              .filter((item) => successfulSelectionIDs.has(item.id))
              .map((item) => item.capability_need_id),
          )
          const recurring = db
            .select()
            .from(CompanyCapabilityNeedTable)
            .where(eq(CompanyCapabilityNeedTable.company_id, input.company_id))
            .all()
            .filter((need) => needIDs.has(need.id) && need.demand_horizon === "recurring")
          return {
            selectedProjects: new Set(selections.map((item) => item.project_id)).size,
            successfulProjects: new Set(
              performances.filter((item) => item.outcome === "success").map((item) => item.project_id),
            ).size,
            averageQuality: performances.length
              ? Math.round(performances.reduce((sum, item) => sum + item.quality_score, 0) / performances.length)
              : 0,
            averageReliability: performances.length
              ? Math.round(performances.reduce((sum, item) => sum + item.reliability_score, 0) / performances.length)
              : 0,
            recurringNeeds: new Set(recurring.map((item) => item.project_id)).size,
            departmentKeys: [
              ...new Set(recurring.map((item) => item.department_key).filter((item): item is string => Boolean(item))),
            ],
          }
        }),
      )
      const unmet = [
        ...(evidence.selectedProjects < 2 ? ["至少在两个代表性项目中入选"] : []),
        ...(evidence.successfulProjects < 2 ? ["至少两个项目有成功交付与审查记录"] : []),
        ...(evidence.averageQuality < 80 ? ["平均质量评分至少为 80"] : []),
        ...(evidence.averageReliability < 80 ? ["平均可靠性评分至少为 80"] : []),
        ...(evidence.recurringNeeds < 2 ? ["同类能力在至少两个项目中被标记为持续需求"] : []),
      ]
      const eligible = unmet.length === 0
      const status =
        input.decision === "reject" ? "rejected" : input.decision === "approve" && eligible ? "approved" : "proposed"
      if (status === "approved") {
        yield* agents.promote(agent.id)
        if (evidence.departmentKeys.length === 1) {
          const department = yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .select()
                .from(CompanyDepartmentTable)
                .where(
                  and(
                    eq(CompanyDepartmentTable.company_id, input.company_id),
                    eq(CompanyDepartmentTable.department_key, evidence.departmentKeys[0]),
                  ),
                )
                .get(),
            ),
          )
          if (department?.status === "active")
            yield* agents.update({ id: agent.id, department: department.department_key })
        }
      }
      const now = Date.now()
      const row = {
        id: Identifier.ascending("employmentReview"),
        company_id: input.company_id,
        agent_id: input.agent_id,
        status,
        selected_project_count: evidence.selectedProjects,
        successful_project_count: evidence.successfulProjects,
        average_quality_score: evidence.averageQuality,
        average_reliability_score: evidence.averageReliability,
        recurring_need_count: evidence.recurringNeeds,
        rationale: eligible
          ? "候选人在多项目中持续、高质量交付，且对应能力形成持续业务需求。"
          : `尚未满足正式岗位条件：${unmet.join("；")}。`,
        decision_note: input.decision_note ?? null,
        time_decided: status === "proposed" ? null : now,
        time_created: now,
        time_updated: now,
      }
      yield* Effect.sync(() => Database.use((db) => db.insert(CompanyEmploymentReviewTable).values(row).run()))
      return { review: reviewFromRow(row), eligible, unmet_conditions: unmet }
    })

    const ensureDepartment = Effect.fn("CompanyRecruitment.ensureDepartment")(function* (raw: EnsureDepartmentInput) {
      const input = EnsureDepartmentInput.parse(raw)
      const needs = yield* Effect.sync(() =>
        Database.use((db) => {
          const recurring = db
            .select()
            .from(CompanyCapabilityNeedTable)
            .where(eq(CompanyCapabilityNeedTable.company_id, input.company_id))
            .all()
            .filter((need) => need.demand_horizon === "recurring" && need.department_key === input.department_key)
          const completedProjectIDs = new Set(
            db
              .select()
              .from(CompanyProjectTable)
              .all()
              .filter((project) => project.company_id === input.company_id && project.status === "completed")
              .map((project) => project.id),
          )
          const successfulSelectionIDs = new Set(
            db
              .select()
              .from(CompanyAgentPerformanceTable)
              .where(eq(CompanyAgentPerformanceTable.company_id, input.company_id))
              .all()
              .filter((performance) => performance.outcome === "success")
              .map((performance) => performance.selection_id),
          )
          const provenNeedIDs = new Set(
            db
              .select()
              .from(CompanyTeamSelectionTable)
              .where(eq(CompanyTeamSelectionTable.company_id, input.company_id))
              .all()
              .filter(
                (selection) =>
                  selection.decision === "selected" &&
                  completedProjectIDs.has(selection.project_id) &&
                  successfulSelectionIDs.has(selection.id),
              )
              .map((selection) => selection.capability_need_id),
          )
          return recurring.filter(
            (need) => completedProjectIDs.has(need.project_id) && provenNeedIDs.has(need.id),
          )
        }),
      )
      const projects = [...new Set(needs.map((need) => need.project_id))]
      if (projects.length < 2)
        throw new DepartmentRecurringDemandNotProven({
          company_id: input.company_id,
          department_key: input.department_key,
          recurring_project_count: projects.length,
          required_project_count: 2,
          message: `Department ${input.department_key} requires recurring demand evidence from at least two projects`,
        })
      const existing = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyDepartmentTable)
            .where(
              and(
                eq(CompanyDepartmentTable.company_id, input.company_id),
                eq(CompanyDepartmentTable.department_key, input.department_key),
              ),
            )
            .get(),
        ),
      )
      const now = Date.now()
      const row = {
        id: existing?.id ?? Identifier.ascending("department"),
        company_id: input.company_id,
        department_key: input.department_key,
        name: input.name,
        purpose: input.purpose,
        status: "active",
        recurring_project_count: projects.length,
        evidence_json: JSON.stringify({
          capability_need_ids: needs.map((need) => need.id),
          project_ids: projects,
        }),
        time_created: existing?.time_created ?? now,
        time_updated: now,
      }
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(CompanyDepartmentTable)
            .values(row)
            .onConflictDoUpdate({
              target: [CompanyDepartmentTable.company_id, CompanyDepartmentTable.department_key],
              set: {
                name: row.name,
                purpose: row.purpose,
                status: row.status,
                recurring_project_count: row.recurring_project_count,
                evidence_json: row.evidence_json,
                time_updated: row.time_updated,
              },
            })
            .run(),
        ),
      )
      const selectedAgentIDs = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyTeamSelectionTable)
            .where(eq(CompanyTeamSelectionTable.company_id, input.company_id))
            .all()
            .filter(
              (selection) =>
                selection.decision === "selected" && needs.some((need) => need.id === selection.capability_need_id),
            )
            .map((selection) => selection.agent_id),
        ),
      )
      yield* Effect.forEach(
        [...new Set(selectedAgentIDs)],
        (agentID) =>
          Effect.gen(function* () {
            const agent = yield* agents.get(CompanyAgentID.make(agentID))
            if (agent?.lifecycle === "employee")
              yield* agents.update({ id: agent.id, department: input.department_key })
          }),
        { discard: true },
      )
      return departmentFromRow(row)
    })

    const snapshot = Effect.fn("CompanyRecruitment.snapshot")(function* (input: {
      company_id: CompanyID
      project_id?: string
    }) {
      const facts = yield* Effect.sync(() =>
        Database.use((db) => ({
          needs: db
            .select()
            .from(CompanyCapabilityNeedTable)
            .where(eq(CompanyCapabilityNeedTable.company_id, input.company_id))
            .orderBy(asc(CompanyCapabilityNeedTable.time_created), asc(CompanyCapabilityNeedTable.id))
            .all(),
          performances: db
            .select()
            .from(CompanyAgentPerformanceTable)
            .where(eq(CompanyAgentPerformanceTable.company_id, input.company_id))
            .orderBy(asc(CompanyAgentPerformanceTable.time_created), asc(CompanyAgentPerformanceTable.id))
            .all(),
          reviews: db
            .select()
            .from(CompanyEmploymentReviewTable)
            .where(eq(CompanyEmploymentReviewTable.company_id, input.company_id))
            .orderBy(asc(CompanyEmploymentReviewTable.time_created), asc(CompanyEmploymentReviewTable.id))
            .all(),
          departments: db
            .select()
            .from(CompanyDepartmentTable)
            .where(eq(CompanyDepartmentTable.company_id, input.company_id))
            .orderBy(asc(CompanyDepartmentTable.time_created), asc(CompanyDepartmentTable.id))
            .all(),
          assignments: db
            .select()
            .from(CompanyProjectAssignmentTable)
            .where(eq(CompanyProjectAssignmentTable.company_id, input.company_id))
            .orderBy(
              asc(CompanyProjectAssignmentTable.assigned_at),
              asc(CompanyProjectAssignmentTable.id),
            )
            .all(),
        })),
      )
      const needs = facts.needs
        .filter((row) => !input.project_id || row.project_id === input.project_id)
        .map(needFromRow)
      const needIDs = new Set(needs.map((need) => need.id))
      const assignments = facts.assignments
        .filter((row) => !input.project_id || row.project_id === input.project_id)
        .map(assignmentFromRow)
      const currentAgentIDs = new Set(
        assignments
          .filter((assignment) => assignment.status === "assigned" || assignment.status === "active")
          .map((assignment) => assignment.agent_id),
      )
      return {
        needs,
        selections: (yield* listSelections(input)).filter((selection) =>
          input.project_id ? needIDs.has(selection.capability_need_id) : true,
        ),
        assignments,
        performances: facts.performances
          .filter((row) => !input.project_id || row.project_id === input.project_id)
          .map(performanceFromRow),
        employment_reviews: facts.reviews.map(reviewFromRow),
        departments: facts.departments.map(departmentFromRow),
        candidate_pool: yield* agents.list({ company_id: input.company_id, lifecycle: "candidate" }),
        assigned_candidates: (yield* agents.list({ company_id: input.company_id })).filter((agent) =>
          currentAgentIDs.has(agent.id),
        ),
      }
    })

    return Service.of({
      createNeed,
      selectForNeed,
      selectAndAssign,
      reassign,
      listAssignments,
      releaseProject,
      recordPerformance,
      reviewEmployment,
      ensureDepartment,
      snapshot,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Layer.mergeAll(Company.defaultLayer, CompanyAgent.defaultLayer)),
)

export { stableCandidateAgentID, stableLogicalKey } from "./identity"
export * as CompanyRecruitment from "./company-recruitment"
