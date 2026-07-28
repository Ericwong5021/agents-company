import { Context, Effect, Layer } from "effect"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import z from "zod"
import { AgentRunTable } from "@/agent-run/agent-run.sql"
import { CompanyAgent } from "@/company-agent"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { CompanyAgentID } from "@/company-agent/schema"
import { CompanyProjectTable, CompanyWorkItemTable } from "@/company-project/company-project.sql"
import { ProjectStatus } from "@/company-project/schema"
import { CompanyTable } from "@/company/company.sql"
import { CompanyID } from "@/company/schema"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import {
  CompanyAgentCapabilityTable,
  CompanyAgentPerformanceTable,
  CompanyCapabilityNeedTable,
  CompanyDepartmentTable,
  CompanyEmploymentReviewTable,
  CompanyTeamSelectionTable,
} from "./company-recruitment.sql"
import {
  AgentCapability,
  AgentCapabilityQuery,
  AgentPerformance,
  CapabilityNeed,
  CreateCapabilityNeedInput,
  Department,
  DepartmentRecurringDemandNotProven,
  EmploymentReview,
  EnsureDepartmentInput,
  PerformanceProjectNotCompleted,
  RecordPerformanceInput,
  ReviewEmploymentInput,
  SelectionScore,
  SelectForNeedInput,
  TeamSelection,
} from "./schema"
import {
  capabilityAvailability,
  declaredPacksFromProfile,
  evidenceStatus,
  runtimeCompatibility,
} from "./capability-evidence"
import {
  compareCandidates,
  hardGaps,
  selectionScore,
  softGaps,
  unverifiedRequiredPacks,
  verifiedPacks,
  type CandidateFacts,
} from "./selection-policy"
import { stableCandidateAgentID } from "./identity"

const parseList = (value: string) => z.array(z.string()).parse(JSON.parse(value))
const needFromRow = (row: typeof CompanyCapabilityNeedTable.$inferSelect) =>
  CapabilityNeed.parse({
    ...row,
    capability_packs: parseList(row.capability_packs_json),
    department_key: row.department_key ?? undefined,
  })
