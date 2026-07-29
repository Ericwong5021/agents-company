import { and, desc, eq, inArray, notInArray } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import z from "zod"
import {
  GoalBriefDraft,
  GoalBriefUserSource,
  type GoalBrief as GoalBriefValue,
  type GoalBriefSource,
} from "@agents-company/shared/experience"
import { GoalBriefStore } from "@/goal-brief"
import { GoalBriefTable, GoalBriefVersionTable } from "@/goal-brief/goal-brief.sql"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import * as CompanyAttention from "./attention"
import { actionFromRow } from "./attention"
import {
  CompanyApprovalGateTable,
  CompanyPlanTable,
  CompanyProjectActionTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkItemTable,
} from "./company-project.sql"
import {
  Plan,
  type Plan as PlanValue,
  type ProjectActionRecord as ProjectActionRecordValue,
} from "./schema"

export const AdjustDirectionRequest = z
  .object({
    project_id: z.string().trim().min(1),
    brief_id: z.string().trim().min(1),
    attention_id: z.string().trim().min(1).optional(),
    idempotency_key: z.string().trim().min(1).max(500),
    expected_graph_revision: z.number().int().nonnegative(),
    expected_brief_version: z.number().int().positive(),
    expected_plan_version: z.number().int().positive(),
    source: GoalBriefUserSource,
    brief: GoalBriefDraft,
    change_reason: z.string().trim().min(1).max(8_000),
  })
  .strict()
export type AdjustDirectionRequest = z.infer<typeof AdjustDirectionRequest>

export const AdjustDirectionPayload = AdjustDirectionRequest.pick({
  brief_id: true,
  expected_brief_version: true,
  expected_plan_version: true,
  source: true,
  brief: true,
  change_reason: true,
}).strict()

export const RestoreDirectionCheckpointRequest = z
  .object({
    project_id: z.string().trim().min(1),
    action_id: z.string().trim().min(1),
    checkpoint_id: z.string().trim().min(1),
    brief_id: z.string().trim().min(1),
    expected_graph_revision: z.number().int().nonnegative(),
    expected_brief_version: z.number().int().positive(),
    expected_plan_version: z.number().int().positive(),
    brief: GoalBriefDraft,
    change_reason: z.string().trim().min(1).max(8_000),
  })
  .strict()
export type RestoreDirectionCheckpointRequest = z.infer<typeof RestoreDirectionCheckpointRequest>

export const RestoreDirectionCheckpointPayload = RestoreDirectionCheckpointRequest.omit({
  project_id: true,
  action_id: true,
  expected_graph_revision: true,
}).strict()

export const ApplyFounderDirectionRequest = z
  .object({
    project_id: z.string().trim().min(1),
    action_id: z.string().trim().min(1),
    checkpoint_id: z.string().trim().min(1),
    brief_id: z.string().trim().min(1),
    expected_graph_revision: z.number().int().nonnegative(),
    expected_brief_version: z.number().int().positive(),
    expected_plan_version: z.number().int().positive(),
    brief: GoalBriefDraft,
    change_reason: z.string().trim().min(1).max(8_000),
  })
  .strict()
export type ApplyFounderDirectionRequest = z.infer<typeof ApplyFounderDirectionRequest>

export const ApplyFounderDirectionPayload = ApplyFounderDirectionRequest.omit({
  project_id: true,
  action_id: true,
  expected_graph_revision: true,
}).strict()
export type ApplyFounderDirectionPayload = z.infer<typeof ApplyFounderDirectionPayload>

type DirectionChangeRequest = Omit<AdjustDirectionRequest, "source"> & {
  source: GoalBriefSource
}

const AppliedBinding = z
  .object({
    brief_id: z.string(),
    brief_version: z.number().int().positive(),
    plan_id: z.string(),
    plan_version: z.number().int().positive(),
    graph_revision: z.number().int().nonnegative(),
  })
  .strict()

export type AdjustDirectionResult =
  | {
      status: "applied"
      brief: GoalBriefValue
      plan: PlanValue
      action: ProjectActionRecordValue
      replayed: boolean
    }
  | {
      status: "rejected"
      reason: string
      conflict?: Record<string, unknown>
      action: ProjectActionRecordValue
      replayed: boolean
    }

