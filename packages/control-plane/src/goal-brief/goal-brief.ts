import { and, asc, desc, eq, isNull } from "drizzle-orm"
import { parseTree, type Node, type ParseError } from "jsonc-parser"
import {
  GoalBrief,
  GoalBriefAppendRequest,
  GoalBriefCreateRequest,
  GoalBriefDraft,
  GoalBriefHistory,
  GoalBriefProjectView,
  GoalBriefStartRequest,
  GoalBriefStartResult,
  LegacyGoalBrief,
  type GoalBrief as GoalBriefValue,
  type GoalBriefDraft as GoalBriefDraftValue,
  type GoalBriefProjectView as GoalBriefProjectViewValue,
  type GoalBriefSource,
} from "@agents-company/shared/experience"
import { Database } from "@/storage"
import { Identifier } from "@/id/id"
import {
  CompanyProjectCharterTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
} from "@/company-project/company-project.sql"
import {
  GoalBriefGenerationRequestTable,
  GoalBriefStartRequestTable,
  GoalBriefTable,
  GoalBriefVersionTable,
} from "./goal-brief.sql"

const approvalModes = new Set(["autonomous", "balanced", "strict"])

function duplicateProperties(node: Node, path: string[] = []): string[] {
  if (node.type === "array")
    return (node.children ?? []).flatMap((child, index) => duplicateProperties(child, [...path, String(index)]))
  if (node.type !== "object") return []
  const seen = new Set<string>()
  return (node.children ?? []).flatMap((property) => {
    const key = property.children?.[0]?.value
    const value = property.children?.[1]
    if (typeof key !== "string") return value ? duplicateProperties(value, path) : []
    const current = [...path, key]
    const duplicate = seen.has(key) ? [current.join(".")] : []
    seen.add(key)
    return [...duplicate, ...(value ? duplicateProperties(value, current) : [])]
  })
}

export function parseModelJson(raw: string) {
  const errors: ParseError[] = []
  const tree = parseTree(raw, errors, { allowTrailingComma: false, disallowComments: true })
  if (!tree || errors.length) throw new Error("Goal Brief model output is not valid JSON")
  const duplicates = duplicateProperties(tree)
  if (duplicates.length) throw new Error(`Goal Brief model output contains duplicate fields: ${duplicates.join(", ")}`)
  return JSON.parse(raw) as unknown
}

export function parseModelOutput(raw: string) {
  return GoalBriefDraft.parse(parseModelJson(raw))
}

function rootFromRow(row: typeof GoalBriefTable.$inferSelect) {
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    sourceThreadId: row.source_thread_id ?? undefined,
  }
}

function versionFromRow(
  root: ReturnType<typeof rootFromRow>,
  row: typeof GoalBriefVersionTable.$inferSelect,
): GoalBriefValue {
  return GoalBrief.parse({
    ...root,
    version: row.version,
    goal: row.goal,
    deliverables: JSON.parse(row.deliverables_json) as unknown,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json) as unknown,
    constraints: JSON.parse(row.constraints_json) as unknown,
    nonGoals: JSON.parse(row.non_goals_json) as unknown,
    assumptions: JSON.parse(row.assumptions_json) as unknown,
    openQuestions: JSON.parse(row.open_questions_json) as unknown,
    riskLevel: row.risk_level,
    recommendedPlan: JSON.parse(row.recommended_plan_json) as unknown,
    approvalMode: row.approval_mode,
    source: row.source,
    sourceRefs: JSON.parse(row.source_refs_json) as unknown,
    createdAt: new Date(row.created_at).toISOString(),
  })
}

function versionValues(
  briefID: string,
  version: number,
  input: GoalBriefDraftValue,
  source: GoalBriefSource,
  createdAt: number,
) {
  return {
    brief_id: briefID,
    version,
    goal: input.goal,
    deliverables_json: JSON.stringify(input.deliverables),
    acceptance_criteria_json: JSON.stringify(input.acceptanceCriteria),
    constraints_json: JSON.stringify(input.constraints),
    non_goals_json: JSON.stringify(input.nonGoals),
    assumptions_json: JSON.stringify(input.assumptions),
    open_questions_json: JSON.stringify(input.openQuestions),
    risk_level: input.riskLevel,
    recommended_plan_json: JSON.stringify(input.recommendedPlan),
    approval_mode: input.approvalMode,
    source,
    source_refs_json: JSON.stringify(input.sourceRefs),
    created_at: createdAt,
  }
}

