import { Context, Effect, Layer } from "effect"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import z from "zod"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { CompanyTable } from "@/company/company.sql"
import { CompanyCommons } from "@/company-commons"
import { CompanyCommonsSourceTable } from "@/company-commons/company-commons.sql"
import type { CommonsAccess } from "@/company-commons/schema"
import {
  CompanyProjectTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "@/company-project/company-project.sql"
import { Identifier } from "@/id/id"
import { ProjectOrchestrator } from "@/project-orchestrator/project-orchestrator"
import { Database } from "@/storage"
import * as FounderOSMode from "@/founder-os/mode"
import {
  CompanyAgentInterestProfileTable,
  CompanyInterpretationEvidenceTable,
  CompanyInterpretationTable,
  CompanyReadingAssignmentTable,
} from "./company-reading.sql"
import {
  AgentInterestProfile,
  AgentInterestProfileInput,
  Interpretation,
  KnowledgeReadingReceipt,
  ReadingAssignment,
  ReadingScheduleInput,
  ReadingScheduleResult,
  type AgentInterestProfile as AgentInterestProfileValue,
  type AgentInterestProfileInput as AgentInterestProfileInputValue,
  type Interpretation as InterpretationValue,
  type KnowledgeReadingReceipt as KnowledgeReadingReceiptValue,
  type ReadingAssignment as ReadingAssignmentValue,
  type ReadingScheduleInput as ReadingScheduleInputValue,
  type ReadingScheduleResult as ReadingScheduleResultValue,
} from "./schema"

const profileFromRow = (row: typeof CompanyAgentInterestProfileTable.$inferSelect) =>
  AgentInterestProfile.parse({
    company_id: row.company_id,
    agent_id: row.agent_id,
    topics: JSON.parse(row.topics_json),
    preferred_lenses: JSON.parse(row.preferred_lenses_json),
    excluded_topics: JSON.parse(row.excluded_topics_json),
    novelty_threshold: row.novelty_threshold,
    weekly_reading_budget: row.weekly_reading_budget,
    max_concurrency: row.max_concurrency,
    privacy_scopes: JSON.parse(row.privacy_scopes_json),
    updated_at: row.updated_at,
  })

const assignmentFromRow = (row: typeof CompanyReadingAssignmentTable.$inferSelect) =>
  ReadingAssignment.parse({
    ...row,
    linked_project_ids: JSON.parse(row.linked_project_ids_json),
    work_item_id: row.work_item_id ?? undefined,
    error: row.error ?? undefined,
    stopped_at: row.stopped_at ?? undefined,
  })

const interpretationFromRow = (
  row: typeof CompanyInterpretationTable.$inferSelect,
  reader_agent_name?: string,
) =>
  Interpretation.parse({
    id: row.id,
    source_id: row.source_id,
    reader_agent_id: row.reader_agent_id,
    reader_role: row.reader_role,
    work_receipt_id: row.work_receipt_id ?? undefined,
    work_item_id: row.work_item_id ?? undefined,
    reader_agent_name,
    core_thesis: row.core_thesis,
    important_claims: JSON.parse(row.important_claims_json),
    company_relevance: row.company_relevance,
    project_connections: JSON.parse(row.project_connections_json),
    agreement: row.agreement,
    conflicts: JSON.parse(row.conflicts_json),
    counter_arguments: JSON.parse(row.counter_arguments_json),
    inspiration: JSON.parse(row.inspiration_json),
    experiment_ideas: JSON.parse(row.experiment_ideas_json),
    disposition: row.disposition,
    confidence: row.confidence,
    evidence_refs: JSON.parse(row.evidence_refs_json),
    created_at: row.created_at,
  })

const tokens = (values: string[]) =>
  new Set(
    values
      .join(" ")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu) ?? [],
  )

const overlap = (left: Set<string>, right: Set<string>) => {
  if (!left.size || !right.size) return 0
  return [...left].filter((token) => right.has(token)).length / Math.min(left.size, right.size)
}

function effectiveReadingMode(company_id: string) {
  const company = Database.use((db) =>
    db.select().from(CompanyTable).where(eq(CompanyTable.id, company_id)).get(),
  )
  if (!company) throw new Error("Reading company was not found")
  return FounderOSMode.resolve({
    founderTwinMode: company.founder_twin_mode,
    companyCommonsMode: company.company_commons_mode,
  }).effective.companyCommonsMode
}

function requireReadingMode(company_id: string) {
  const mode = effectiveReadingMode(company_id)
  if (!["reading", "belief-loop"].includes(mode))
    throw new Error(`Company Commons effective mode ${mode} does not allow reading writes`)
}

