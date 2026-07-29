import { createHash } from "node:crypto"
import { lstat, mkdir, rename } from "node:fs/promises"
import path from "node:path"
import { AgentRunEventTable, AgentRunTable, AgentRunUsageTable } from "@/agent-run/agent-run.sql"
import {
  CompanyCapabilityNeedTable,
  CompanyAgentPerformanceTable,
  CompanyProjectAssignmentTable,
  CompanyTeamSelectionTable,
} from "@/company-recruitment/company-recruitment.sql"
import {
  CompanyApprovalGateTable,
  CompanyArtifactTable,
  CompanyAttentionTable,
  CompanyGraphDecisionTable,
  CompanyGraphMutationTable,
  CompanyProjectActionTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyValidationRepairTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "@/company-project/company-project.sql"
import * as CompanyRollout from "@/company-rollout/company-rollout"
import {
  CompanyRolloutCandidateTable,
  CompanyRolloutLocalRepeatTable,
  CompanyRolloutRollbackTable,
  CompanyRolloutShadowEvaluationTable,
} from "@/company-rollout/company-rollout.sql"
import { GoalBriefTable } from "@/goal-brief/goal-brief.sql"
import { and, asc, count, eq, inArray } from "@/storage"
import { Database } from "@/storage"
import {
  MetricContract,
  MetricSourceRef,
  type MetricContract as MetricContractValue,
  type MetricSourceRef as MetricSourceRefValue,
} from "@agents-company/shared/seed-grow-metrics"
import z from "zod"
import {
  bindPersistedFactArtifact,
  PersistedFactArtifact,
  PersistedFactArtifactReference,
  persistedMetricContractDigest,
  PersistedFactRunBinding,
  type PersistedFactRunBinding as PersistedFactRunBindingValue,
  type PersistedMetricEvent,
} from "./persisted-fact-artifact"

const CandidateSha = z.string().regex(/^[a-f0-9]{40}$/)
const Identifier = z.string().trim().min(1).max(500)
const Timestamp = z.string().datetime()
const JSONRecord = z.record(z.string(), z.unknown())
const SourceReference = z
  .object({
    kind: z.string().trim().min(1),
    id: z.string().trim().min(1),
  })
  .passthrough()
const Window = z
  .object({
    id: Identifier,
    startedAt: Timestamp,
    endedAt: Timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.endedAt) > Date.parse(value.startedAt)) return
    context.addIssue({ code: "custom", message: "Fact window must end after it starts" })
  })

export const PersistedFactExportRequest = z
  .object({
    id: Identifier,
    candidateSha: CandidateSha,
    metricContract: MetricContract,
    window: Window,
    runBindings: z.array(PersistedFactRunBinding).min(1).max(10_000),
    outputPath: z.string().refine((value) => path.isAbsolute(value)),
  })
  .strict()
  .superRefine((value, context) => {
    const runIds = value.runBindings.map((binding) => binding.runId)
    const projectIds = value.runBindings.map((binding) => binding.projectId)
    if (new Set(runIds).size !== runIds.length)
      context.addIssue({ code: "custom", path: ["runBindings"], message: "Run bindings must be unique" })
    if (new Set(projectIds).size !== projectIds.length)
      context.addIssue({
        code: "custom",
        path: ["runBindings"],
        message: "Each exported run must use an isolated project",
      })
  })
export type PersistedFactExportRequest = z.input<typeof PersistedFactExportRequest>

export const PersistedFactExportResult = z
  .object({
    artifact: PersistedFactArtifact,
    reference: PersistedFactArtifactReference,
  })
  .strict()
export type PersistedFactExportResult = z.infer<typeof PersistedFactExportResult>

type TxOrDb = Database.TxOrDb
type ProjectEventRow = typeof CompanyProjectEventTable.$inferSelect
type EventInput = {
  binding: PersistedFactRunBindingValue
  candidateSha: string
  eventType: string
  occurredAt: number
  subjectId: string
  sourceKind: MetricSourceRefValue["kind"]
  sourceEntity: string
  sourceId: string
  sourceFacet?: string
  raw: unknown
  properties: Record<string, unknown>
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]),
  )
}

function canonical(value: unknown) {
  return JSON.stringify(normalized(value))
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function parseRecord(value: string, label: string) {
  const parsed = JSON.parse(value) as unknown
  const result = JSONRecord.safeParse(parsed)
  if (!result.success) throw new Error(`${label} must contain a JSON object`)
  return result.data
}

function parseList(value: string, label: string) {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) throw new Error(`${label} must contain a JSON array`)
  return parsed
}

function metricEvent(input: EventInput): PersistedMetricEvent {
  if (!Number.isInteger(input.occurredAt) || input.occurredAt < 0)
    throw new Error(`${input.sourceEntity} ${input.sourceId} has an invalid timestamp`)
  const facet = input.sourceFacet ? `:${input.sourceFacet}` : ""
  return {
    eventId: `${input.sourceEntity}-${sha256(
      `${input.binding.runId}:${input.sourceId}:${input.eventType}${facet}`,
    ).slice(0, 40)}`,
    eventType: input.eventType,
    occurredAt: new Date(input.occurredAt).toISOString(),
    projectId: input.binding.projectId,
    scenarioId: input.binding.scenarioId,
    runId: input.binding.runId,
    strategy: input.binding.strategy,
    subjectId: input.subjectId,
    source: MetricSourceRef.parse({
      kind: input.sourceKind,
      id: `${input.sourceEntity}:${input.sourceId}:${input.binding.runId}${facet}`,
      candidateSha: input.candidateSha,
      runId: input.binding.runId,
      digest: sha256(canonical({ entity: input.sourceEntity, id: input.sourceId, facet, raw: input.raw })),
    }),
    properties: input.properties,
  }
}