const selectionFromRow = (row: typeof CompanyTeamSelectionTable.$inferSelect) =>
  TeamSelection.parse({
    ...row,
    gaps: parseList(row.gaps_json),
    score: JSON.parse(row.score_json),
    time_released: row.time_released ?? undefined,
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
const capabilityFromRow = (
  row: typeof CompanyAgentCapabilityTable.$inferSelect,
  preferredRuntime: string,
  now: number,
) => {
  const facts = {
    capability_pack: row.capability_pack,
    declared_at: row.declared_at,
    last_verified_at: row.last_verified_at ?? undefined,
    last_success_selection_id: row.last_success_selection_id ?? undefined,
    failure_count: row.failure_count,
    last_failure_at: row.last_failure_at ?? undefined,
  }
  const availability = capabilityAvailability(facts, preferredRuntime)
  return AgentCapability.parse({
    ...row,
    ...facts,
    last_failure_summary: row.last_failure_summary ?? undefined,
    status: evidenceStatus(facts, now),
    available: availability.available,
    availability_reasons: availability.reasons,
  })
}
const normalizeCapabilityPacks = (values: string[]) => [...new Set(values)].toSorted()
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

export interface Interface {
  readonly createNeed: (input: CreateCapabilityNeedInput) => Effect.Effect<CapabilityNeed>
  readonly selectForNeed: (input: SelectForNeedInput) => Effect.Effect<SelectionResult>
  readonly listCapabilities: (input: AgentCapabilityQuery) => Effect.Effect<AgentCapability[]>
  readonly releaseProject: (input: { company_id: CompanyID; project_id: string }) => Effect.Effect<TeamSelection[]>
  readonly recordPerformance: (input: RecordPerformanceInput) => Effect.Effect<AgentPerformance>
  readonly reviewEmployment: (
    input: ReviewEmploymentInput,
  ) => Effect.Effect<{ review: EmploymentReview; eligible: boolean; unmet_conditions: string[] }>
  readonly ensureDepartment: (input: EnsureDepartmentInput) => Effect.Effect<Department>
  readonly snapshot: (input: { company_id: CompanyID; project_id?: string }) => Effect.Effect<{
    needs: CapabilityNeed[]
    selections: TeamSelection[]
    performances: AgentPerformance[]
    employment_reviews: EmploymentReview[]
    departments: Department[]
    capabilities: AgentCapability[]
    candidate_pool: CompanyAgent.Info[]
    assigned_candidates: CompanyAgent.Info[]
    organization: {
      board_members: CompanyAgent.Info[]
      employees: CompanyAgent.Info[]
      temporary_instances: CompanyAgent.Info[]
      reused_candidates: CompanyAgent.Info[]
      candidate_pool: CompanyAgent.Info[]
    }
  }>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyRecruitment") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
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
      company_id: CompanyID
      project_id?: string
      capability_need_id?: string
    }) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyTeamSelectionTable)
            .where(eq(CompanyTeamSelectionTable.company_id, input.company_id))
            .orderBy(asc(CompanyTeamSelectionTable.time_created), asc(CompanyTeamSelectionTable.id))
            .all(),
        ),
      )
      return rows
        .filter((row) => !input.project_id || row.project_id === input.project_id)
        .filter((row) => !input.capability_need_id || row.capability_need_id === input.capability_need_id)
        .map(selectionFromRow)
    })

    const seedDeclaredCapabilities = (
      companyID: CompanyID,
      agentID: string,
      packs: string[],
      source: "profile" | "selection",
    ) =>
      Effect.sync(() =>
        Database.transaction((tx) => {
          const now = Date.now()
          packs.forEach((pack) =>
            tx
              .insert(CompanyAgentCapabilityTable)
              .values({
                id: Identifier.ascending("agentCapability"),
                company_id: companyID,
                agent_id: agentID,
                capability_pack: pack,
                source,
                declared_at: now,
                failure_count: 0,
                time_created: now,
                time_updated: now,
              })
              .onConflictDoNothing()
              .run(),
          )
        }),
      )

    const listCapabilities = Effect.fn("CompanyRecruitment.listCapabilities")(function* (
      raw: AgentCapabilityQuery,
    ) {
      const input = AgentCapabilityQuery.parse(raw)
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CompanyAgentCapabilityTable)
            .where(eq(CompanyAgentCapabilityTable.company_id, input.company_id))
            .orderBy(asc(CompanyAgentCapabilityTable.time_created), asc(CompanyAgentCapabilityTable.id))
            .all(),
        ),
      )
      const filtered = rows.filter((row) => !input.agent_id || row.agent_id === input.agent_id)
      const runtimes = new Map<string, string>()
      yield* Effect.forEach(
        [...new Set(filtered.map((row) => row.agent_id))],
        (agentID) =>
          Effect.map(agents.get(CompanyAgentID.make(agentID)), (agent) => {
            runtimes.set(agentID, agent?.preferred_runtime ?? "unknown")
          }),
        { discard: true },
      )
      const now = Date.now()
      return filtered.map((row) => capabilityFromRow(row, runtimes.get(row.agent_id) ?? "unknown", now))
    })

    const createNeed = Effect.fn("CompanyRecruitment.createNeed")(function* (raw: CreateCapabilityNeedInput) {
      const parsed = CreateCapabilityNeedInput.parse(raw)
      const input = { ...parsed, capability_packs: normalizeCapabilityPacks(parsed.capability_packs) }
      return yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const company = db.select().from(CompanyTable).where(eq(CompanyTable.id, input.company_id)).get()
            const project = db
              .select()
              .from(CompanyProjectTable)
              .where(eq(CompanyProjectTable.id, input.project_id))
              .get()
            if (!company) throw new Error(`Company not found: ${input.company_id}`)
            if (!project) throw new Error(`Company project not found: ${input.project_id}`)
            if (project.company_id && project.company_id !== input.company_id)
              throw new Error(`Company project ${input.project_id} belongs to another company`)
            const now = Date.now()
            db.insert(CompanyCapabilityNeedTable)
              .values({
                id: Identifier.ascending("capabilityNeed"),
                company_id: input.company_id,
                project_id: input.project_id,
                need_key: input.need_key,
                role: input.role,
                work_type: input.work_type,
                capability_packs_json: JSON.stringify(input.capability_packs),
                risk_level: input.risk_level,
                demand_horizon: input.demand_horizon,
                department_key: input.department_key ?? null,
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
              current.role !== input.role ||
              current.work_type !== input.work_type ||
              JSON.stringify(normalizeCapabilityPacks(current.capability_packs)) !==
                JSON.stringify(input.capability_packs) ||
              current.risk_level !== input.risk_level ||
              current.demand_horizon !== input.demand_horizon ||
              current.department_key !== input.department_key
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

    // TEAM-04: gather verifiable facts only; scoring and hard constraints live
    // in the pure selection-policy layer so they stay deterministic and testable.
    const candidateFacts = Effect.fn("CompanyRecruitment.candidateFacts")(function* (
      need: CapabilityNeed,
      agent: CompanyAgent.Info,
      excluded: boolean,
      capabilities: AgentCapability[],
    ) {
      const wanted = terms([need.role, need.work_type, ...need.capability_packs].join(" "))
      const profile = terms(
        [agent.name, agent.role_key, agent.description, ...(agent.skills ?? []), ...(agent.responsibilities ?? [])].join(
          " ",
        ),
      )
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
      return {
        agent_id: agent.id,
        lifecycle: agent.lifecycle,
        excluded,
        compatibility: runtimeCompatibility(agent.preferred_runtime, need.capability_packs),
        capability_match: [...wanted].filter((term) => profile.has(term)).length,
        evidence: capabilities
          .filter((item) => item.agent_id === agent.id && need.capability_packs.includes(item.capability_pack))
          .map((item) => ({ capability_pack: item.capability_pack, status: item.status, available: item.available })),
        required_packs: need.capability_packs,
        risk_level: need.risk_level,
        state,
      } satisfies CandidateFacts
    })

    const ensureRoleKey = Effect.fn("CompanyRecruitment.ensureRoleKey")(function* (
      need: CapabilityNeed,
      agent: CompanyAgent.Info,
    ) {
      if (agent.role_key) return agent
      yield* Effect.sync(() =>
        Database.use((db) => {
          const existing = db
            .select()
            .from(CompanyAgentTable)
            .where(
              and(
                eq(CompanyAgentTable.company_id, need.company_id),
                eq(CompanyAgentTable.role_key, need.role),
              ),
            )
            .get()
          const roleKey = existing && existing.id !== agent.id ? `${need.role} (${agent.id})` : need.role
          db.update(CompanyAgentTable)
            .set({ role_key: roleKey, time_updated: Date.now() })
            .where(and(eq(CompanyAgentTable.id, agent.id), isNull(CompanyAgentTable.role_key)))
            .run()
        }),
      )
      const updated = yield* agents.get(agent.id)
      if (!updated) throw new Error(`Selected company agent not found: ${agent.id}`)
      return updated
    })

    const selectForNeed = Effect.fn("CompanyRecruitment.selectForNeed")(function* (raw: SelectForNeedInput) {
      const input = SelectForNeedInput.parse(raw)
      const need = yield* getNeed(input.capability_need_id)
      if (!need) throw new Error(`Capability need not found: ${input.capability_need_id}`)
      const previous = yield* listSelections({
        company_id: need.company_id,
        capability_need_id: need.id,
      })
      const previousSelected = previous.find((item) => item.decision === "selected" && !item.time_released)
      if (previousSelected) {
        const agent = yield* agents.get(CompanyAgentID.make(previousSelected.agent_id))
        if (!agent) throw new Error(`Selected company agent not found: ${previousSelected.agent_id}`)
        return { need, agent: yield* ensureRoleKey(need, agent), selections: previous }
      }

      const pool = (yield* agents.list({ company_id: need.company_id })).filter(
        (agent) => agent.lifecycle !== "archived",
      )
      yield* Effect.forEach(
        pool,
        (agent) => seedDeclaredCapabilities(need.company_id, agent.id, declaredPacksFromProfile(agent), "profile"),
        { discard: true },
      )
      const capabilities = yield* listCapabilities({ company_id: need.company_id })
      const scored = yield* Effect.forEach(pool, (agent) =>
        Effect.map(
          candidateFacts(need, agent, input.exclude_agent_ids.includes(agent.id), capabilities),
          (facts) => ({ agent, facts, score: selectionScore(facts), hard_gaps: hardGaps(facts) }),
        ),
      )
      // Hard constraints gate eligibility first; only then does the deterministic
      // soft-score comparator order the remaining candidates.
      const ranked = scored
        .filter((item) => item.hard_gaps.length === 0)
        .toSorted((left, right) =>
          compareCandidates(
            { agent_id: left.agent.id, score: left.score },
            { agent_id: right.agent.id, score: right.score },
          ),
        )
      const rankOf = new Map(ranked.map((item, index) => [item.agent.id, index + 1]))
      const selected = ranked[0]
      const chosen = selected
        ? { ...selected, source: "company_pool" as const }
        : yield* Effect.gen(function* () {
            const id = stableCandidateAgentID(need)
            const existing = yield* agents.get(id)
            if (existing && existing.company_id !== need.company_id)
              throw new Error(`Generated candidate ID is already owned by another company: ${id}`)
            const agent =
              existing ??
              (yield* agents.create({
                id,
                company_id: need.company_id,
                name: need.role,
                role_key: yield* Effect.sync(() =>
                  Database.use((db) => {
                    const existing = db
                      .select()
                      .from(CompanyAgentTable)
                      .where(
                        and(
                          eq(CompanyAgentTable.company_id, need.company_id),
                          eq(CompanyAgentTable.role_key, need.role),
                        ),
                      )
                      .get()
                    return existing && existing.id !== id ? `${need.role} (${id})` : need.role
                  }),
                ),
                lifecycle: "candidate",
                description: `为“${need.role}”能力需求进入候选池的 ${need.work_type} Agent。`,
                system_prompt: `你以候选 Agent 身份承担“${need.role}”临时责任，只在当前 Work Item 的能力、资源和权限边界内行动。`,
                model: need.risk_level === "high" ? "ultra" : "standard",
                org_layer: "execution",
                responsibilities: [need.role, need.work_type, ...need.capability_packs],
              }))
            return {
              agent,
              score: SelectionScore.parse({
                capability_match: terms([need.role, need.work_type, ...need.capability_packs].join(" ")).size,
                evidence_strength: 0,
                availability: 100,
                historical_quality: 50,
                historical_reliability: 50,
                cost_efficiency: 50,
                speed: 50,
                risk_fit: need.risk_level === "high" ? 40 : 80,
                reuse_value: 0,
                total: 100,
              }),
              excluded: false,
              source: "new_candidate" as const,
            }
          })

      yield* ensureRoleKey(need, chosen.agent)
      yield* seedDeclaredCapabilities(need.company_id, chosen.agent.id, need.capability_packs, "selection")
      const now = Date.now()
      const rows = [
        ...scored.map((item) => {
          const rank = rankOf.get(item.agent.id) ?? 0
          const isChosen = item.agent.id === chosen.agent.id
          const gaps = isChosen
            ? unverifiedRequiredPacks(item.facts).map((pack) => `能力包 ${pack} 的证据尚未验证`)
            : item.hard_gaps.length
              ? item.hard_gaps
              : softGaps(item, selected!)
          const reason = isChosen
            ? `入选：能力匹配 ${item.score.capability_match} 项，能力证据强度 ${item.score.evidence_strength}（已验证 ${verifiedPacks(item.facts).length}/${need.capability_packs.length} 项能力包），负载可用性 ${item.score.availability}，历史质量 ${item.score.historical_quality}，可靠性 ${item.score.historical_reliability}；以单人覆盖该能力需求。`
            : item.hard_gaps.length
              ? `未入选：${item.hard_gaps.join("；")}。`
              : rank === 2
                ? `未入选（第二候选）：总评 ${item.score.total} 仅次于入选者 ${selected!.score.total}${gaps.length ? `；缺口：${gaps.join("；")}` : "；按确定性同分规则排后"}。`
                : `未入选：总评 ${item.score.total} 排名第 ${rank}，低于入选者 ${selected!.score.total}${gaps.length ? `；缺口：${gaps.join("；")}` : ""}。`
          return {
            id: Identifier.ascending("teamSelection"),
            company_id: need.company_id,
            project_id: need.project_id,
            capability_need_id: need.id,
            agent_id: item.agent.id,
            decision: isChosen ? "selected" : "rejected",
            source: "company_pool",
            lifecycle_at_selection: item.agent.lifecycle,
            candidate_rank: rank,
            reason,
            gaps_json: JSON.stringify(gaps),
            score_json: JSON.stringify(item.score),
            time_released: null,
            time_created: now,
            time_updated: now,
          }
        }),
        ...(scored.some((item) => item.agent.id === chosen.agent.id)
          ? []
          : [
              {
                id: Identifier.ascending("teamSelection"),
                company_id: need.company_id,
                project_id: need.project_id,
                capability_need_id: need.id,
                agent_id: chosen.agent.id,
                decision: "selected",
                source: chosen.source,
                lifecycle_at_selection: chosen.agent.lifecycle,
                candidate_rank: 1,
                reason: `入选：现有池无人满足硬性条件（${
                  scored.length
                    ? scored.map((item) => `${item.agent.id}：${item.hard_gaps.join("、")}`).join("；")
                    : "候选池为空"
                }），显式创建临时角色而非强行选人；覆盖 ${chosen.score.capability_match} 项能力。`,
                gaps_json: "[]",
                score_json: JSON.stringify(chosen.score),
                time_released: null,
                time_created: now,
                time_updated: now,
              },
            ]),
      ]
      yield* Effect.sync(() =>
        Database.transaction((tx) => {
          rows.forEach((row) =>
            tx
              .insert(CompanyTeamSelectionTable)
              .values(row)
              .onConflictDoUpdate({
                target: [
                  CompanyTeamSelectionTable.capability_need_id,
                  CompanyTeamSelectionTable.agent_id,
                ],
                set: {
                  decision: row.decision,
                  source: row.source,
                  lifecycle_at_selection: row.lifecycle_at_selection,
                  candidate_rank: row.candidate_rank,
                  reason: row.reason,
                  gaps_json: row.gaps_json,
                  score_json: row.score_json,
                  time_released: null,
                  time_updated: row.time_updated,
                },
              })
              .run(),
          )
        }),
      )
      const agent = yield* agents.assign(chosen.agent.id)
      return {
        need,
        agent,
        selections: yield* listSelections({ company_id: need.company_id, capability_need_id: need.id }),
      }
    })

    const releaseProject = Effect.fn("CompanyRecruitment.releaseProject")(function* (input: {
      company_id: CompanyID
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
        }),
      )
      yield* Effect.forEach(
        [...new Set(selected.map((item) => item.agent_id))],
        (agentID) =>
          Effect.gen(function* () {
            const facts = yield* Effect.sync(() =>
              Database.use((db) => ({
                selections: db
                  .select()
                  .from(CompanyTeamSelectionTable)
                  .where(eq(CompanyTeamSelectionTable.agent_id, agentID))
                  .all()
                  .filter((item) => item.decision === "selected"),
                // TEAM-05：真实任务证据 = 本项目已完成的工作项，或任意项目的成功交付记录。
                completed_work_items: db
                  .select({ id: CompanyWorkItemTable.id })
                  .from(CompanyWorkItemTable)
                  .where(
                    and(
                      eq(CompanyWorkItemTable.project_id, input.project_id),
                      eq(CompanyWorkItemTable.owner_agent_id, agentID),
                      eq(CompanyWorkItemTable.status, "completed"),
                    ),
                  )
                  .all().length,
                success_count: db
                  .select()
                  .from(CompanyAgentPerformanceTable)
                  .where(eq(CompanyAgentPerformanceTable.agent_id, agentID))
                  .all()
                  .filter((item) => item.outcome === "success").length,
              })),
            )
            const activeElsewhere = facts.selections.some(
              (item) => item.time_released === null && item.project_id !== input.project_id,
            )
            if (activeElsewhere) return
            const released = yield* agents.release(CompanyAgentID.make(agentID))
            if (released.lifecycle !== "candidate") return
            if (facts.completed_work_items > 0 || facts.success_count > 0) return
            const temporary = selected.some(
              (item) => item.agent_id === agentID && item.source === "new_candidate",
            )
            if (!temporary) return
            // TEAM-05：临时角色实例未沉淀任何真实任务证据，不进入候选池，直接退役并留存审计记录。
            yield* agents.archive(released.id)
            const now = Date.now()
            yield* Effect.sync(() =>
              Database.use((db) =>
                db
                  .insert(CompanyEmploymentReviewTable)
                  .values({
                    id: Identifier.ascending("employmentReview"),
                    company_id: input.company_id,
                    agent_id: agentID,
                    status: "retired",
                    selected_project_count: new Set(facts.selections.map((item) => item.project_id)).size,
                    successful_project_count: 0,
                    average_quality_score: 0,
                    average_reliability_score: 0,
                    recurring_need_count: 0,
                    rationale: `临时角色实例在项目 ${input.project_id} 释放时无已完成工作项与成功交付记录，不进入候选池，直接退役。`,
                    decision_note: null,
                    time_decided: now,
                    time_created: now,
                    time_updated: now,
                  })
                  .run(),
              ),
            )
          }),
        { discard: true },
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
      // Delivery outcomes feed capability evidence: success refreshes verification,
      // failure is recorded as a fact but never permanently revokes the capability.
      const needForSelection = yield* getNeed(selection.capability_need_id)
      const firstOutcomeRecord = !existing || existing.outcome !== input.outcome
      if (needForSelection)
        yield* Effect.sync(() =>
          Database.transaction((tx) => {
            needForSelection.capability_packs.forEach((pack) =>
              tx
                .insert(CompanyAgentCapabilityTable)
                .values({
                  id: Identifier.ascending("agentCapability"),
                  company_id: selection.company_id,
                  agent_id: selection.agent_id,
                  capability_pack: pack,
                  source: "delivery",
                  declared_at: now,
                  last_verified_at: input.outcome === "success" ? now : null,
                  last_success_selection_id: input.outcome === "success" ? selection.id : null,
                  failure_count: input.outcome === "failure" ? 1 : 0,
                  last_failure_at: input.outcome === "failure" ? now : null,
                  last_failure_summary: input.outcome === "failure" ? input.review_summary : null,
                  time_created: now,
                  time_updated: now,
                })
                .onConflictDoUpdate({
                  target: [CompanyAgentCapabilityTable.agent_id, CompanyAgentCapabilityTable.capability_pack],
                  set:
                    input.outcome === "success"
                      ? { last_verified_at: now, last_success_selection_id: selection.id, time_updated: now }
                      : {
                          ...(firstOutcomeRecord
                            ? { failure_count: sql`${CompanyAgentCapabilityTable.failure_count} + 1` }
                            : {}),
                          last_failure_at: now,
                          last_failure_summary: input.review_summary,
                          time_updated: now,
                        },
                })
                .run(),
            )
          }),
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
        })),
      )
      const needs = facts.needs
        .filter((row) => !input.project_id || row.project_id === input.project_id)
        .map(needFromRow)
      const needIDs = new Set(needs.map((need) => need.id))
      const candidatePool = yield* agents.list({ company_id: input.company_id, lifecycle: "candidate" })
      const assignedCandidates = yield* agents.list({ company_id: input.company_id, lifecycle: "assigned" })
      const employees = yield* agents.list({ company_id: input.company_id, lifecycle: "employee" })
      // TEAM-05：组织视图区分临时角色实例与正式员工；临时实例 = 在岗且活跃入选来源为 new_candidate。
      const temporaryIDs = new Set(
        (yield* listSelections({ company_id: input.company_id }))
          .filter((item) => item.decision === "selected" && !item.time_released && item.source === "new_candidate")
          .map((item) => item.agent_id),
      )
      return {
        needs,
        selections: (yield* listSelections(input)).filter((selection) =>
          input.project_id ? needIDs.has(selection.capability_need_id) : true,
        ),
        performances: facts.performances
          .filter((row) => !input.project_id || row.project_id === input.project_id)
          .map(performanceFromRow),
        employment_reviews: facts.reviews.map(reviewFromRow),
        departments: facts.departments.map(departmentFromRow),
        capabilities: yield* listCapabilities({ company_id: input.company_id }),
        candidate_pool: candidatePool,
        assigned_candidates: assignedCandidates,
        organization: {
          board_members: employees.filter((agent) => agent.org_layer === "board"),
          employees: employees.filter((agent) => agent.org_layer !== "board"),
          temporary_instances: assignedCandidates.filter((agent) => temporaryIDs.has(agent.id)),
          reused_candidates: assignedCandidates.filter((agent) => !temporaryIDs.has(agent.id)),
          candidate_pool: candidatePool,
        },
      }
    })

    return Service.of({
      createNeed,
      selectForNeed,
      listCapabilities,
      releaseProject,
      recordPerformance,
      reviewEmployment,
      ensureDepartment,
      snapshot,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CompanyAgent.defaultLayer))

export { stableCandidateAgentID, stableLogicalKey } from "./identity"
export * as CompanyRecruitment from "./company-recruitment"