function projectEventValues(
  projectID: string,
  type: "goal_brief.created" | "goal_brief.versioned",
  briefID: string,
  version: number,
  source: GoalBriefSource,
  openQuestionCount: number,
  blockingQuestionCount: number,
  createdAt: number,
) {
  return {
    id: Identifier.ascending("event"),
    project_id: projectID,
    type,
    actor_id: source === "system_suggestion" ? "system" : "user",
    data_json: JSON.stringify({
      brief_id: briefID,
      version,
      source,
      open_question_count: openQuestionCount,
      blocking_question_count: blockingQuestionCount,
    }),
    created_at: createdAt,
  }
}

function createWithDatabase(
  db: Database.TxOrDb,
  input: ReturnType<typeof GoalBriefCreateRequest.parse>,
  id: string,
  now: number,
) {
  db.insert(GoalBriefTable)
    .values({
      id,
      project_id: input.projectId ?? null,
      source_thread_id: input.sourceThreadId ?? null,
      created_at: now,
      updated_at: now,
    })
    .run()
  db.insert(GoalBriefVersionTable)
    .values(versionValues(id, 1, input.brief, input.source, now))
    .run()
  if (input.projectId)
    db.insert(CompanyProjectEventTable)
      .values(
        projectEventValues(
          input.projectId,
          "goal_brief.created",
          id,
          1,
          input.source,
          input.brief.openQuestions.length,
          input.brief.openQuestions.filter((question) => question.blocking).length,
          now,
        ),
      )
      .run()
  return GoalBrief.parse({
    id,
    version: 1,
    projectId: input.projectId,
    sourceThreadId: input.sourceThreadId,
    source: input.source,
    createdAt: new Date(now).toISOString(),
    ...input.brief,
  })
}

function fromDatabase(db: Database.TxOrDb, briefID: string, version?: number) {
  const root = db.select().from(GoalBriefTable).where(eq(GoalBriefTable.id, briefID)).get()
  if (!root) return
  const row =
    version === undefined
      ? db
          .select()
          .from(GoalBriefVersionTable)
          .where(eq(GoalBriefVersionTable.brief_id, briefID))
          .orderBy(desc(GoalBriefVersionTable.version))
          .get()
      : db
          .select()
          .from(GoalBriefVersionTable)
          .where(and(eq(GoalBriefVersionTable.brief_id, briefID), eq(GoalBriefVersionTable.version, version)))
          .get()
  if (!row) return
  return versionFromRow(rootFromRow(root), row)
}

export function create(raw: unknown): GoalBriefValue {
  const input = GoalBriefCreateRequest.parse(raw)
  return Database.transaction((db) => createWithDatabase(db, input, `goalBrief_${crypto.randomUUID()}`, Date.now()), {
    behavior: "immediate",
  })
}

export type GenerationReservation =
  | { status: "reserved" }
  | { status: "pending" }
  | { status: "conflict" }
  | { status: "completed"; brief: GoalBriefValue }

export function reserveGeneration(
  requestID: string,
  payloadHash: string,
  ownerToken: string,
  now = Date.now(),
  leaseDuration = 30_000,
): GenerationReservation {
  return Database.transaction(
    (db) => {
      const existing = db
        .select()
        .from(GoalBriefGenerationRequestTable)
        .where(eq(GoalBriefGenerationRequestTable.request_id, requestID))
        .get()
      if (existing?.payload_hash !== undefined && existing.payload_hash !== payloadHash)
        return { status: "conflict" as const }
      if (existing?.brief_id) {
        const brief = existing.brief_version ? fromDatabase(db, existing.brief_id, existing.brief_version) : undefined
        if (!brief) throw new Error("Goal Brief generation binding references a missing Brief")
        return { status: "completed" as const, brief }
      }
      if (existing && existing.lease_expires_at > now) return { status: "pending" as const }
      if (existing) {
        db.update(GoalBriefGenerationRequestTable)
          .set({
            owner_token: ownerToken,
            lease_expires_at: now + leaseDuration,
            updated_at: now,
          })
          .where(eq(GoalBriefGenerationRequestTable.request_id, requestID))
          .run()
        return { status: "reserved" as const }
      }
      db.insert(GoalBriefGenerationRequestTable)
        .values({
          request_id: requestID,
          payload_hash: payloadHash,
          owner_token: ownerToken,
          lease_expires_at: now + leaseDuration,
          brief_id: null,
          brief_version: null,
          created_at: now,
          updated_at: now,
        })
        .run()
      return { status: "reserved" as const }
    },
    { behavior: "immediate" },
  )
}

export type GenerationCompletion =
  | { status: "completed"; brief: GoalBriefValue }
  | { status: "conflict" }
  | { status: "ownership_lost" }