function inWindow(timestamp: number, window: z.infer<typeof Window>) {
  return timestamp >= Date.parse(window.startedAt) && timestamp <= Date.parse(window.endedAt)
}

function timestampOf(row: ProjectEventRow, data: Record<string, unknown>) {
  const occurredAt = data.occurredAt
  if (typeof occurredAt === "string" && !Number.isNaN(Date.parse(occurredAt))) return Date.parse(occurredAt)
  return row.created_at
}

function explicitBindingValue(data: Record<string, unknown>, camel: string, snake: string) {
  if (Object.prototype.hasOwnProperty.call(data, camel)) return data[camel]
  if (Object.prototype.hasOwnProperty.call(data, snake)) return data[snake]
  return undefined
}

function assertEventBinding(
  row: ProjectEventRow,
  data: Record<string, unknown>,
  binding: PersistedFactRunBindingValue,
  candidateSha: string,
  recognized: boolean,
) {
  if (!recognized && row.type !== "local_gate.run_bound") return
  const expected = [
    ["candidateSha", "candidate_sha", candidateSha],
    ["projectId", "project_id", binding.projectId],
    ["scenarioId", "scenario_id", binding.scenarioId],
    ["runId", "run_id", binding.runId],
    ["strategy", "strategy", binding.strategy],
    ["snapshotDigest", "snapshot_sha256", binding.snapshotDigest],
  ] as const
  expected.forEach(([camel, snake, value]) => {
    const observed = explicitBindingValue(data, camel, snake)
    if (observed !== undefined && observed !== value) throw new Error(`Project event ${row.id} has mismatched ${camel}`)
  })
}

function exactAnchor(
  events: { row: ProjectEventRow; data: Record<string, unknown> }[],
  binding: PersistedFactRunBindingValue,
  candidateSha: string,
) {
  return events.some(({ row, data }) => {
    if (row.type !== "local_gate.run_bound" && row.type !== "benchmark.completed") return false
    return (
      explicitBindingValue(data, "candidateSha", "candidate_sha") === candidateSha &&
      explicitBindingValue(data, "runId", "run_id") === binding.runId &&
      explicitBindingValue(data, "scenarioId", "scenario_id") === binding.scenarioId &&
      explicitBindingValue(data, "strategy", "strategy") === binding.strategy &&
      explicitBindingValue(data, "snapshotDigest", "snapshot_sha256") === binding.snapshotDigest
    )
  })
}