const weekKey = (now = new Date()) => {
  const day = (now.getUTCDay() + 6) % 7
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day))
  return monday.toISOString().slice(0, 10)
}

export interface Interface {
  readonly upsertProfile: (input: AgentInterestProfileInputValue) => Effect.Effect<AgentInterestProfileValue>
  readonly getProfile: (agent_id: string, company_id: string) => Effect.Effect<AgentInterestProfileValue | undefined>
  readonly listProfiles: (company_id: string) => Effect.Effect<AgentInterestProfileValue[]>
  readonly schedule: (input: ReadingScheduleInputValue) => Effect.Effect<ReadingScheduleResultValue>
  readonly stop: (id: string, access: CommonsAccess) => Effect.Effect<ReadingAssignmentValue>
  readonly recover: () => Effect.Effect<{ recovered_assignment_ids: string[] }>
  readonly listAssignments: (access: CommonsAccess) => Effect.Effect<ReadingAssignmentValue[]>
  readonly createInterpretation: (
    receipt: KnowledgeReadingReceiptValue,
    access: CommonsAccess,
  ) => Effect.Effect<InterpretationValue>
  readonly consumeReceipt: (
    work_receipt_id: string,
    access: CommonsAccess,
  ) => Effect.Effect<InterpretationValue>
  readonly listInterpretations: (access: CommonsAccess, project_id?: string) => Effect.Effect<InterpretationValue[]>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyReading") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const commons = yield* CompanyCommons.Service
    const orchestrator = yield* ProjectOrchestrator.Service

    const upsertProfile = Effect.fn("CompanyReading.upsertProfile")(function* (
      raw: AgentInterestProfileInputValue,
    ) {
      const input = AgentInterestProfileInput.parse(raw)
      requireReadingMode(input.company_id)
      const agent = Database.use((db) =>
        db
          .select()
          .from(CompanyAgentTable)
          .where(and(eq(CompanyAgentTable.id, input.agent_id), eq(CompanyAgentTable.company_id, input.company_id)))
          .get(),
      )
      if (!agent) throw new Error("Interest Profile Agent does not belong to the company")
      const existingProfile = Database.use((db) =>
        db
          .select()
          .from(CompanyAgentInterestProfileTable)
          .where(eq(CompanyAgentInterestProfileTable.agent_id, input.agent_id))
          .get(),
      )
      if (
        !existingProfile &&
        Database.use((db) =>
          db
            .select()
            .from(CompanyAgentInterestProfileTable)
            .where(eq(CompanyAgentInterestProfileTable.company_id, input.company_id))
            .all(),
        ).length >= 3
      )
        throw new Error("A company can configure at most three Reader profiles")
      const row = {
        agent_id: input.agent_id,
        company_id: input.company_id,
        topics_json: JSON.stringify([...new Set(input.topics)].sort()),
        preferred_lenses_json: JSON.stringify([...new Set(input.preferred_lenses)].sort()),
        excluded_topics_json: JSON.stringify([...new Set(input.excluded_topics)].sort()),
        novelty_threshold: input.novelty_threshold,
        weekly_reading_budget: input.weekly_reading_budget,
        max_concurrency: input.max_concurrency,
        privacy_scopes_json: JSON.stringify([...new Set(input.privacy_scopes)].sort()),
        updated_at: Date.now(),
      }
      Database.use((db) =>
        db
          .insert(CompanyAgentInterestProfileTable)
          .values(row)
          .onConflictDoUpdate({ target: CompanyAgentInterestProfileTable.agent_id, set: row })
          .run(),
      )
      return profileFromRow(row)
    })

    const getProfile = Effect.fn("CompanyReading.getProfile")(function* (agent_id: string, company_id: string) {
      const row = Database.use((db) =>
        db
          .select()
          .from(CompanyAgentInterestProfileTable)
          .where(
            and(
              eq(CompanyAgentInterestProfileTable.agent_id, agent_id),
              eq(CompanyAgentInterestProfileTable.company_id, company_id),
            ),
          )
          .get(),
      )
      return row ? profileFromRow(row) : undefined
    })

    const listProfiles = Effect.fn("CompanyReading.listProfiles")(function* (company_id: string) {
      return Database.use((db) =>
        db
          .select()
          .from(CompanyAgentInterestProfileTable)
          .where(eq(CompanyAgentInterestProfileTable.company_id, company_id))
          .orderBy(asc(CompanyAgentInterestProfileTable.agent_id))
          .all()
          .map(profileFromRow),
      )
    })