export type Boundary =
  | "after_brief_version"
  | "after_plan_version"
  | "after_action_apply"
  | "after_commit"

export type Hooks = {
  onBoundary?: (boundary: Boundary) => void
}

function planFromRow(row: typeof CompanyPlanTable.$inferSelect) {
  return Plan.parse({
    ...row,
    assumptions: JSON.parse(row.assumptions_json),
    acceptance_criteria: JSON.parse(row.acceptance_criteria_json),
    change_reason: row.change_reason ?? undefined,
  })
}

function eventValues(
  project_id: string,
  type: string,
  data: Record<string, unknown>,
  actor_id: string,
  created_at: number,
) {
  return {
    id: Identifier.ascending("event"),
    project_id,
    type,
    actor_id,
    data_json: JSON.stringify(data),
    created_at,
  }
}

function applied(action: ProjectActionRecordValue, replayed: boolean): AdjustDirectionResult {
  const binding = AppliedBinding.parse(action.result)
  const brief = GoalBriefStore.get(binding.brief_id, binding.brief_version)
  const plan = Database.use((db) =>
    db.select().from(CompanyPlanTable).where(eq(CompanyPlanTable.id, binding.plan_id)).get(),
  )
  if (!brief || !plan) throw new Error(`Direction action ${action.id} references missing versions`)
  return {
    status: "applied",
    brief,
    plan: planFromRow(plan),
    action,
    replayed,
  }
}

function rejected(action: ProjectActionRecordValue, replayed: boolean): AdjustDirectionResult {
  return {
    status: "rejected",
    reason: action.error ?? "action_rejected",
    conflict: action.result,
    action,
    replayed,
  }
}

function rejectWithDatabase(
  db: Database.TxOrDb,
  row: typeof CompanyProjectActionTable.$inferSelect,
  reason: string,
  conflict: Record<string, unknown>,
  now: number,
) {
  db.update(CompanyProjectActionTable)
    .set({
      status: "rejected",
      result_json: JSON.stringify(conflict),
      error: reason,
      updated_at: now,
      finished_at: now,
    })
    .where(
      and(
        eq(CompanyProjectActionTable.id, row.id),
        eq(CompanyProjectActionTable.status, "claimed"),
      ),
    )
    .run()
  db.insert(CompanyProjectEventTable)
    .values(
      eventValues(
        row.project_id,
        "project_action.rejected",
        { action_id: row.id, error: reason },
        "user",
        now,
      ),
    )
    .run()
  return actionFromRow(
    db.select().from(CompanyProjectActionTable).where(eq(CompanyProjectActionTable.id, row.id)).get()!,
  )
}