export function extendGenerationLease(
  requestID: string,
  payloadHash: string,
  ownerToken: string,
  leaseDuration = 30_000,
) {
  const now = Date.now()
  return Database.transaction(
    (db) => {
      const reservation = db
        .select()
        .from(GoalBriefGenerationRequestTable)
        .where(
          and(
            eq(GoalBriefGenerationRequestTable.request_id, requestID),
            eq(GoalBriefGenerationRequestTable.payload_hash, payloadHash),
            eq(GoalBriefGenerationRequestTable.owner_token, ownerToken),
            isNull(GoalBriefGenerationRequestTable.brief_id),
          ),
        )
        .get()
      if (!reservation) return false
      db.update(GoalBriefGenerationRequestTable)
        .set({ lease_expires_at: now + leaseDuration, updated_at: now })
        .where(eq(GoalBriefGenerationRequestTable.request_id, requestID))
        .run()
      return true
    },
    { behavior: "immediate" },
  )
}

export function completeGeneration(
  requestID: string,
  payloadHash: string,
  ownerToken: string,
  raw: unknown,
): GenerationCompletion {
  const input = GoalBriefCreateRequest.parse(raw)
  return Database.transaction(
    (db) => {
      const existing = db
        .select()
        .from(GoalBriefGenerationRequestTable)
        .where(eq(GoalBriefGenerationRequestTable.request_id, requestID))
        .get()
      if (!existing) throw new Error("Goal Brief generation reservation is missing")
      if (existing.payload_hash !== payloadHash) return { status: "conflict" as const }
      if (existing.brief_id) {
        const brief = existing.brief_version ? fromDatabase(db, existing.brief_id, existing.brief_version) : undefined
        if (!brief) throw new Error("Goal Brief generation binding references a missing Brief")
        return { status: "completed" as const, brief }
      }
      if (existing.owner_token !== ownerToken) return { status: "ownership_lost" as const }
      const now = Date.now()
      const brief = createWithDatabase(db, input, `goalBrief_${crypto.randomUUID()}`, now)
      db.update(GoalBriefGenerationRequestTable)
        .set({ brief_id: brief.id, brief_version: brief.version, updated_at: now })
        .where(eq(GoalBriefGenerationRequestTable.request_id, requestID))
        .run()
      return { status: "completed" as const, brief }
    },
    { behavior: "immediate" },
  )
}

export function releaseGeneration(requestID: string, payloadHash: string, ownerToken: string) {
  Database.transaction(
    (db) => {
      db.update(GoalBriefGenerationRequestTable)
        .set({ lease_expires_at: 0, updated_at: Date.now() })
        .where(
          and(
            eq(GoalBriefGenerationRequestTable.request_id, requestID),
            eq(GoalBriefGenerationRequestTable.payload_hash, payloadHash),
            eq(GoalBriefGenerationRequestTable.owner_token, ownerToken),
            isNull(GoalBriefGenerationRequestTable.brief_id),
          ),
        )
        .run()
    },
    { behavior: "immediate" },
  )
}

export type StartReservation =
  | { status: "reserved"; brief: GoalBriefValue }
  | { status: "pending" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "version_conflict"; currentVersion: number }
  | { status: "blocked"; questionIDs: string[] }
  | { status: "completed"; result: ReturnType<typeof GoalBriefStartResult.parse> }

function completedStart(row: typeof GoalBriefStartRequestTable.$inferSelect) {
  if (!row.project_id || !row.run_id) return
  return GoalBriefStartResult.parse({
    briefId: row.brief_id,
    briefVersion: row.brief_version,
    projectId: row.project_id,
    runId: row.run_id,
    replayed: true,
  })
}