function sourceReferenceExists(db: TxOrDb, projectId: string, reference: Record<string, unknown>) {
  if (typeof reference.kind !== "string" || typeof reference.id !== "string" || !reference.id)
    throw new Error(`Project ${projectId} contains an invalid source reference`)
  const sameProject = (row: { project_id: string | null } | undefined) => row?.project_id === projectId
  if (reference.kind === "project") return reference.id === projectId
  if (reference.kind === "project_event")
    return sameProject(
      db
        .select({ project_id: CompanyProjectEventTable.project_id })
        .from(CompanyProjectEventTable)
        .where(eq(CompanyProjectEventTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "work_item")
    return sameProject(
      db
        .select({ project_id: CompanyWorkItemTable.project_id })
        .from(CompanyWorkItemTable)
        .where(eq(CompanyWorkItemTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "work_attempt")
    return sameProject(
      db
        .select({ project_id: CompanyWorkAttemptTable.project_id })
        .from(CompanyWorkAttemptTable)
        .where(eq(CompanyWorkAttemptTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "work_receipt")
    return sameProject(
      db
        .select({ project_id: CompanyWorkReceiptTable.project_id })
        .from(CompanyWorkReceiptTable)
        .where(eq(CompanyWorkReceiptTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "graph_mutation")
    return sameProject(
      db
        .select({ project_id: CompanyGraphMutationTable.project_id })
        .from(CompanyGraphMutationTable)
        .where(eq(CompanyGraphMutationTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "project_assignment")
    return sameProject(
      db
        .select({ project_id: CompanyProjectAssignmentTable.project_id })
        .from(CompanyProjectAssignmentTable)
        .where(eq(CompanyProjectAssignmentTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "validation_gate")
    return sameProject(
      db
        .select({ project_id: CompanyValidationGateTable.project_id })
        .from(CompanyValidationGateTable)
        .where(eq(CompanyValidationGateTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "approval_gate")
    return sameProject(
      db
        .select({ project_id: CompanyApprovalGateTable.project_id })
        .from(CompanyApprovalGateTable)
        .where(eq(CompanyApprovalGateTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "agent_run")
    return sameProject(
      db
        .select({ project_id: AgentRunTable.company_project_id })
        .from(AgentRunTable)
        .where(eq(AgentRunTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "project_action")
    return sameProject(
      db
        .select({ project_id: CompanyProjectActionTable.project_id })
        .from(CompanyProjectActionTable)
        .where(eq(CompanyProjectActionTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "goal_brief")
    return sameProject(
      db
        .select({ project_id: GoalBriefTable.project_id })
        .from(GoalBriefTable)
        .where(eq(GoalBriefTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "artifact")
    return sameProject(
      db
        .select({ project_id: CompanyArtifactTable.project_id })
        .from(CompanyArtifactTable)
        .where(eq(CompanyArtifactTable.id, reference.id))
        .get(),
    )
  return false
}

function validateSourceReferences(db: TxOrDb, projectId: string, source: string, references: unknown[]) {
  references.forEach((reference) => {
    const parsed = SourceReference.safeParse(reference)
    if (!parsed.success || !sourceReferenceExists(db, projectId, parsed.data))
      throw new Error(`${source} references an unavailable source fact`)
  })
}

function projectFacts(
  db: TxOrDb,
  binding: PersistedFactRunBindingValue,
  candidateSha: string,
  contract: MetricContractValue,
  window: z.infer<typeof Window>,
  rollout: ReturnType<typeof CompanyRollout.evidence>,
) {
  const project = db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, binding.projectId)).get()
  if (!project) throw new Error(`Run ${binding.runId} references an unavailable project`)
  if (project.execution_strategy !== binding.strategy)
    throw new Error(`Project ${binding.projectId} has mismatched execution strategy`)
  const events = db
    .select()
    .from(CompanyProjectEventTable)
    .where(eq(CompanyProjectEventTable.project_id, binding.projectId))
    .orderBy(asc(CompanyProjectEventTable.created_at), asc(CompanyProjectEventTable.id))
    .all()
    .map((row) => ({ row, data: parseRecord(row.data_json, `Project event ${row.id}`) }))
  const attempts = db
    .select()
    .from(CompanyWorkAttemptTable)
    .where(eq(CompanyWorkAttemptTable.project_id, binding.projectId))
    .orderBy(asc(CompanyWorkAttemptTable.started_at), asc(CompanyWorkAttemptTable.id))
    .all()
  const receipts = db
    .select()
    .from(CompanyWorkReceiptTable)
    .where(eq(CompanyWorkReceiptTable.project_id, binding.projectId))
    .orderBy(asc(CompanyWorkReceiptTable.created_at), asc(CompanyWorkReceiptTable.id))
    .all()
  const mutations = db
    .select()
    .from(CompanyGraphMutationTable)
    .where(eq(CompanyGraphMutationTable.project_id, binding.projectId))
    .orderBy(asc(CompanyGraphMutationTable.created_at), asc(CompanyGraphMutationTable.id))
    .all()
  const decisions = db
    .select()
    .from(CompanyGraphDecisionTable)
    .where(eq(CompanyGraphDecisionTable.project_id, binding.projectId))
    .orderBy(asc(CompanyGraphDecisionTable.created_at), asc(CompanyGraphDecisionTable.id))
    .all()
  const gates = db
    .select()
    .from(CompanyValidationGateTable)
    .where(eq(CompanyValidationGateTable.project_id, binding.projectId))
    .orderBy(asc(CompanyValidationGateTable.created_at), asc(CompanyValidationGateTable.id))
    .all()
  const repairs = gates.length
    ? db
        .select()
        .from(CompanyValidationRepairTable)
        .where(
          inArray(
            CompanyValidationRepairTable.gate_id,
            gates.map((gate) => gate.id),
          ),
        )
        .orderBy(asc(CompanyValidationRepairTable.created_at), asc(CompanyValidationRepairTable.id))
        .all()
    : []
  const assignments = db
    .select()
    .from(CompanyProjectAssignmentTable)
    .where(eq(CompanyProjectAssignmentTable.project_id, binding.projectId))
    .orderBy(asc(CompanyProjectAssignmentTable.assigned_at), asc(CompanyProjectAssignmentTable.id))
    .all()
  const selections = db
    .select()
    .from(CompanyTeamSelectionTable)
    .where(eq(CompanyTeamSelectionTable.project_id, binding.projectId))
    .orderBy(asc(CompanyTeamSelectionTable.time_created), asc(CompanyTeamSelectionTable.id))
    .all()
  const performances = db
    .select()
    .from(CompanyAgentPerformanceTable)
    .where(eq(CompanyAgentPerformanceTable.project_id, binding.projectId))
    .orderBy(asc(CompanyAgentPerformanceTable.time_created), asc(CompanyAgentPerformanceTable.id))
    .all()
  const attentions = db
    .select()
    .from(CompanyAttentionTable)
    .where(eq(CompanyAttentionTable.project_id, binding.projectId))
    .orderBy(asc(CompanyAttentionTable.created_at), asc(CompanyAttentionTable.id))
    .all()
  const actions = db
    .select()
    .from(CompanyProjectActionTable)
    .where(eq(CompanyProjectActionTable.project_id, binding.projectId))
    .orderBy(asc(CompanyProjectActionTable.created_at), asc(CompanyProjectActionTable.id))
    .all()
  const agentRuns = db
    .select()
    .from(AgentRunTable)
    .where(eq(AgentRunTable.company_project_id, binding.projectId))
    .orderBy(asc(AgentRunTable.time_created), asc(AgentRunTable.id))
    .all()
  const shadows = rollout.shadowEvaluations.filter((item) => item.projectId === binding.projectId)
  const repeat = rollout.localRepeats.find(
    (item) =>
      item.runId === binding.runId &&
      rollout.candidates.some(
        (candidate) => candidate.id === item.candidateId && candidate.candidateSha === candidateSha,
      ),
  )
  const recognizedTypes = new Map(contract.eventTypes.map((item) => [item.id, item.requiredProperties]))
  events.forEach(({ row, data }) => assertEventBinding(row, data, binding, candidateSha, recognizedTypes.has(row.type)))
  const runAnchored =
    project.active_run_id === binding.runId ||
    attempts.some((item) => item.agent_run_id === binding.runId) ||
    agentRuns.some((item) => item.id === binding.runId) ||
    Boolean(repeat) ||
    events.some(
      ({ row, data }) =>
        (row.type === "local_gate.run_bound" || recognizedTypes.has(row.type)) &&
        explicitBindingValue(data, "runId", "run_id") === binding.runId,
    )
  const scenarioAnchored =
    exactAnchor(events, binding, candidateSha) ||
    shadows.some(
      (item) =>
        item.snapshotSha256 === binding.snapshotDigest &&
        (item.input.scenarioId === binding.scenarioId || item.output.scenarioId === binding.scenarioId),
    )
  const snapshotAnchored =
    exactAnchor(events, binding, candidateSha) || shadows.some((item) => item.snapshotSha256 === binding.snapshotDigest)
  if (!runAnchored) throw new Error(`Run ${binding.runId} is not bound to project ${binding.projectId}`)
  if (!scenarioAnchored) throw new Error(`Run ${binding.runId} has no persisted scenario binding`)
  if (!snapshotAnchored) throw new Error(`Run ${binding.runId} has no persisted snapshot binding`)

  attempts.forEach((attempt) => {
    if (!attempt.agent_run_id) return
    const run = agentRuns.find((item) => item.id === attempt.agent_run_id)
    if (!run || run.work_item_id !== attempt.work_item_id)
      throw new Error(`Work Attempt ${attempt.id} references an unavailable AgentRun`)
  })
  receipts.forEach((receipt) => {
    const attempt = attempts.find((item) => item.id === receipt.attempt_id)
    if (!attempt || attempt.work_item_id !== receipt.work_item_id)
      throw new Error(`Work Receipt ${receipt.id} references an unavailable Work Attempt`)
    validateSourceReferences(
      db,
      binding.projectId,
      `Work Receipt ${receipt.id}`,
      parseList(receipt.evidence_refs_json, `Work Receipt ${receipt.id} evidence`),
    )
  })
  mutations.forEach((mutation) => {
    if (!receipts.some((receipt) => receipt.id === mutation.trigger_receipt_id))
      throw new Error(`Graph Mutation ${mutation.id} references an unavailable Work Receipt`)
    validateSourceReferences(
      db,
      binding.projectId,
      `Graph Mutation ${mutation.id}`,
      parseList(mutation.evidence_refs_json, `Graph Mutation ${mutation.id} evidence`),
    )
  })
  decisions.forEach((decision) => {
    const receipt = receipts.find((item) => item.id === decision.receipt_id)
    if (!receipt) throw new Error(`Graph Decision ${decision.id} references an unavailable Work Receipt`)
    if (decision.mutation_id && !mutations.some((item) => item.id === decision.mutation_id))
      throw new Error(`Graph Decision ${decision.id} references an unavailable Graph Mutation`)
    validateSourceReferences(
      db,
      binding.projectId,
      `Graph Decision ${decision.id}`,
      parseList(decision.evidence_refs_json, `Graph Decision ${decision.id} evidence`),
    )
  })
  gates.forEach((gate) => {
    if (
      gate.work_item_id &&
      !db
        .select({ id: CompanyWorkItemTable.id })
        .from(CompanyWorkItemTable)
        .where(
          and(eq(CompanyWorkItemTable.id, gate.work_item_id), eq(CompanyWorkItemTable.project_id, binding.projectId)),
        )
        .get()
    )
      throw new Error(`Validation Gate ${gate.id} references an unavailable Work Item`)
    const criteria = parseList(gate.criteria_json, `Validation Gate ${gate.id} criteria`)
    if (![sha256(canonical(criteria)), sha256(gate.criteria_json)].includes(gate.criteria_sha256))
      throw new Error(`Validation Gate ${gate.id} criteria digest is invalid`)
    validateSourceReferences(
      db,
      binding.projectId,
      `Validation Gate ${gate.id}`,
      parseList(gate.evidence_refs_json, `Validation Gate ${gate.id} evidence`),
    )
  })
  repairs.forEach((repair) => {
    if (!gates.some((gate) => gate.id === repair.gate_id))
      throw new Error(`Validation Repair ${repair.id} references an unavailable Validation Gate`)
    parseRecord(repair.diagnosis_json, `Validation Repair ${repair.id} diagnosis`)
    parseList(repair.repair_diff_json, `Validation Repair ${repair.id} diff`)
    parseList(repair.reverify_evidence_json, `Validation Repair ${repair.id} evidence`)
  })
  attentions.forEach((attention) => {
    const sourceRefs = parseList(attention.source_refs_json, `Attention ${attention.id} sources`)
    validateSourceReferences(db, binding.projectId, `Attention ${attention.id}`, sourceRefs)
    const normalizedSourceRefs = [...sourceRefs].sort((left, right) => canonical(left).localeCompare(canonical(right)))
    if (
      sha256(
        canonical({
          project_id: attention.project_id,
          idempotency_key: attention.idempotency_key,
          issue: {
            issue_kind: attention.issue_kind,
            risk: attention.risk,
            materiality: attention.materiality,
          },
          title: attention.title,
          summary: attention.summary,
          ...(attention.required_decision ? { required_decision: attention.required_decision } : {}),
          source_refs: normalizedSourceRefs,
          decision: {
            issue_kind: attention.issue_kind,
            risk: attention.risk,
            materiality: attention.materiality,
            route: attention.route,
            material: attention.material,
            interrupts_user: attention.interrupts_user,
            allowed_actions: parseList(attention.allowed_actions_json, `Attention ${attention.id} allowed actions`),
          },
        }),
      ) !== attention.input_sha256
    )
      throw new Error(`Attention ${attention.id} input digest is invalid`)
  })
  actions.forEach((action) => {
    if (action.attention_id && !attentions.some((attention) => attention.id === action.attention_id))
      throw new Error(`Project Action ${action.id} references an unavailable Attention`)
    const payload = parseRecord(action.payload_json, `Project Action ${action.id} payload`)
    if (
      sha256(
        canonical({
          action: action.action,
          attention_id: action.attention_id ?? undefined,
          expected_revision: action.expected_revision ?? undefined,
          payload,
        }),
      ) !== action.payload_sha256
    )
      throw new Error(`Project Action ${action.id} payload digest is invalid`)
    if (action.result_json) parseRecord(action.result_json, `Project Action ${action.id} result`)
  })
  assignments.forEach((assignment) => {
    const selection = selections.find((item) => item.id === assignment.selection_id)
    const need = db
      .select()
      .from(CompanyCapabilityNeedTable)
      .where(eq(CompanyCapabilityNeedTable.id, assignment.capability_need_id))
      .get()
    const item = db
      .select()
      .from(CompanyWorkItemTable)
      .where(eq(CompanyWorkItemTable.id, assignment.work_item_id))
      .get()
    if (
      !selection ||
      selection.agent_id !== assignment.agent_id ||
      !need ||
      need.project_id !== binding.projectId ||
      !item ||
      item.project_id !== binding.projectId ||
      (assignment.source_receipt_id !== null &&
        !receipts.some((receipt) => receipt.id === assignment.source_receipt_id))
    )
      throw new Error(`Project Assignment ${assignment.id} has inconsistent source facts`)
  })
  selections.forEach((selection) => {
    const need = db
      .select({ project_id: CompanyCapabilityNeedTable.project_id })
      .from(CompanyCapabilityNeedTable)
      .where(eq(CompanyCapabilityNeedTable.id, selection.capability_need_id))
      .get()
    if (need?.project_id !== binding.projectId)
      throw new Error(`Team Selection ${selection.id} references an unavailable Capability Need`)
  })
  performances.forEach((performance) => {
    const selection = selections.find((item) => item.id === performance.selection_id)
    if (!selection || selection.agent_id !== performance.agent_id)
      throw new Error(`Agent Performance ${performance.id} has inconsistent Selection facts`)
  })
  shadows.forEach((shadow) => {
    if (shadow.receiptId && !receipts.some((receipt) => receipt.id === shadow.receiptId))
      throw new Error(`Shadow evaluation ${shadow.id} references an unavailable Work Receipt`)
  })
  agentRuns.forEach((run) => {
    if (!run.work_item_id) return
    const item = db
      .select({ project_id: CompanyWorkItemTable.project_id })
      .from(CompanyWorkItemTable)
      .where(eq(CompanyWorkItemTable.id, run.work_item_id))
      .get()
    if (item?.project_id !== binding.projectId)
      throw new Error(`AgentRun ${run.id} references an unavailable Work Item`)
  })

  const firstReceiptAt = receipts.map((item) => item.created_at).sort((left, right) => left - right)[0]
  const output: PersistedMetricEvent[] = []
  const logical = new Set<string>()
  const append = (event: PersistedMetricEvent | undefined, key: string) => {
    if (!event || !inWindow(Date.parse(event.occurredAt), window) || logical.has(key)) return
    output.push(event)
    logical.add(key)
  }
  const emit = (input: Omit<EventInput, "binding" | "candidateSha">, key: string) =>
    append(metricEvent({ ...input, binding, candidateSha }), key)
  const rawSourceRefs = (value: string, label: string) => parseList(value, label)

  receipts.forEach((receipt) => {
    emit(
      {
        eventType: "work_receipt.submitted",
        occurredAt: receipt.created_at,
        subjectId: receipt.id,
        sourceKind: "work_receipt",
        sourceEntity: "company_work_receipt",
        sourceId: receipt.id,
        raw: receipt,
        properties: {
          receiptId: receipt.id,
          attemptId: receipt.attempt_id,
          sourceRefCount: rawSourceRefs(receipt.evidence_refs_json, `Work Receipt ${receipt.id} evidence`).length,
          unknownCount: parseList(receipt.unknowns_json, `Work Receipt ${receipt.id} unknowns`).length,
          sourceRefs: rawSourceRefs(receipt.evidence_refs_json, `Work Receipt ${receipt.id} evidence`),
        },
      },
      `work_receipt.submitted:${receipt.id}`,
    )
    const processed = events.find(
      ({ row, data }) =>
        row.type === "work_receipt.processed" &&
        (data.receiptId === receipt.id || data.receipt_id === receipt.id) &&
        typeof data.duplicate === "boolean" &&
        typeof data.recovered === "boolean",
    )
    if (!processed || receipt.processing_status !== "processed" || receipt.processed_at === null) return
    emit(
      {
        eventType: "work_receipt.processed",
        occurredAt: receipt.processed_at,
        subjectId: receipt.id,
        sourceKind: "work_receipt",
        sourceEntity: "company_work_receipt",
        sourceId: receipt.id,
        sourceFacet: "processed",
        raw: { receipt, event: processed.row },
        properties: {
          receiptId: receipt.id,
          duplicate: processed.data.duplicate,
          recovered: processed.data.recovered,
          sourceRefs: rawSourceRefs(receipt.evidence_refs_json, `Work Receipt ${receipt.id} evidence`),
        },
      },
      `work_receipt.processed:${receipt.id}`,
    )
  })
  decisions.forEach((decision) =>
    emit(
      {
        eventType: "graph_decision.recorded",
        occurredAt: decision.created_at,
        subjectId: decision.id,
        sourceKind: "project_event",
        sourceEntity: "company_graph_decision",
        sourceId: decision.id,
        raw: decision,
        properties: {
          decisionId: decision.id,
          kind: decision.kind,
          automated: decision.automated,
          addedNodeCount: decision.added_node_count,
          sourceRefs: rawSourceRefs(decision.evidence_refs_json, `Graph Decision ${decision.id} evidence`),
        },
      },
      `graph_decision.recorded:${decision.id}`,
    ),
  )
  mutations.forEach((mutation) => {
    const verdict = parseRecord(mutation.policy_verdict_json, `Graph Mutation ${mutation.id} policy verdict`)
    emit(
      {
        eventType: "graph_mutation.evaluated",
        occurredAt: mutation.applied_at ?? mutation.created_at,
        subjectId: mutation.id,
        sourceKind: "graph_mutation",
        sourceEntity: "company_graph_mutation",
        sourceId: mutation.id,
        raw: mutation,
        properties: {
          mutationId: mutation.id,
          evidenceCount: rawSourceRefs(mutation.evidence_refs_json, `Graph Mutation ${mutation.id} evidence`).length,
          verdict: typeof verdict.result === "string" ? verdict.result : mutation.status,
          sourceRefs: rawSourceRefs(mutation.evidence_refs_json, `Graph Mutation ${mutation.id} evidence`),
        },
      },
      `graph_mutation.evaluated:${mutation.id}`,
    )
  })
  assignments.forEach((assignment) => {
    const item = db
      .select()
      .from(CompanyWorkItemTable)
      .where(eq(CompanyWorkItemTable.id, assignment.work_item_id))
      .get()!
    emit(
      {
        eventType: "project_assignment.activated",
        occurredAt: assignment.started_at ?? assignment.assigned_at,
        subjectId: assignment.id,
        sourceKind: "project_assignment",
        sourceEntity: "company_project_assignment",
        sourceId: assignment.id,
        sourceFacet: "activated",
        raw: assignment,
        properties: {
          assignmentId: assignment.id,
          agentId: assignment.agent_id,
          purpose: item.purpose,
          initial: firstReceiptAt === undefined || assignment.assigned_at <= firstReceiptAt,
          sourceRefs: [
            { kind: "selection", id: assignment.selection_id },
            ...(assignment.source_receipt_id ? [{ kind: "work_receipt", id: assignment.source_receipt_id }] : []),
          ],
        },
      },
      `project_assignment.activated:${assignment.id}`,
    )
    if (assignment.released_at === null) return
    emit(
      {
        eventType: "project_assignment.released",
        occurredAt: assignment.released_at,
        subjectId: assignment.id,
        sourceKind: "project_assignment",
        sourceEntity: "company_project_assignment",
        sourceId: assignment.id,
        sourceFacet: "released",
        raw: assignment,
        properties: {
          assignmentId: assignment.id,
          agentId: assignment.agent_id,
          durationMs: Math.max(0, assignment.released_at - assignment.assigned_at),
          sourceRefs: [{ kind: "selection", id: assignment.selection_id }],
        },
      },
      `project_assignment.released:${assignment.id}`,
    )
  })
  selections
    .filter((selection) => selection.decision === "selected")
    .forEach((selection) =>
      emit(
        {
          eventType: "candidate.selected",
          occurredAt: selection.time_created,
          subjectId: selection.id,
          sourceKind: "project_assignment",
          sourceEntity: "company_team_selection",
          sourceId: selection.id,
          raw: selection,
          properties: {
            candidateId: selection.agent_id,
            reused: selection.source === "company_pool",
            createdForNeed: selection.source === "new_candidate",
            selectionId: selection.id,
            capabilityNeedId: selection.capability_need_id,
          },
        },
        `candidate.selected:${selection.id}`,
      ),
    )
  attempts.forEach((attempt) =>
    emit(
      {
        eventType: "fact.work_attempt",
        occurredAt: attempt.finished_at ?? attempt.started_at,
        subjectId: attempt.id,
        sourceKind: "work_attempt",
        sourceEntity: "company_work_attempt",
        sourceId: attempt.id,
        raw: attempt,
        properties: {
          attemptId: attempt.id,
          workItemId: attempt.work_item_id,
          agentRunId: attempt.agent_run_id,
          ordinal: attempt.ordinal,
          status: attempt.status,
          failureKind: attempt.failure_kind,
        },
      },
      `fact.work_attempt:${attempt.id}`,
    ),
  )
  gates.forEach((gate) =>
    emit(
      {
        eventType: "fact.validation_gate",
        occurredAt: gate.evaluated_at ?? gate.created_at,
        subjectId: gate.id,
        sourceKind: "validation_gate",
        sourceEntity: "company_validation_gate",
        sourceId: gate.id,
        raw: gate,
        properties: {
          gateId: gate.id,
          kind: gate.kind,
          status: gate.status,
          repairRound: gate.repair_round,
          criteriaSha256: gate.criteria_sha256,
          sourceRefs: rawSourceRefs(gate.evidence_refs_json, `Validation Gate ${gate.id} evidence`),
        },
      },
      `fact.validation_gate:${gate.id}`,
    ),
  )
  repairs.forEach((repair) =>
    emit(
      {
        eventType: "graph_repair.completed",
        occurredAt: repair.created_at,
        subjectId: repair.id,
        sourceKind: "validation_gate",
        sourceEntity: "company_validation_repair",
        sourceId: repair.id,
        raw: repair,
        properties: {
          repairId: repair.id,
          passedOriginalCriterion: repair.result === "passed",
          attemptCount: repair.round,
          blindRetryCount: 0,
          gateId: repair.gate_id,
          diagnosis: parseRecord(repair.diagnosis_json, `Validation Repair ${repair.id} diagnosis`),
          sourceRefs: parseList(repair.reverify_evidence_json, `Validation Repair ${repair.id} evidence`),
        },
      },
      `graph_repair.completed:${repair.id}`,
    ),
  )
  performances.forEach((performance) =>
    emit(
      {
        eventType: "fact.agent_performance",
        occurredAt: performance.time_created,
        subjectId: performance.id,
        sourceKind: "project_assignment",
        sourceEntity: "company_agent_performance",
        sourceId: performance.id,
        raw: performance,
        properties: {
          performanceId: performance.id,
          selectionId: performance.selection_id,
          agentId: performance.agent_id,
          outcome: performance.outcome,
          qualityScore: performance.quality_score,
          reliabilityScore: performance.reliability_score,
          costScore: performance.cost_score,
          speedScore: performance.speed_score,
        },
      },
      `fact.agent_performance:${performance.id}`,
    ),
  )
  attentions.forEach((attention) => {
    const sourceRefs = rawSourceRefs(attention.source_refs_json, `Attention ${attention.id} sources`)
    emit(
      {
        eventType: "attention.opened",
        occurredAt: attention.created_at,
        subjectId: attention.id,
        sourceKind: "attention",
        sourceEntity: "company_attention",
        sourceId: attention.id,
        sourceFacet: "opened",
        raw: attention,
        properties: {
          attentionId: attention.id,
          materiality: attention.materiality,
          interruptsUser: attention.interrupts_user,
          sourceRefs,
        },
      },
      `attention.opened:${attention.id}`,
    )
    if (attention.resolved_at === null) return
    emit(
      {
        eventType: "attention.resolved",
        occurredAt: attention.resolved_at,
        subjectId: attention.id,
        sourceKind: "attention",
        sourceEntity: "company_attention",
        sourceId: attention.id,
        sourceFacet: "resolved",
        raw: attention,
        properties: {
          attentionId: attention.id,
          latencyMs: Math.max(0, attention.resolved_at - attention.created_at),
          sourceRefs,
        },
      },
      `attention.resolved:${attention.id}`,
    )
  })
  actions.forEach((action) =>
    emit(
      {
        eventType: "fact.project_action",
        occurredAt: action.finished_at ?? action.updated_at,
        subjectId: action.id,
        sourceKind: "attention",
        sourceEntity: "company_project_action",
        sourceId: action.id,
        raw: action,
        properties: {
          actionId: action.id,
          attentionId: action.attention_id,
          action: action.action,
          status: action.status,
          payloadSha256: action.payload_sha256,
        },
      },
      `fact.project_action:${action.id}`,
    ),
  )
  agentRuns.forEach((run) => {
    const usage = db.select().from(AgentRunUsageTable).where(eq(AgentRunUsageTable.agent_run_id, run.id)).get()
    const runEvents = db
      .select()
      .from(AgentRunEventTable)
      .where(eq(AgentRunEventTable.agent_run_id, run.id))
      .orderBy(asc(AgentRunEventTable.sequence), asc(AgentRunEventTable.id))
      .all()
    runEvents.forEach((event) => parseRecord(event.payload_json, `AgentRun event ${event.id}`))
    emit(
      {
        eventType: "fact.agent_run",
        occurredAt: run.time_finished ?? run.time_updated,
        subjectId: run.id,
        sourceKind: "agent_run",
        sourceEntity: "agent_run",
        sourceId: run.id,
        raw: { run, usage, events: runEvents },
        properties: {
          agentRunId: run.id,
          agentId: run.agent_id,
          workItemId: run.work_item_id,
          state: run.state,
          exitCode: run.exit_code,
          eventCount: runEvents.length,
          usage: usage
            ? {
                source: usage.source,
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                reasoningTokens: usage.reasoning_tokens,
                cacheReadTokens: usage.cache_read_tokens,
                cacheWriteTokens: usage.cache_write_tokens,
              }
            : undefined,
        },
      },
      `fact.agent_run:${run.id}`,
    )
  })
  if (project.status === "completed" && project.completed_at !== null)
    emit(
      {
        eventType: "project.completed",
        occurredAt: project.completed_at,
        subjectId: project.id,
        sourceKind: "project_event",
        sourceEntity: "company_project",
        sourceId: project.id,
        raw: project,
        properties: { projectId: project.id, strategy: binding.strategy },
      },
      `project.completed:${project.id}`,
    )

  events.forEach(({ row, data }) => {
    const required = recognizedTypes.get(row.type)
    const complete = required?.every((key) => Object.prototype.hasOwnProperty.call(data, key)) === true
    const subjectId =
      [
        "receiptId",
        "decisionId",
        "mutationId",
        "gateId",
        "assignmentId",
        "attentionId",
        "attemptId",
        "deliveryId",
        "comparisonId",
        "projectId",
      ]
        .map((key) => data[key])
        .find((value): value is string => typeof value === "string" && Boolean(value.trim())) ?? row.id
    const metricKey = `${row.type}:${subjectId}`
    const eventType = complete && !logical.has(metricKey) ? row.type : "fact.project_event"
    emit(
      {
        eventType,
        occurredAt: timestampOf(row, data),
        subjectId,
        sourceKind: "project_event",
        sourceEntity: "company_project_event",
        sourceId: row.id,
        raw: row,
        properties:
          eventType === row.type
            ? data
            : {
                projectEventId: row.id,
                type: row.type,
                actorId: row.actor_id,
                data,
              },
      },
      eventType === row.type ? metricKey : `fact.project_event:${row.id}`,
    )
  })
  const candidate = rollout.candidates.find((item) => item.candidateSha === candidateSha)!
  emit(
    {
      eventType: "fact.rollout_candidate",
      occurredAt: candidate.registeredAt,
      subjectId: candidate.id,
      sourceKind: "gate_report",
      sourceEntity: "company_rollout_candidate",
      sourceId: candidate.id,
      raw: candidate,
      properties: {
        candidateId: candidate.id,
        candidateSha: candidate.candidateSha,
        targetRef: candidate.targetRef,
      },
    },
    `fact.rollout_candidate:${candidate.id}`,
  )
  rollout.localRepeats
    .filter((item) => item.candidateId === candidate.id && item.runId === binding.runId)
    .forEach((item) =>
      emit(
        {
          eventType: "fact.rollout_local_repeat",
          occurredAt: item.recordedAt,
          subjectId: item.id,
          sourceKind: "gate_report",
          sourceEntity: "company_rollout_local_repeat",
          sourceId: item.id,
          raw: item,
          properties: {
            repeatId: item.id,
            candidateId: item.candidateId,
            runId: item.runId,
            ordinal: item.ordinal,
            outcome: item.outcome,
            environmentSha256: item.environmentSha256,
            evidenceSha256: item.evidenceSha256,
            normalizedResultSha256: item.normalizedResultSha256,
          },
        },
        `fact.rollout_local_repeat:${item.id}`,
      ),
    )
  rollout.rollbacks
    .filter(
      (item) =>
        (item.projectId === binding.projectId && (!item.candidateId || item.candidateId === candidate.id)) ||
        (!item.projectId && item.candidateId === candidate.id),
    )
    .forEach((item) =>
      emit(
        {
          eventType: "fact.rollout_rollback",
          occurredAt: item.recordedAt,
          subjectId: item.id,
          sourceKind: "rollback_report",
          sourceEntity: "company_rollout_rollback",
          sourceId: item.id,
          raw: item,
          properties: {
            rollbackId: item.id,
            candidateId: item.candidateId,
            ...(item.projectId ? { projectId: item.projectId } : {}),
            target: item.target,
            outcome: item.outcome,
            executionModeAfter: item.executionModeAfter,
            evidenceSha256: item.evidenceSha256,
          },
        },
        `fact.rollout_rollback:${item.id}`,
      ),
    )
  shadows.forEach((item) =>
    emit(
      {
        eventType: "fact.rollout_shadow_evaluation",
        occurredAt: item.createdAt,
        subjectId: item.id,
        sourceKind: "shadow_report",
        sourceEntity: "company_rollout_shadow_evaluation",
        sourceId: item.id,
        raw: item,
        properties: {
          shadowEvaluationId: item.id,
          kind: item.kind,
          receiptId: item.receiptId,
          snapshotDigest: item.snapshotSha256,
          inputSha256: item.inputSha256,
          outputSha256: item.outputSha256,
          businessStateBeforeSha256: item.businessStateBeforeSha256,
          businessStateAfterSha256: item.businessStateAfterSha256,
          status: item.status,
        },
      },
      `fact.rollout_shadow_evaluation:${item.id}`,
    ),
  )
  return output
}

async function executableDigest() {
  return sha256(new Uint8Array(await Bun.file(import.meta.path).arrayBuffer()))
}

async function assertOutputTarget(target: string) {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (info?.isSymbolicLink()) throw new Error(`Persisted fact output cannot be a symbolic link: ${target}`)
  if (info && !info.isFile()) throw new Error(`Persisted fact output must be a regular file: ${target}`)
}

export async function exportPersistedFactArtifact(raw: PersistedFactExportRequest): Promise<PersistedFactExportResult> {
  const request = PersistedFactExportRequest.parse(raw)
  const producerDigest = await executableDigest()
  const events = Database.transaction(
    (db) => {
      if (
        [
          CompanyRolloutCandidateTable,
          CompanyRolloutLocalRepeatTable,
          CompanyRolloutRollbackTable,
          CompanyRolloutShadowEvaluationTable,
        ].some((table) => db.select({ value: count() }).from(table).get()!.value > 500)
      )
        throw new Error("Persisted rollout fact count exceeds the local Gate export limit")
      const rollout = CompanyRollout.evidence(500)
      if (!rollout.candidates.some((candidate) => candidate.candidateSha === request.candidateSha))
        throw new Error(`Candidate ${request.candidateSha} is not registered in persisted rollout facts`)
      return request.runBindings.flatMap((binding) =>
        projectFacts(db, binding, request.candidateSha, request.metricContract, request.window, rollout),
      )
    },
    { behavior: "immediate" },
  )
  const artifact = bindPersistedFactArtifact({
    schemaVersion: 1,
    kind: "seed-grow-local-gate-persisted-facts",
    id: request.id,
    producer: {
      kind: "local_gate",
      commandId: "seed-grow-persisted-fact-exporter",
      version: "v1",
      executableDigest: producerDigest,
    },
    candidateSha: request.candidateSha,
    metricContractDigest: persistedMetricContractDigest(request.metricContract),
    metricQueryVersion: request.metricContract.queryVersion,
    shadowQueryVersion: request.metricContract.shadowComparison?.queryVersion ?? "seed-grow-shadow-query.v1",
    window: request.window,
    runBindings: request.runBindings,
    events,
  })
  await assertOutputTarget(request.outputPath)
  await mkdir(path.dirname(request.outputPath), { recursive: true })
  const source = `${JSON.stringify(artifact, null, 2)}\n`
  const temporary = `${request.outputPath}.${process.pid}.${sha256(source).slice(0, 12)}.tmp`
  await Bun.write(temporary, source)
  await rename(temporary, request.outputPath)
  return PersistedFactExportResult.parse({
    artifact,
    reference: {
      path: request.outputPath,
      sha256: sha256(source),
    },
  })
}

export * as PersistedFactExporter from "./persisted-fact-exporter"