function applyWithDatabase(
  input: DirectionChangeRequest,
  action_id: string,
  replayed: boolean,
  hooks: Hooks,
): AdjustDirectionResult {
  return Database.transaction(
    (db) => {
      const row = db
        .select()
        .from(CompanyProjectActionTable)
        .where(eq(CompanyProjectActionTable.id, action_id))
        .get()
      if (!row) throw new Error(`Project action not found: ${action_id}`)
      const currentAction = actionFromRow(row)
      if (currentAction.status === "applied") return applied(currentAction, true)
      if (currentAction.status === "rejected") return rejected(currentAction, true)
      if (currentAction.status !== "claimed")
        throw new Error(`Project action ${action_id} cannot adjust direction from ${currentAction.status}`)

      const project = db
        .select()
        .from(CompanyProjectTable)
        .where(eq(CompanyProjectTable.id, input.project_id))
        .get()
      if (!project) throw new Error(`Company project not found: ${input.project_id}`)
      const briefRoot = db
        .select()
        .from(GoalBriefTable)
        .where(eq(GoalBriefTable.id, input.brief_id))
        .get()
      const briefVersion = briefRoot
        ? db
            .select()
            .from(GoalBriefVersionTable)
            .where(eq(GoalBriefVersionTable.brief_id, input.brief_id))
            .orderBy(desc(GoalBriefVersionTable.version))
            .get()
        : undefined
      const plan = db
        .select()
        .from(CompanyPlanTable)
        .where(eq(CompanyPlanTable.project_id, input.project_id))
        .orderBy(desc(CompanyPlanTable.version))
        .get()
      const conflict = {
        expected_graph_revision: input.expected_graph_revision,
        current_graph_revision: project.graph_revision,
        expected_brief_version: input.expected_brief_version,
        current_brief_version: briefVersion?.version ?? null,
        expected_plan_version: input.expected_plan_version,
        current_plan_version: plan?.version ?? null,
      }
      const now = Date.now()
      if (project.graph_revision !== input.expected_graph_revision)
        return rejected(
          rejectWithDatabase(db, row, "project_revision_conflict", conflict, now),
          replayed,
        )
      if (!briefRoot || !briefVersion)
        return rejected(rejectWithDatabase(db, row, "brief_not_found", conflict, now), replayed)
      if (briefRoot.project_id !== input.project_id)
        return rejected(
          rejectWithDatabase(db, row, "brief_project_mismatch", conflict, now),
          replayed,
        )
      if (briefVersion.version !== input.expected_brief_version)
        return rejected(
          rejectWithDatabase(db, row, "brief_version_conflict", conflict, now),
          replayed,
        )
      if (!plan)
        return rejected(rejectWithDatabase(db, row, "plan_not_found", conflict, now), replayed)
      if (
        plan.version !== input.expected_plan_version ||
        project.active_plan_version !== input.expected_plan_version
      )
        return rejected(
          rejectWithDatabase(db, row, "plan_version_conflict", conflict, now),
          replayed,
        )
      if (plan.status !== "active")
        return rejected(rejectWithDatabase(db, row, "plan_not_active", conflict, now), replayed)
      if (
        (project.status === "executing" && !project.dispatch_paused) ||
        db
          .select({ id: CompanyWorkItemTable.id })
          .from(CompanyWorkItemTable)
          .where(
            and(
              eq(CompanyWorkItemTable.project_id, input.project_id),
              eq(CompanyWorkItemTable.plan_id, plan.id),
              eq(CompanyWorkItemTable.status, "running"),
            ),
          )
          .get()
      )
        return rejected(rejectWithDatabase(db, row, "direction_requires_pause", conflict, now), replayed)
      if (
        briefVersion.goal === input.brief.goal &&
        briefVersion.deliverables_json === JSON.stringify(input.brief.deliverables) &&
        briefVersion.acceptance_criteria_json === JSON.stringify(input.brief.acceptanceCriteria) &&
        briefVersion.constraints_json === JSON.stringify(input.brief.constraints) &&
        briefVersion.non_goals_json === JSON.stringify(input.brief.nonGoals) &&
        briefVersion.assumptions_json === JSON.stringify(input.brief.assumptions) &&
        briefVersion.open_questions_json === JSON.stringify(input.brief.openQuestions) &&
        briefVersion.risk_level === input.brief.riskLevel &&
        briefVersion.recommended_plan_json === JSON.stringify(input.brief.recommendedPlan) &&
        briefVersion.approval_mode === input.brief.approvalMode &&
        briefVersion.source_refs_json === JSON.stringify(input.brief.sourceRefs)
      )
        return rejected(rejectWithDatabase(db, row, "brief_unchanged", conflict, now), replayed)

      const brief = GoalBriefStore.appendWithDatabase(
        db,
        input.brief_id,
        {
          expectedVersion: input.expected_brief_version,
          source: input.source,
          brief: input.brief,
        },
        now,
      )
      if (!brief.ok) throw new Error(`Goal Brief CAS changed inside direction transaction: ${brief.reason}`)
      hooks.onBoundary?.("after_brief_version")

      const plan_id = Identifier.ascending("companyPlan")
      const plan_version = plan.version + 1
      db.update(CompanyPlanTable)
        .set({ status: "superseded" })
        .where(
          and(
            eq(CompanyPlanTable.id, plan.id),
            eq(CompanyPlanTable.status, "active"),
          ),
        )
        .run()
      db.insert(CompanyPlanTable)
        .values({
          id: plan_id,
          project_id: input.project_id,
          version: plan_version,
          phase: "replan",
          status: "active",
          summary: input.brief.recommendedPlan.summary,
          assumptions_json: JSON.stringify(
            input.brief.assumptions.map((assumption) => assumption.description),
          ),
          acceptance_criteria_json: JSON.stringify(
            input.brief.acceptanceCriteria.map((criterion) => criterion.description),
          ),
          change_reason: input.change_reason,
          created_at: now,
        })
        .run()
      const supersededWorkItemIds = db
        .select({ id: CompanyWorkItemTable.id })
        .from(CompanyWorkItemTable)
        .where(
          and(
            eq(CompanyWorkItemTable.project_id, input.project_id),
            eq(CompanyWorkItemTable.plan_id, plan.id),
            notInArray(CompanyWorkItemTable.status, ["completed", "superseded", "cancelled"]),
          ),
        )
        .all()
        .map((item) => item.id)
      if (supersededWorkItemIds.length)
        db.update(CompanyWorkItemTable)
          .set({
            status: "superseded",
            error: `Superseded by active plan ${plan_id}`,
            updated_at: now,
          })
          .where(
            and(
              eq(CompanyWorkItemTable.project_id, input.project_id),
              eq(CompanyWorkItemTable.plan_id, plan.id),
              notInArray(CompanyWorkItemTable.status, ["completed", "superseded", "cancelled"]),
            ),
          )
          .run()
      if (supersededWorkItemIds.length)
        db.update(CompanyApprovalGateTable)
          .set({
            status: "rejected",
            decision_note: `Superseded by active plan ${plan_id}`,
            decided_at: now,
          })
          .where(
            and(
              eq(CompanyApprovalGateTable.project_id, input.project_id),
              eq(CompanyApprovalGateTable.status, "pending"),
              inArray(CompanyApprovalGateTable.work_item_id, supersededWorkItemIds),
            ),
          )
          .run()
      hooks.onBoundary?.("after_plan_version")

      const graph_revision = project.graph_revision + 1
      db.update(CompanyProjectTable)
        .set({
          goal: input.brief.goal,
          active_plan_version: plan_version,
          graph_revision,
          updated_at: now,
        })
        .where(
          and(
            eq(CompanyProjectTable.id, input.project_id),
            eq(CompanyProjectTable.graph_revision, input.expected_graph_revision),
          ),
        )
        .run()
      db.insert(CompanyProjectEventTable)
        .values([
          eventValues(
            input.project_id,
            "plan.created",
            {
              plan_id,
              version: plan_version,
              phase: "replan",
              brief_id: input.brief_id,
              brief_version: brief.brief.version,
              action_id,
            },
            "user",
            now,
          ),
          eventValues(
            input.project_id,
            "project.direction_adjusted",
            {
              action_id,
              brief_id: input.brief_id,
              brief_version: brief.brief.version,
              plan_id,
              plan_version,
              graph_revision,
              superseded_work_item_ids: supersededWorkItemIds,
            },
            "user",
            now,
          ),
        ])
        .run()
      const binding = AppliedBinding.parse({
        brief_id: input.brief_id,
        brief_version: brief.brief.version,
        plan_id,
        plan_version,
        graph_revision,
      })
      db.update(CompanyProjectActionTable)
        .set({
          status: "applied",
          result_json: JSON.stringify(binding),
          updated_at: now,
          finished_at: now,
        })
        .where(
          and(
            eq(CompanyProjectActionTable.id, action_id),
            eq(CompanyProjectActionTable.status, "claimed"),
          ),
        )
        .run()
      db.insert(CompanyProjectEventTable)
        .values(
          eventValues(
            input.project_id,
            "project_action.applied",
            { action_id },
            "user",
            now,
          ),
        )
        .run()
      hooks.onBoundary?.("after_action_apply")
      return {
        status: "applied",
        brief: brief.brief,
        plan: planFromRow(
          db.select().from(CompanyPlanTable).where(eq(CompanyPlanTable.id, plan_id)).get()!,
        ),
        action: actionFromRow(
          db
            .select()
            .from(CompanyProjectActionTable)
            .where(eq(CompanyProjectActionTable.id, action_id))
            .get()!,
        ),
        replayed,
      }
    },
    { behavior: "immediate" },
  )
}