export function reserveStart(
  briefID: string,
  raw: unknown,
  ownerToken: string,
  now = Date.now(),
  leaseDuration = 30_000,
): StartReservation {
  const input = GoalBriefStartRequest.parse(raw)
  return Database.transaction(
    (db) => {
      const byRequest = db
        .select()
        .from(GoalBriefStartRequestTable)
        .where(eq(GoalBriefStartRequestTable.request_id, input.requestId))
        .get()
      if (
        byRequest &&
        (byRequest.brief_id !== briefID || byRequest.brief_version !== input.expectedVersion)
      )
        return { status: "conflict" as const }
      const byBrief =
        byRequest ??
        db
          .select()
          .from(GoalBriefStartRequestTable)
          .where(eq(GoalBriefStartRequestTable.brief_id, briefID))
          .get()
      if (byBrief) {
        const completed = completedStart(byBrief)
        if (completed) return { status: "completed" as const, result: completed }
        if (byBrief.request_id !== input.requestId) return { status: "pending" as const }
        if (byBrief.lease_expires_at > now) return { status: "pending" as const }
      }
      const brief = fromDatabase(db, briefID)
      if (!brief) return { status: "not_found" as const }
      if (brief.version !== input.expectedVersion)
        return { status: "version_conflict" as const, currentVersion: brief.version }
      if (brief.projectId) return { status: "conflict" as const }
      const questionIDs = brief.openQuestions
        .filter((question) => question.blocking || ["high", "critical"].includes(brief.riskLevel))
        .map((question) => question.id)
      if (questionIDs.length) return { status: "blocked" as const, questionIDs }
      if (byBrief) {
        db.update(GoalBriefStartRequestTable)
          .set({
            owner_token: ownerToken,
            lease_expires_at: now + leaseDuration,
            updated_at: now,
          })
          .where(eq(GoalBriefStartRequestTable.request_id, input.requestId))
          .run()
        return { status: "reserved" as const, brief }
      }
      db.insert(GoalBriefStartRequestTable)
        .values({
          request_id: input.requestId,
          brief_id: briefID,
          brief_version: input.expectedVersion,
          owner_token: ownerToken,
          lease_expires_at: now + leaseDuration,
          project_id: null,
          run_id: null,
          created_at: now,
          updated_at: now,
        })
        .run()
      return { status: "reserved" as const, brief }
    },
    { behavior: "immediate" },
  )
}

export function completeStart(
  requestID: string,
  ownerToken: string,
  projectID: string,
  runID: string,
) {
  return Database.transaction(
    (db) => {
      const request = db
        .select()
        .from(GoalBriefStartRequestTable)
        .where(eq(GoalBriefStartRequestTable.request_id, requestID))
        .get()
      if (!request) throw new Error("Goal Brief start reservation is missing")
      const completed = completedStart(request)
      if (completed) return completed
      if (request.owner_token !== ownerToken) throw new Error("Goal Brief start reservation ownership was lost")
      const brief = fromDatabase(db, request.brief_id, request.brief_version)
      if (!brief) throw new Error("Goal Brief start reservation references a missing Brief")
      if (brief.projectId && brief.projectId !== projectID)
        throw new Error("Goal Brief is already bound to another Project")
      const now = Date.now()
      if (!brief.projectId) {
        db.update(GoalBriefTable)
          .set({ project_id: projectID, updated_at: now })
          .where(eq(GoalBriefTable.id, brief.id))
          .run()
        db.insert(CompanyProjectEventTable)
          .values(
            projectEventValues(
              projectID,
              "goal_brief.created",
              brief.id,
              brief.version,
              brief.source,
              brief.openQuestions.length,
              brief.openQuestions.filter((question) => question.blocking).length,
              now,
            ),
          )
          .run()
      }
      db.update(GoalBriefStartRequestTable)
        .set({
          project_id: projectID,
          run_id: runID,
          lease_expires_at: 0,
          updated_at: now,
        })
        .where(eq(GoalBriefStartRequestTable.request_id, requestID))
        .run()
      return GoalBriefStartResult.parse({
        briefId: brief.id,
        briefVersion: brief.version,
        projectId: projectID,
        runId: runID,
        replayed: false,
      })
    },
    { behavior: "immediate" },
  )
}

export function releaseStart(requestID: string, ownerToken: string) {
  Database.transaction(
    (db) => {
      db.update(GoalBriefStartRequestTable)
        .set({ lease_expires_at: 0, updated_at: Date.now() })
        .where(
          and(
            eq(GoalBriefStartRequestTable.request_id, requestID),
            eq(GoalBriefStartRequestTable.owner_token, ownerToken),
            isNull(GoalBriefStartRequestTable.project_id),
          ),
        )
        .run()
    },
    { behavior: "immediate" },
  )
}

export type AppendResult =
  | { ok: true; brief: GoalBriefValue }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict"; currentVersion: number }