    const persistScheduled = Effect.fn("CompanyReading.persistScheduled")(function* (
      assignment: ReadingAssignmentValue,
      source_title: string,
      agent_role: string,
    ) {
      const workItem = yield* orchestrator.scheduleKnowledgeReading({
        project_id: assignment.project_id,
        source_id: assignment.source_id,
        source_title,
        agent_id: assignment.agent_id,
        agent_role,
        idempotency_key: assignment.idempotency_key,
      })
      Database.use((db) =>
        db
          .update(CompanyReadingAssignmentTable)
          .set({
            work_item_id: workItem.id,
            status: workItem.status === "running" ? "running" : "scheduled",
            error: null,
            updated_at: Date.now(),
          })
          .where(eq(CompanyReadingAssignmentTable.id, assignment.id))
          .run(),
      )
      return assignmentFromRow(
        Database.use((db) =>
          db.select().from(CompanyReadingAssignmentTable).where(eq(CompanyReadingAssignmentTable.id, assignment.id)).get(),
        )!,
      )
    })

    const schedule = Effect.fn("CompanyReading.schedule")(function* (raw: ReadingScheduleInputValue) {
      const input = ReadingScheduleInput.parse(raw)
      requireReadingMode(input.company_id)
      if (!input.project_ids.includes(input.project_id))
        throw new Error("Reading project is outside the caller privacy scope")
      const source = yield* commons.get(input.source_id, input)
      if (
        !source ||
        source.source.capability_status !== "supported" ||
        source.source.ingestion_status !== "ready"
      )
        throw new Error("Commons source is not ready or not visible")
      const project = Database.use((db) =>
        db
          .select()
          .from(CompanyProjectTable)
          .where(
            and(
              eq(CompanyProjectTable.id, input.project_id),
              eq(CompanyProjectTable.company_id, input.company_id),
            ),
          )
          .get(),
      )
      if (!project) throw new Error("Reading project does not belong to the company")
      const profiles = yield* listProfiles(input.company_id)
      if (!profiles.length)
        return ReadingScheduleResult.parse({
          source_id: input.source_id,
          project_id: input.project_id,
          assignments: [],
          eligible_agent_count: 0,
        })
      const sourceTokens = tokens([
        source.source.title,
        ...source.source.tags,
        ...source.chunks.slice(0, 20).map((chunk) => chunk.body),
      ])
      const projectTokens = tokens([project.title, project.goal])
      const currentWeek = weekKey()
      const existingInterpretations = Database.use((db) =>
        db
          .select()
          .from(CompanyInterpretationTable)
          .where(eq(CompanyInterpretationTable.source_id, input.source_id))
          .all(),
      )
      const existingSourceAssignments = Database.use((db) =>
        db
          .select()
          .from(CompanyReadingAssignmentTable)
          .where(eq(CompanyReadingAssignmentTable.source_id, input.source_id))
          .all(),
      )
      const activeAssignments = Database.use((db) =>
        db
          .select()
          .from(CompanyReadingAssignmentTable)
          .where(
            and(
              inArray(CompanyReadingAssignmentTable.status, ["scheduling", "scheduled", "running"]),
              inArray(
                CompanyReadingAssignmentTable.agent_id,
                profiles.map((profile) => profile.agent_id),
              ),
            ),
          )
          .all(),
      )
      const budgetAssignments = Database.use((db) =>
        db
          .select()
          .from(CompanyReadingAssignmentTable)
          .where(
            and(
              eq(CompanyReadingAssignmentTable.budget_week, currentWeek),
              eq(CompanyReadingAssignmentTable.budget_reserved, true),
              inArray(
                CompanyReadingAssignmentTable.agent_id,
                profiles.map((profile) => profile.agent_id),
              ),
            ),
          )
          .all(),
      )
      const scored = profiles
        .flatMap((profile) => {
          const excluded = tokens(profile.excluded_topics)
          const existingAssignment = existingSourceAssignments.find(
            (assignment) => assignment.agent_id === profile.agent_id,
          )
          if (existingSourceAssignments.length && !existingAssignment) return []
          const novelty_score = existingInterpretations.some(
            (interpretation) => interpretation.reader_agent_id === profile.agent_id,
          )
            ? 0
            : 1
          const used = budgetAssignments.filter((assignment) => assignment.agent_id === profile.agent_id).length
          const active = activeAssignments.filter((assignment) => assignment.agent_id === profile.agent_id).length
          if (
            !profile.privacy_scopes.includes(source.source.privacy_scope) ||
            overlap(sourceTokens, excluded) > 0 ||
            (!existingAssignment && novelty_score < profile.novelty_threshold) ||
            (!existingAssignment && used >= profile.weekly_reading_budget) ||
            (!existingAssignment && active >= profile.max_concurrency)
          )
            return []
          const topicTokens = tokens([...profile.topics, ...profile.preferred_lenses])
          const relevance_score = (overlap(sourceTokens, topicTokens) + overlap(sourceTokens, projectTokens)) / 2
          const connected = existingInterpretations.some((interpretation) =>
            (JSON.parse(interpretation.project_connections_json) as Array<{ project_id: string }>).some(
              (connection) => connection.project_id === input.project_id,
            ),
          )
          const gap_score = connected ? 0.25 : 1
          const budget_score = profile.weekly_reading_budget
            ? (profile.weekly_reading_budget - used) / profile.weekly_reading_budget
            : 0
          return [{
            profile,
            relevance_score,
            novelty_score,
            gap_score,
            budget_score,
            total_score:
              relevance_score * 0.4 +
              novelty_score * 0.2 +
              gap_score * 0.25 +
              budget_score * 0.15,
          }]
        })
        .sort((left, right) => right.total_score - left.total_score || left.profile.agent_id.localeCompare(right.profile.agent_id))
        .slice(0, 3)
      const agentRows = Database.use((db) =>
        db
          .select()
          .from(CompanyAgentTable)
          .where(inArray(CompanyAgentTable.id, scored.map((entry) => entry.profile.agent_id)))
          .all(),
      )
      const assignments = yield* Effect.forEach(
        scored,
        (entry) =>
          Effect.gen(function* () {
            const idempotency_key = `knowledge-reading:${input.source_id}:${entry.profile.agent_id}`
            const existing = Database.use((db) =>
              db
                .select()
                .from(CompanyReadingAssignmentTable)
                .where(eq(CompanyReadingAssignmentTable.idempotency_key, idempotency_key))
                .get(),
            )
            if (existing && !["failed"].includes(existing.status)) {
              const linked_project_ids = [...new Set([
                ...(JSON.parse(existing.linked_project_ids_json) as string[]),
                input.project_id,
              ])].sort()
              if (JSON.stringify(linked_project_ids) !== existing.linked_project_ids_json)
                Database.use((db) =>
                  db
                    .update(CompanyReadingAssignmentTable)
                    .set({
                      linked_project_ids_json: JSON.stringify(linked_project_ids),
                      updated_at: Date.now(),
                    })
                    .where(eq(CompanyReadingAssignmentTable.id, existing.id))
                    .run(),
                )
              return assignmentFromRow({
                ...existing,
                linked_project_ids_json: JSON.stringify(linked_project_ids),
              })
            }
            const row = existing ?? {
              id: Identifier.ascending("readingAssignment"),
              source_id: input.source_id,
              company_id: input.company_id,
              agent_id: entry.profile.agent_id,
              project_id: input.project_id,
              linked_project_ids_json: JSON.stringify([input.project_id]),
              work_item_id: null,
              idempotency_key,
              status: "scheduling",
              relevance_score: entry.relevance_score,
              novelty_score: entry.novelty_score,
              gap_score: entry.gap_score,
              budget_score: entry.budget_score,
              total_score: entry.total_score,
              budget_week: currentWeek,
              budget_reserved: true,
              error: null,
              created_at: Date.now(),
              updated_at: Date.now(),
              stopped_at: null,
            }
            if (existing)
              Database.use((db) =>
                db
                  .update(CompanyReadingAssignmentTable)
                  .set({
                    status: "scheduling",
                    linked_project_ids_json: JSON.stringify([
                      ...new Set([
                        ...(JSON.parse(existing.linked_project_ids_json) as string[]),
                        input.project_id,
                      ]),
                    ].sort()),
                    budget_reserved: true,
                    error: null,
                    updated_at: Date.now(),
                  })
                  .where(eq(CompanyReadingAssignmentTable.id, existing.id))
                  .run(),
              )
            if (!existing) Database.use((db) => db.insert(CompanyReadingAssignmentTable).values(row).run())
            return yield* persistScheduled(
              assignmentFromRow({ ...row, status: "scheduling", budget_reserved: true, error: null }),
              source.source.title,
              agentRows.find((agent) => agent.id === entry.profile.agent_id)?.role_key ?? "Reader",
            ).pipe(
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  Database.use((db) =>
                    db
                      .update(CompanyReadingAssignmentTable)
                      .set({
                        status: "failed",
                        budget_reserved: false,
                        error: error instanceof Error ? error.message : String(error),
                        updated_at: Date.now(),
                      })
                      .where(eq(CompanyReadingAssignmentTable.id, row.id))
                      .run(),
                  )
                  return assignmentFromRow(
                    Database.use((db) =>
                      db.select().from(CompanyReadingAssignmentTable).where(eq(CompanyReadingAssignmentTable.id, row.id)).get(),
                    )!,
                  )
                }),
              ),
            )
          }),
        { concurrency: 1 },
      )
      return ReadingScheduleResult.parse({
        source_id: input.source_id,
        project_id: input.project_id,
        assignments,
        eligible_agent_count: scored.length,
      })
    })

    const listAssignments = Effect.fn("CompanyReading.listAssignments")(function* (access: CommonsAccess) {
      const rows = Database.use((db) =>
        db
          .select()
          .from(CompanyReadingAssignmentTable)
          .where(eq(CompanyReadingAssignmentTable.company_id, access.company_id))
          .orderBy(asc(CompanyReadingAssignmentTable.created_at), asc(CompanyReadingAssignmentTable.id))
          .all(),
      )
      return (yield* Effect.forEach(rows, (row) =>
        commons.get(row.source_id, access).pipe(
          Effect.map((source) => source ? assignmentFromRow(row) : undefined),
        ),
      )).filter((assignment): assignment is ReadingAssignmentValue => Boolean(assignment))
    })

    const stop = Effect.fn("CompanyReading.stop")(function* (id: string, access: CommonsAccess) {
      const assignment = (yield* listAssignments(access)).find((candidate) => candidate.id === id)
      if (!assignment) throw new Error("Reading assignment not found")
      if (assignment.status === "stopped" || assignment.status === "completed") return assignment
      if (assignment.work_item_id)
        yield* orchestrator.stopKnowledgeReading({
          project_id: assignment.project_id,
          work_item_id: assignment.work_item_id,
          reason: "Reading stopped by scheduler contract",
        })
      Database.use((db) =>
        db
          .update(CompanyReadingAssignmentTable)
          .set({
            status: "stopped",
            budget_reserved: false,
            stopped_at: Date.now(),
            updated_at: Date.now(),
          })
          .where(eq(CompanyReadingAssignmentTable.id, id))
          .run(),
      )
      return assignmentFromRow(
        Database.use((db) =>
          db.select().from(CompanyReadingAssignmentTable).where(eq(CompanyReadingAssignmentTable.id, id)).get(),
        )!,
      )
    })

    const consumeReceipt = Effect.fn("CompanyReading.consumeReceipt")(function* (
      work_receipt_id: string,
      access: CommonsAccess,
    ) {
      requireReadingMode(access.company_id)
      const workReceipt = Database.use((db) =>
        db.select().from(CompanyWorkReceiptTable).where(eq(CompanyWorkReceiptTable.id, work_receipt_id)).get(),
      )
      if (
        !workReceipt ||
        workReceipt.payload_kind !== "knowledge_reading" ||
        !workReceipt.typed_payload_json
      )
        throw new Error("Interpretation requires a persisted typed KNOWLEDGE_READING Work Receipt")
      const payload = z
        .object({
          kind: z.literal("knowledge_reading"),
          assignment_id: z.string().trim().min(1),
          receipt: KnowledgeReadingReceipt,
        })
        .strict()
        .parse(JSON.parse(workReceipt.typed_payload_json))
      const receipt = payload.receipt
      const source = yield* commons.get(receipt.source_id, access)
      if (!source) throw new Error("Interpretation source is not visible")
      const assignment = Database.use((db) =>
        db
          .select()
          .from(CompanyReadingAssignmentTable)
          .where(
            and(
              eq(CompanyReadingAssignmentTable.id, payload.assignment_id),
              eq(CompanyReadingAssignmentTable.company_id, access.company_id),
            ),
          )
          .get(),
      )
      if (
        !assignment ||
        assignment.source_id !== receipt.source_id ||
        assignment.agent_id !== receipt.reader_agent_id ||
        assignment.work_item_id !== receipt.work_item_id ||
        workReceipt.work_item_id !== receipt.work_item_id ||
        assignment.status === "stopped"
      )
        throw new Error("Interpretation does not match an active reading assignment")
      if (
        receipt.important_claims.some(
          (claim) => !receipt.evidence_refs.some((reference) => reference.claim === claim),
        )
      )
        throw new Error("Every important Interpretation claim requires a matching source-span evidence reference")
      const chunkByID = new Map(source.chunks.map((chunk) => [chunk.id, chunk]))
      if (
        receipt.evidence_refs.some((reference) => {
          const chunk = chunkByID.get(reference.chunk_id)
          return (
            !chunk ||
            reference.start_offset < chunk.start_offset ||
            reference.end_offset > chunk.end_offset ||
            reference.end_offset <= reference.start_offset
          )
        })
      )
        throw new Error("Interpretation evidence does not resolve to the assigned source span")
      if (
        receipt.project_connections.some(
          (connection) =>
            !Database.use((db) =>
              db
                .select()
                .from(CompanyProjectTable)
                .where(
                  and(
                    eq(CompanyProjectTable.id, connection.project_id),
                    eq(CompanyProjectTable.company_id, source.source.company_id),
                  ),
                )
                .get(),
            ),
        )
      )
        throw new Error("Interpretation project connection is outside the source company")
      const existing = Database.use((db) =>
        db
          .select()
          .from(CompanyInterpretationTable)
          .where(eq(CompanyInterpretationTable.work_receipt_id, work_receipt_id))
          .get(),
      )
      if (existing) return interpretationFromRow(existing)
      const existingForReader = Database.use((db) =>
        db
          .select()
          .from(CompanyInterpretationTable)
          .where(
            and(
              eq(CompanyInterpretationTable.source_id, receipt.source_id),
              eq(CompanyInterpretationTable.reader_agent_id, receipt.reader_agent_id),
            ),
          )
          .get(),
      )
      if (existingForReader)
        throw new Error("Interpretation source and Reader already consumed a different Work Receipt")
      const id = Identifier.ascending("interpretation")
      const row = {
        id,
        source_id: receipt.source_id,
        reader_agent_id: receipt.reader_agent_id,
        reader_role: receipt.reader_role,
        work_item_id: receipt.work_item_id,
        work_receipt_id,
        core_thesis: receipt.core_thesis,
        important_claims_json: JSON.stringify(receipt.important_claims),
        company_relevance: receipt.company_relevance,
        project_connections_json: JSON.stringify(receipt.project_connections),
        agreement: receipt.agreement,
        conflicts_json: JSON.stringify(receipt.conflicts),
        counter_arguments_json: JSON.stringify(receipt.counter_arguments),
        inspiration_json: JSON.stringify(receipt.inspiration),
        experiment_ideas_json: JSON.stringify(receipt.experiment_ideas),
        disposition: receipt.disposition,
        confidence: receipt.confidence,
        evidence_refs_json: JSON.stringify(receipt.evidence_refs),
        created_at: Date.now(),
      }
      Database.transaction((db) => {
        db.insert(CompanyInterpretationTable).values(row).run()
        db.insert(CompanyInterpretationEvidenceTable).values(
          receipt.evidence_refs.map((reference) => ({
            interpretation_id: id,
            ...reference,
          })),
        ).run()
        db.update(CompanyReadingAssignmentTable)
          .set({ status: "completed", budget_reserved: false, error: null, updated_at: Date.now() })
          .where(eq(CompanyReadingAssignmentTable.id, assignment.id))
          .run()
      })
      const agent = Database.use((db) =>
        db.select().from(CompanyAgentTable).where(eq(CompanyAgentTable.id, receipt.reader_agent_id)).get(),
      )
      return interpretationFromRow(row, agent?.name)
    })

    const createInterpretation = Effect.fn("CompanyReading.createInterpretation")(function* (
      rawReceipt: KnowledgeReadingReceiptValue,
      access: CommonsAccess,
    ) {
      const receipt = KnowledgeReadingReceipt.parse(rawReceipt)
      requireReadingMode(access.company_id)
      const assignment = Database.use((db) =>
        db
          .select()
          .from(CompanyReadingAssignmentTable)
          .where(
            and(
              eq(CompanyReadingAssignmentTable.company_id, access.company_id),
              eq(CompanyReadingAssignmentTable.source_id, receipt.source_id),
              eq(CompanyReadingAssignmentTable.agent_id, receipt.reader_agent_id),
              eq(CompanyReadingAssignmentTable.work_item_id, receipt.work_item_id),
            ),
          )
          .get(),
      )
      if (!assignment || assignment.status === "stopped")
        throw new Error("Knowledge reading Receipt does not match an active assignment")
      const source = yield* commons.get(receipt.source_id, access)
      if (!source) throw new Error("Knowledge reading Receipt source is not visible")
      if (
        receipt.important_claims.some(
          (claim) => !receipt.evidence_refs.some((reference) => reference.claim === claim),
        )
      )
        throw new Error("Every important Interpretation claim requires a matching source-span evidence reference")
      const chunkByID = new Map(source.chunks.map((chunk) => [chunk.id, chunk]))
      if (
        receipt.evidence_refs.some((reference) => {
          const chunk = chunkByID.get(reference.chunk_id)
          return (
            !chunk ||
            reference.start_offset < chunk.start_offset ||
            reference.end_offset > chunk.end_offset ||
            reference.end_offset <= reference.start_offset
          )
        })
      )
        throw new Error("Knowledge reading Receipt evidence does not resolve to the assigned source span")
      if (
        receipt.project_connections.some(
          (connection) =>
            !Database.use((db) =>
              db
                .select()
                .from(CompanyProjectTable)
                .where(
                  and(
                    eq(CompanyProjectTable.id, connection.project_id),
                    eq(CompanyProjectTable.company_id, access.company_id),
                  ),
                )
                .get(),
            ),
        )
      )
        throw new Error("Knowledge reading Receipt project connection is outside the source company")
      yield* orchestrator.completeKnowledgeReading({
        work_item_id: receipt.work_item_id,
        assignment_id: assignment.id,
        source_artifact_id: source.artifact.id,
        receipt,
      })
      const workReceipt = Database.use((db) =>
        db
          .select()
          .from(CompanyWorkReceiptTable)
          .where(eq(CompanyWorkReceiptTable.work_item_id, receipt.work_item_id))
          .orderBy(desc(CompanyWorkReceiptTable.created_at), desc(CompanyWorkReceiptTable.id))
          .get(),
      )
      if (!workReceipt) throw new Error("Knowledge reading Work Receipt was not persisted")
      return yield* consumeReceipt(workReceipt.id, access)
    })

    const listInterpretations = Effect.fn("CompanyReading.listInterpretations")(function* (
      access: CommonsAccess,
      project_id?: string,
    ) {
      const rows = Database.use((db) =>
        db.select().from(CompanyInterpretationTable).orderBy(asc(CompanyInterpretationTable.created_at)).all(),
      )
      const agents = Database.use((db) => db.select().from(CompanyAgentTable).all())
      return (yield* Effect.forEach(rows, (row) =>
        commons.get(row.source_id, access).pipe(
          Effect.map((source) => {
            if (!source) return
            const interpretation = interpretationFromRow(
              row,
              agents.find((agent) => agent.id === row.reader_agent_id)?.name,
            )
            if (
              project_id &&
              !interpretation.project_connections.some((connection) => connection.project_id === project_id)
            )
              return
            return interpretation
          }),
        ),
      )).filter((interpretation): interpretation is InterpretationValue => Boolean(interpretation))
    })

    const recover = Effect.fn("CompanyReading.recover")(function* () {
      const active = Database.use((db) =>
        db
          .select()
          .from(CompanyReadingAssignmentTable)
          .where(inArray(CompanyReadingAssignmentTable.status, ["scheduling", "scheduled", "running"]))
          .orderBy(asc(CompanyReadingAssignmentTable.created_at))
          .all(),
      )
      active
        .filter((row) => !["reading", "belief-loop"].includes(effectiveReadingMode(row.company_id)))
        .forEach((row) =>
          Database.use((db) =>
            db.update(CompanyReadingAssignmentTable).set({
              status: "stopped",
              budget_reserved: false,
              error: `Company Commons effective mode ${effectiveReadingMode(row.company_id)} stopped reading recovery`,
              updated_at: Date.now(),
              stopped_at: Date.now(),
            }).where(eq(CompanyReadingAssignmentTable.id, row.id)).run(),
          ),
        )
      const rows = active.filter((row) =>
        ["reading", "belief-loop"].includes(effectiveReadingMode(row.company_id)),
      )
      const recovered = yield* Effect.forEach(
        rows,
        (row) => {
          const mode = effectiveReadingMode(row.company_id)
          if (!["reading", "belief-loop"].includes(mode)) {
            Database.use((db) =>
              db.update(CompanyReadingAssignmentTable).set({
                status: "stopped",
                budget_reserved: false,
                error: `Company Commons effective mode ${mode} stopped reading recovery`,
                updated_at: Date.now(),
                stopped_at: Date.now(),
              }).where(eq(CompanyReadingAssignmentTable.id, row.id)).run(),
            )
            return Effect.succeed(undefined)
          }
          const source = Database.use((db) =>
            db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, row.work_item_id ?? "")).get(),
          )
          if (source) {
            if (source.status === "completed") {
              const receipt = Database.use((db) =>
                db
                  .select()
                  .from(CompanyWorkReceiptTable)
                  .where(eq(CompanyWorkReceiptTable.work_item_id, source.id))
                  .orderBy(desc(CompanyWorkReceiptTable.created_at), desc(CompanyWorkReceiptTable.id))
                  .get(),
              )
              if (!receipt) {
                Database.use((db) =>
                  db
                    .update(CompanyReadingAssignmentTable)
                    .set({
                      status: "failed",
                      budget_reserved: false,
                      error: "Completed reading WorkItem has no typed Work Receipt",
                      updated_at: Date.now(),
                    })
                    .where(eq(CompanyReadingAssignmentTable.id, row.id))
                    .run(),
                )
                return Effect.succeed(undefined)
              }
              return consumeReceipt(receipt.id, {
                company_id: row.company_id,
                project_ids: JSON.parse(row.linked_project_ids_json),
              }).pipe(
                Effect.map(() => row.id),
                Effect.catchAll((error) =>
                  Effect.sync(() => {
                    Database.use((db) =>
                      db
                        .update(CompanyReadingAssignmentTable)
                        .set({
                          status: "failed",
                          budget_reserved: false,
                          error: error instanceof Error ? error.message : String(error),
                          updated_at: Date.now(),
                        })
                        .where(eq(CompanyReadingAssignmentTable.id, row.id))
                        .run(),
                    )
                    return undefined
                  }),
                ),
              )
            }
            if (["failed", "superseded", "cancelled", "blocked"].includes(source.status)) {
              Database.use((db) =>
                db
                  .update(CompanyReadingAssignmentTable)
                  .set({
                    status: source.status === "cancelled" || source.status === "superseded" ? "stopped" : "failed",
                    budget_reserved: false,
                    error: `Reading WorkItem reached terminal status ${source.status}`,
                    updated_at: Date.now(),
                    stopped_at: source.status === "cancelled" || source.status === "superseded" ? Date.now() : null,
                  })
                  .where(eq(CompanyReadingAssignmentTable.id, row.id))
                  .run(),
              )
              return Effect.succeed(row.id)
            }
            Database.use((db) =>
              db
                .update(CompanyReadingAssignmentTable)
                .set({ status: source.status === "running" ? "running" : "scheduled", updated_at: Date.now() })
                .where(eq(CompanyReadingAssignmentTable.id, row.id))
                .run(),
            )
            return Effect.succeed(row.id)
          }
          if (row.status !== "scheduling") {
            Database.use((db) =>
              db
                .update(CompanyReadingAssignmentTable)
                .set({
                  status: "failed",
                  budget_reserved: false,
                  error: "Reading assignment lost its scheduled WorkItem",
                  updated_at: Date.now(),
                })
                .where(eq(CompanyReadingAssignmentTable.id, row.id))
                .run(),
            )
            return Effect.succeed(undefined)
          }
          const commonsSource = Database.use((db) =>
            db
              .select({ title: CompanyCommonsSourceTable.title })
              .from(CompanyCommonsSourceTable)
              .where(eq(CompanyCommonsSourceTable.id, row.source_id))
              .get(),
          )
          const agent = Database.use((db) =>
            db.select().from(CompanyAgentTable).where(eq(CompanyAgentTable.id, row.agent_id)).get(),
          )
          return persistScheduled(
            assignmentFromRow(row),
            commonsSource?.title ?? row.source_id,
            agent?.role_key ?? "Reader",
          ).pipe(
            Effect.map(() => row.id),
            Effect.catchAll((error) =>
              Effect.sync(() => {
                Database.use((db) =>
                  db
                    .update(CompanyReadingAssignmentTable)
                    .set({
                      status: "failed",
                      budget_reserved: false,
                      error: error instanceof Error ? error.message : String(error),
                      updated_at: Date.now(),
                    })
                    .where(eq(CompanyReadingAssignmentTable.id, row.id))
                    .run(),
                )
                return undefined
              }),
            ),
          )
        },
        { concurrency: 1 },
      )
      return {
        recovered_assignment_ids: recovered.filter((id): id is string => Boolean(id)),
      }
    })

    return Service.of({
      upsertProfile,
      getProfile,
      listProfiles,
      schedule,
      stop,
      recover,
      listAssignments,
      createInterpretation,
      consumeReceipt,
      listInterpretations,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CompanyCommons.defaultLayer),
  Layer.provide(ProjectOrchestrator.defaultLayer),
)