export interface Interface {
  readonly adjust: (input: AdjustDirectionRequest) => Effect.Effect<AdjustDirectionResult>
  readonly restoreCheckpoint: (
    input: RestoreDirectionCheckpointRequest,
  ) => Effect.Effect<AdjustDirectionResult>
  readonly applyFounderDirection: (
    input: ApplyFounderDirectionRequest,
  ) => Effect.Effect<AdjustDirectionResult>
}

export class Service extends Context.Service<Service, Interface>()(
  "@control-plane/CompanyProjectDirection",
) {}

export function makeLayer(hooks: Hooks = {}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const attention = yield* CompanyAttention.Service
      return Service.of({
        adjust: (raw) =>
          Effect.gen(function* () {
            const input = AdjustDirectionRequest.parse(raw)
            const requested = yield* attention.requestAction({
              project_id: input.project_id,
              attention_id: input.attention_id,
              action: "adjust_brief",
              idempotency_key: input.idempotency_key,
              expected_revision: input.expected_graph_revision,
              payload: {
                brief_id: input.brief_id,
                expected_brief_version: input.expected_brief_version,
                expected_plan_version: input.expected_plan_version,
                source: input.source,
                brief: input.brief,
                change_reason: input.change_reason,
              },
            })
            const claimed =
              requested.record.status === "requested"
                ? yield* attention.claimAction(requested.record.id)
                : requested
            if (claimed.record.status === "rejected")
              return rejected(claimed.record, requested.replayed || claimed.replayed)
            if (claimed.record.status === "applied") return applied(claimed.record, true)
            const result = yield* Effect.sync(() =>
              applyWithDatabase(
                input,
                claimed.record.id,
                requested.replayed || claimed.replayed,
                hooks,
              ),
            )
            hooks.onBoundary?.("after_commit")
            return result
          }),
        restoreCheckpoint: (raw) =>
          Effect.gen(function* () {
            const input = RestoreDirectionCheckpointRequest.parse(raw)
            const result = yield* Effect.sync(() =>
              applyWithDatabase(
                {
                  project_id: input.project_id,
                  brief_id: input.brief_id,
                  idempotency_key: `restore-direction:${input.checkpoint_id}`,
                  expected_graph_revision: input.expected_graph_revision,
                  expected_brief_version: input.expected_brief_version,
                  expected_plan_version: input.expected_plan_version,
                  source: "system_suggestion",
                  brief: input.brief,
                  change_reason: input.change_reason,
                },
                input.action_id,
                false,
                hooks,
              ),
            )
            if (result.status === "applied" && result.brief.goal !== input.brief.goal)
              throw new Error("Direction checkpoint restore did not reproduce the checkpoint goal")
            hooks.onBoundary?.("after_commit")
            return result
          }),
        applyFounderDirection: (raw) =>
          Effect.gen(function* () {
            const input = ApplyFounderDirectionRequest.parse(raw)
            const result = yield* Effect.sync(() =>
              applyWithDatabase(
                {
                  project_id: input.project_id,
                  brief_id: input.brief_id,
                  idempotency_key: `apply-founder-direction:${input.checkpoint_id}`,
                  expected_graph_revision: input.expected_graph_revision,
                  expected_brief_version: input.expected_brief_version,
                  expected_plan_version: input.expected_plan_version,
                  source: "system_suggestion",
                  brief: input.brief,
                  change_reason: input.change_reason,
                },
                input.action_id,
                false,
                hooks,
              ),
            )
            if (result.status === "applied" && result.brief.goal !== input.brief.goal)
              throw new Error("Founder direction handler did not apply the requested goal")
            hooks.onBoundary?.("after_commit")
            return result
          }),
      })
    }),
  )
}

export const layer = makeLayer()
export const defaultLayer = layer.pipe(Layer.provide(CompanyAttention.defaultLayer))