export function appendWithDatabase(
  db: Database.TxOrDb,
  briefID: string,
  raw: unknown,
  now = Date.now(),
): AppendResult {
  const input = GoalBriefAppendRequest.parse(raw)
  const root = db.select().from(GoalBriefTable).where(eq(GoalBriefTable.id, briefID)).get()
  if (!root) return { ok: false as const, reason: "not_found" as const }
  const current = db
    .select()
    .from(GoalBriefVersionTable)
    .where(eq(GoalBriefVersionTable.brief_id, briefID))
    .orderBy(desc(GoalBriefVersionTable.version))
    .get()
  if (!current) return { ok: false as const, reason: "not_found" as const }
  if (current.version !== input.expectedVersion)
    return { ok: false as const, reason: "version_conflict" as const, currentVersion: current.version }
  const version = current.version + 1
  const row = versionValues(briefID, version, input.brief, input.source, now)
  db.insert(GoalBriefVersionTable).values(row).run()
  db.update(GoalBriefTable).set({ updated_at: now }).where(eq(GoalBriefTable.id, briefID)).run()
  if (root.project_id)
    db.insert(CompanyProjectEventTable)
      .values(
        projectEventValues(
          root.project_id,
          "goal_brief.versioned",
          briefID,
          version,
          input.source,
          input.brief.openQuestions.length,
          input.brief.openQuestions.filter((question) => question.blocking).length,
          now,
        ),
      )
      .run()
  return {
    ok: true as const,
    brief: versionFromRow(rootFromRow(root), row),
  }
}

export function append(briefID: string, raw: unknown): AppendResult {
  return Database.transaction((db) => appendWithDatabase(db, briefID, raw), {
    behavior: "immediate",
  })
}

export function get(briefID: string, version?: number): GoalBriefValue | undefined {
  const root = Database.use((db) => db.select().from(GoalBriefTable).where(eq(GoalBriefTable.id, briefID)).get())
  if (!root) return undefined
  const query = Database.use((db) =>
    db
      .select()
      .from(GoalBriefVersionTable)
      .where(eq(GoalBriefVersionTable.brief_id, briefID))
      .orderBy(desc(GoalBriefVersionTable.version))
      .all(),
  )
  const row = version === undefined ? query[0] : query.find((item) => item.version === version)
  return row ? versionFromRow(rootFromRow(root), row) : undefined
}

export function history(briefID: string) {
  const root = Database.use((db) => db.select().from(GoalBriefTable).where(eq(GoalBriefTable.id, briefID)).get())
  if (!root) return undefined
  return GoalBriefHistory.parse({
    id: briefID,
    versions: Database.use((db) =>
      db
        .select()
        .from(GoalBriefVersionTable)
        .where(eq(GoalBriefVersionTable.brief_id, briefID))
        .orderBy(asc(GoalBriefVersionTable.version))
        .all(),
    ).map((row) => versionFromRow(rootFromRow(root), row)),
  })
}

function legacy(projectID: string): GoalBriefProjectViewValue | undefined {
  const row = Database.use((db) =>
    db
      .select({ project: CompanyProjectTable, charter: CompanyProjectCharterTable })
      .from(CompanyProjectTable)
      .innerJoin(CompanyProjectCharterTable, eq(CompanyProjectCharterTable.project_id, CompanyProjectTable.id))
      .where(eq(CompanyProjectTable.id, projectID))
      .get(),
  )
  if (!row) return undefined
  const policy = JSON.parse(row.charter.policy_json) as unknown
  const approvalMode =
    typeof policy === "object" &&
    policy !== null &&
    "source_approval_preset" in policy &&
    typeof policy.source_approval_preset === "string" &&
    approvalModes.has(policy.source_approval_preset)
      ? policy.source_approval_preset
      : undefined
  if (!approvalMode) return undefined
  return GoalBriefProjectView.parse({
    kind: "legacy_charter",
    brief: LegacyGoalBrief.parse({
      id: `legacy:${projectID}`,
      version: 1,
      projectId: projectID,
      goal: row.project.goal,
      deliverables: JSON.parse(row.charter.deliverables_json) as unknown,
      acceptanceCriteria: JSON.parse(row.charter.acceptance_criteria_json) as unknown,
      constraints: JSON.parse(row.charter.constraints_json) as unknown,
      nonGoals: JSON.parse(row.charter.non_goals_json) as unknown,
      assumptions: [],
      openQuestions: JSON.parse(row.charter.open_decisions_json) as unknown,
      riskLevel: null,
      recommendedPlan: null,
      approvalMode,
      sourceRefs: [
        { kind: "project", id: projectID },
        { kind: "legacy_charter", id: projectID, version: 1 },
      ],
      source: "legacy_charter",
      missingFields: ["riskLevel", "recommendedPlan"],
      createdAt: new Date(row.charter.created_at).toISOString(),
    }),
  })
}

export function projectView(projectID: string): GoalBriefProjectViewValue | undefined {
  const root = Database.use((db) =>
    db.select().from(GoalBriefTable).where(eq(GoalBriefTable.project_id, projectID)).get(),
  )
  if (!root) return legacy(projectID)
  const current = get(root.id)
  return current ? GoalBriefProjectView.parse({ kind: "goal_brief", brief: current }) : undefined
}
