import { createHash } from "node:crypto"
import { asc, eq, inArray } from "drizzle-orm"
import z from "zod"
import {
  AssignmentSummary,
  DiscoverySummary,
  GraphChangeSummary,
  OrganizationProjection,
  ValidationSummary,
  type ExperienceSourceRef,
} from "@agents-company/shared/experience"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import {
  CompanyCapabilityNeedTable,
  CompanyProjectAssignmentTable,
  CompanyTeamSelectionTable,
} from "@/company-recruitment/company-recruitment.sql"
import { CapabilityNeed, ProjectAssignment, TeamSelection } from "@/company-recruitment/schema"
import { Database } from "@/storage"
import {
  CompanyGraphMutationTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "./company-project.sql"
import { GraphMutation, ValidationGate, WorkAttempt, WorkReceipt, type WorkReceiptEvidenceRef } from "./schema"
import { PROJECTOR_VERSION } from "./work-projection"

const MAX_PROJECTION_ITEMS = 499
const Timestamp = z.number().int().min(0).max(253_402_300_799_999)
const AgentFact = z
  .object({
    id: z.string().trim().min(1).max(240),
    name: z.string().trim().min(1).max(240),
    lifecycle: z.enum(["candidate", "assigned", "employee", "archived"]),
    time_created: Timestamp,
    time_updated: Timestamp,
  })
  .strict()

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]),
  )
}

function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(normalized(value)))
    .digest("hex")
}

function parseJSON(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function identifier(value: string, prefix: string) {
  const parsed = z.string().trim().min(1).max(240).safeParse(value)
  return parsed.success ? parsed.data : `${prefix}:${digest(value).slice(0, 32)}`
}

function timestamp(value: number) {
  const parsed = Timestamp.safeParse(value)
  return parsed.success ? new Date(parsed.data).toISOString() : undefined
}

function validTimestamps(values: Array<number | undefined>) {
  return values.every((value) => value === undefined || timestamp(value) !== undefined)
}

function latestTimestamp(values: Array<number | null | undefined>) {
  return timestamp(Math.max(0, ...values.filter((value): value is number => typeof value === "number")))
}

function uniqueSourceRefs(refs: ExperienceSourceRef[]) {
  return [...new Map(refs.map((ref) => [JSON.stringify(normalized(ref)), ref])).values()].sort((left, right) =>
    JSON.stringify(normalized(left)).localeCompare(JSON.stringify(normalized(right))),
  )
}

function evidenceSourceRefs(refs: WorkReceiptEvidenceRef[]) {
  return refs.flatMap((ref): ExperienceSourceRef[] => {
    if (ref.kind === "artifact") return [{ kind: "artifact", id: ref.id }]
    if (ref.kind === "project_event") return [{ kind: "project_event", id: ref.id }]
    return []
  })
}

function projectSourceRef(projectID: string): ExperienceSourceRef {
  return { kind: "project", id: identifier(projectID, "project") }
}

function assignmentFromRow(row: typeof CompanyProjectAssignmentTable.$inferSelect) {
  return ProjectAssignment.safeParse({
    ...row,
    company_id: row.company_id ?? undefined,
    supersedes_assignment_id: row.supersedes_assignment_id ?? undefined,
    decision_scope: parseJSON(row.decision_scope_json),
    resource_scope: parseJSON(row.resource_scope_json),
    source_receipt_id: row.source_receipt_id ?? undefined,
    started_at: row.started_at ?? undefined,
    released_at: row.released_at ?? undefined,
    release_reason: row.release_reason ?? undefined,
  })
}

function selectionFromRow(row: typeof CompanyTeamSelectionTable.$inferSelect) {
  return TeamSelection.safeParse({
    ...row,
    company_id: row.company_id ?? undefined,
    gaps: parseJSON(row.gaps_json),
    score: parseJSON(row.score_json),
    constraint_results: parseJSON(row.constraint_results_json),
    time_released: row.time_released ?? undefined,
  })
}

function needFromRow(row: typeof CompanyCapabilityNeedTable.$inferSelect) {
  return CapabilityNeed.safeParse({
    ...row,
    company_id: row.company_id ?? undefined,
    work_item_id: row.work_item_id ?? undefined,
    source_receipt_id: row.source_receipt_id ?? undefined,
    capability_packs: parseJSON(row.capability_packs_json),
    department_key: row.department_key ?? undefined,
    required_runtime_capabilities: parseJSON(row.required_runtime_capabilities_json),
    required_tools: parseJSON(row.required_tools_json),
    allowed_permission_modes: parseJSON(row.allowed_permission_modes_json),
    workspace_scopes: parseJSON(row.workspace_scopes_json),
    independent_from_agent_ids: parseJSON(row.independent_from_agent_ids_json),
  })
}

function attemptFromRow(row: typeof CompanyWorkAttemptTable.$inferSelect) {
  return WorkAttempt.safeParse({
    ...row,
    agent_run_id: row.agent_run_id ?? undefined,
    failure_kind: row.failure_kind ?? undefined,
    safe_summary: row.safe_summary ?? undefined,
    finished_at: row.finished_at ?? undefined,
  })
}

function receiptFromRow(row: typeof CompanyWorkReceiptTable.$inferSelect) {
  return WorkReceipt.safeParse({
    id: row.id,
    project_id: row.project_id,
    work_item_id: row.work_item_id,
    attempt_id: row.attempt_id,
    idempotency_key: row.idempotency_key,
    outcome: row.outcome,
    summary: row.summary,
    artifact_ids: parseJSON(row.artifact_ids_json),
    evidence_refs: parseJSON(row.evidence_refs_json),
    confirmed_facts: parseJSON(row.confirmed_facts_json),
    invalidated_assumptions: parseJSON(row.invalidated_assumptions_json),
    unknowns: parseJSON(row.unknowns_json),
    blockers: parseJSON(row.blockers_json),
    capability_gaps: parseJSON(row.capability_gaps_json),
    task_proposals: parseJSON(row.task_proposals_json),
    dependency_proposals: parseJSON(row.dependency_proposals_json),
    questions: parseJSON(row.questions_json),
    processing_status: row.processing_status,
    processed_mutation_id: row.processed_mutation_id ?? undefined,
    created_at: row.created_at,
    processed_at: row.processed_at ?? undefined,
  })
}

function mutationFromRow(row: typeof CompanyGraphMutationTable.$inferSelect) {
  return GraphMutation.safeParse({
    id: row.id,
    project_id: row.project_id,
    trigger_receipt_id: row.trigger_receipt_id,
    expected_revision: row.expected_revision,
    applied_revision: row.applied_revision ?? undefined,
    orchestrator_version: row.orchestrator_version,
    idempotency_key: row.idempotency_key,
    decision: row.decision,
    rationale: row.rationale,
    evidence_refs: parseJSON(row.evidence_refs_json),
    operations: parseJSON(row.operations_json),
    status: row.status,
    policy_verdict: parseJSON(row.policy_verdict_json),
    created_at: row.created_at,
    applied_at: row.applied_at ?? undefined,
  })
}

function gateFromRow(row: typeof CompanyValidationGateTable.$inferSelect) {
  return ValidationGate.safeParse({
    id: row.id,
    project_id: row.project_id,
    work_item_id: row.work_item_id ?? undefined,
    kind: row.kind,
    status: row.status,
    criteria: parseJSON(row.criteria_json),
    criteria_sha256: row.criteria_sha256,
    blocking_work_item_ids: parseJSON(row.blocking_work_item_ids_json),
    evidence_refs: parseJSON(row.evidence_refs_json),
    evaluator: row.evaluator,
    repair_round: row.repair_round,
    max_repair_rounds: row.max_repair_rounds,
    failure_summary: row.failure_summary ?? undefined,
    supersedes_gate_id: row.supersedes_gate_id ?? undefined,
    created_at: row.created_at,
    evaluated_at: row.evaluated_at ?? undefined,
  })
}

function unavailableOrganization(facts: NonNullable<ReturnType<typeof organizationFacts>>, overflow: boolean) {
  const projectId = identifier(facts.project.id, "project")
  return OrganizationProjection.parse({
    availability: "unavailable",
    projectorVersion: PROJECTOR_VERSION,
    sourceWatermark: digest({ projectorVersion: PROJECTOR_VERSION, facts }),
    sourceRefs: [projectSourceRef(projectId)],
    updatedAt: timestamp(facts.project.updated_at) ?? new Date(0).toISOString(),
    projectId,
    reason: {
      code: overflow ? "projection_overflow" : "invalid_persisted_fact",
      message: overflow
        ? "组织事实超过只读投影上限，当前组织状态不可用。"
        : "组织持久化事实无法安全解析，当前组织状态不可用。",
    },
  })
}

function organizationFacts(projectID: string) {
  return Database.transaction((db) => {
    const project = db
      .select({
        id: CompanyProjectTable.id,
        updated_at: CompanyProjectTable.updated_at,
      })
      .from(CompanyProjectTable)
      .where(eq(CompanyProjectTable.id, projectID))
      .get()
    if (!project) return undefined
    const assignments = db
      .select()
      .from(CompanyProjectAssignmentTable)
      .where(eq(CompanyProjectAssignmentTable.project_id, projectID))
      .orderBy(asc(CompanyProjectAssignmentTable.assigned_at), asc(CompanyProjectAssignmentTable.id))
      .limit(MAX_PROJECTION_ITEMS + 1)
      .all()
    const selectionIDs = [...new Set(assignments.map((row) => row.selection_id))]
    const needIDs = [...new Set(assignments.map((row) => row.capability_need_id))]
    const agentIDs = [...new Set(assignments.map((row) => row.agent_id))]
    const workItemIDs = [...new Set(assignments.map((row) => row.work_item_id))]
    const receiptIDs = [
      ...new Set(assignments.flatMap((row) => (row.source_receipt_id === null ? [] : [row.source_receipt_id]))),
    ]
    return {
      project,
      assignments,
      selections: selectionIDs.length
        ? db
            .select()
            .from(CompanyTeamSelectionTable)
            .where(inArray(CompanyTeamSelectionTable.id, selectionIDs))
            .orderBy(asc(CompanyTeamSelectionTable.id))
            .all()
        : [],
      needs: needIDs.length
        ? db
            .select()
            .from(CompanyCapabilityNeedTable)
            .where(inArray(CompanyCapabilityNeedTable.id, needIDs))
            .orderBy(asc(CompanyCapabilityNeedTable.id))
            .all()
        : [],
      agents: agentIDs.length
        ? db
            .select({
              id: CompanyAgentTable.id,
              name: CompanyAgentTable.name,
              lifecycle: CompanyAgentTable.lifecycle,
              time_created: CompanyAgentTable.time_created,
              time_updated: CompanyAgentTable.time_updated,
            })
            .from(CompanyAgentTable)
            .where(inArray(CompanyAgentTable.id, agentIDs))
            .orderBy(asc(CompanyAgentTable.id))
            .all()
        : [],
      workItems: workItemIDs.length
        ? db
            .select({
              id: CompanyWorkItemTable.id,
              project_id: CompanyWorkItemTable.project_id,
            })
            .from(CompanyWorkItemTable)
            .where(inArray(CompanyWorkItemTable.id, workItemIDs))
            .orderBy(asc(CompanyWorkItemTable.id))
            .all()
        : [],
      receipts: receiptIDs.length
        ? db
            .select({
              id: CompanyWorkReceiptTable.id,
              project_id: CompanyWorkReceiptTable.project_id,
            })
            .from(CompanyWorkReceiptTable)
            .where(inArray(CompanyWorkReceiptTable.id, receiptIDs))
            .orderBy(asc(CompanyWorkReceiptTable.id))
            .all()
        : [],
    }
  })
}

export function organization(projectID: string) {
  const facts = organizationFacts(projectID)
  if (!facts) return undefined
  if (!timestamp(facts.project.updated_at)) return unavailableOrganization(facts, false)
  if (facts.assignments.length > MAX_PROJECTION_ITEMS) return unavailableOrganization(facts, true)
  const selections = new Map(
    facts.selections.flatMap((row) => {
      const parsed = selectionFromRow(row)
      return parsed.success ? [[parsed.data.id, parsed.data] as const] : []
    }),
  )
  const needs = new Map(
    facts.needs.flatMap((row) => {
      const parsed = needFromRow(row)
      return parsed.success ? [[parsed.data.id, parsed.data] as const] : []
    }),
  )
  const agents = new Map(
    facts.agents.flatMap((row) => {
      const parsed = AgentFact.safeParse(row)
      return parsed.success ? [[parsed.data.id, parsed.data] as const] : []
    }),
  )
  const receipts = new Map(facts.receipts.map((row) => [row.id, row.project_id]))
  const workItems = new Map(facts.workItems.map((row) => [row.id, row.project_id]))
  const assignmentIDs = new Set(facts.assignments.map((row) => row.id))
  const assignments = facts.assignments.map((row) => {
    const assignment = assignmentFromRow(row)
    const selection = assignment.success ? selections.get(assignment.data.selection_id) : undefined
    const need = assignment.success ? needs.get(assignment.data.capability_need_id) : undefined
    const agent = assignment.success ? agents.get(assignment.data.agent_id) : undefined
    if (!assignment.success || !selection || !need || !agent) return undefined
    if (
      assignment.data.project_id !== projectID ||
      selection.project_id !== projectID ||
      selection.capability_need_id !== assignment.data.capability_need_id ||
      selection.agent_id !== assignment.data.agent_id ||
      selection.decision !== "selected" ||
      need.project_id !== projectID ||
      (need.work_item_id !== undefined && need.work_item_id !== assignment.data.work_item_id) ||
      workItems.get(assignment.data.work_item_id) !== projectID ||
      (assignment.data.source_receipt_id !== undefined &&
        receipts.get(assignment.data.source_receipt_id) !== projectID) ||
      (assignment.data.supersedes_assignment_id !== undefined &&
        !assignmentIDs.has(assignment.data.supersedes_assignment_id)) ||
      !validTimestamps([
        assignment.data.assigned_at,
        assignment.data.started_at,
        assignment.data.released_at,
        selection.time_created,
        selection.time_updated,
        selection.time_released,
        need.time_created,
        need.time_updated,
        agent.time_created,
        agent.time_updated,
      ])
    )
      return undefined
    const sourceRefs = uniqueSourceRefs([
      projectSourceRef(projectID),
      { kind: "project_assignment", id: assignment.data.id, version: assignment.data.version },
      ...(assignment.data.source_receipt_id
        ? ([{ kind: "work_receipt", id: assignment.data.source_receipt_id }] satisfies ExperienceSourceRef[])
        : []),
    ])
    const summary = AssignmentSummary.safeParse({
      availability: "available",
      projectorVersion: PROJECTOR_VERSION,
      sourceWatermark: digest({
        projectorVersion: PROJECTOR_VERSION,
        assignment: assignment.data,
        selection,
        need,
        agent,
      }),
      sourceRefs,
      updatedAt:
        latestTimestamp([
          assignment.data.assigned_at,
          assignment.data.started_at,
          assignment.data.released_at,
          selection.time_updated,
          need.time_updated,
          agent.time_updated,
        ]) ?? new Date(0).toISOString(),
      assignmentId: assignment.data.id,
      projectId: assignment.data.project_id,
      workItemId: assignment.data.work_item_id,
      agent: { id: agent.id, name: agent.name },
      lifecycleAtSelection: selection.lifecycle_at_selection,
      currentLifecycle: agent.lifecycle,
      status: assignment.data.status,
      version: assignment.data.version,
      temporaryRole: assignment.data.temporary_role,
      responsibility: assignment.data.responsibility,
      permissionMode: assignment.data.permission_mode,
      need: {
        id: need.id,
        key: need.need_key,
        role: need.role,
      },
      selectionReason: selection.reason,
      sourceReceiptId: assignment.data.source_receipt_id,
      supersedesAssignmentId: assignment.data.supersedes_assignment_id,
      assignedAt: timestamp(assignment.data.assigned_at),
      startedAt: assignment.data.started_at === undefined ? undefined : timestamp(assignment.data.started_at),
      releasedAt: assignment.data.released_at === undefined ? undefined : timestamp(assignment.data.released_at),
      releaseReason: assignment.data.release_reason,
    })
    return summary.success && summary.data.availability === "available" ? summary.data : undefined
  })
  if (assignments.some((assignment) => !assignment)) return unavailableOrganization(facts, false)
  const values = assignments.filter((assignment): assignment is NonNullable<typeof assignment> => !!assignment)
  const sourceRefs = uniqueSourceRefs([
    projectSourceRef(projectID),
    ...values.map(
      (assignment): ExperienceSourceRef => ({
        kind: "project_assignment",
        id: assignment.assignmentId,
        version: assignment.version,
      }),
    ),
  ])
  const projection = OrganizationProjection.safeParse({
    availability: "available",
    projectorVersion: PROJECTOR_VERSION,
    sourceWatermark: digest({
      projectorVersion: PROJECTOR_VERSION,
      project: facts.project,
      assignments: values.map((assignment) => assignment.sourceWatermark),
    }),
    sourceRefs,
    updatedAt:
      latestTimestamp([facts.project.updated_at, ...values.map((assignment) => Date.parse(assignment.updatedAt))]) ??
      new Date(0).toISOString(),
    projectId: facts.project.id,
    activeAssignmentCount: values.filter(
      (assignment) => assignment.status === "assigned" || assignment.status === "active",
    ).length,
    assignments: values,
  })
  return projection.success ? projection.data : unavailableOrganization(facts, false)
}

function unavailableGraph(facts: NonNullable<ReturnType<typeof graphFacts>>, overflow: boolean) {
  const projectId = identifier(facts.project.id, "project")
  return GraphChangeSummary.parse({
    availability: "unavailable",
    projectorVersion: PROJECTOR_VERSION,
    sourceWatermark: digest({ projectorVersion: PROJECTOR_VERSION, facts }),
    sourceRefs: [projectSourceRef(projectId)],
    updatedAt: timestamp(facts.project.updated_at) ?? new Date(0).toISOString(),
    projectId,
    reason: {
      code: overflow ? "projection_overflow" : "invalid_persisted_fact",
      message: overflow
        ? "图变化事实超过只读投影上限，当前图状态不可用。"
        : "图变化持久化事实无法安全解析，当前图状态不可用。",
    },
  })
}

function graphFacts(projectID: string) {
  return Database.transaction((db) => {
    const project = db
      .select({
        id: CompanyProjectTable.id,
        graph_revision: CompanyProjectTable.graph_revision,
        updated_at: CompanyProjectTable.updated_at,
      })
      .from(CompanyProjectTable)
      .where(eq(CompanyProjectTable.id, projectID))
      .get()
    if (!project) return undefined
    const mutations = db
      .select()
      .from(CompanyGraphMutationTable)
      .where(eq(CompanyGraphMutationTable.project_id, projectID))
      .orderBy(asc(CompanyGraphMutationTable.created_at), asc(CompanyGraphMutationTable.id))
      .limit(MAX_PROJECTION_ITEMS + 1)
      .all()
    const receiptIDs = [...new Set(mutations.map((row) => row.trigger_receipt_id))]
    return {
      project,
      mutations,
      receipts: receiptIDs.length
        ? db
            .select({
              id: CompanyWorkReceiptTable.id,
              project_id: CompanyWorkReceiptTable.project_id,
            })
            .from(CompanyWorkReceiptTable)
            .where(inArray(CompanyWorkReceiptTable.id, receiptIDs))
            .orderBy(asc(CompanyWorkReceiptTable.id))
            .all()
        : [],
    }
  })
}

export function graph(projectID: string) {
  const facts = graphFacts(projectID)
  if (!facts) return undefined
  if (!timestamp(facts.project.updated_at)) return unavailableGraph(facts, false)
  if (facts.mutations.length > MAX_PROJECTION_ITEMS) return unavailableGraph(facts, true)
  const receipts = new Map(facts.receipts.map((row) => [row.id, row.project_id]))
  const changes = facts.mutations.map((row) => {
    const mutation = mutationFromRow(row)
    if (!mutation.success) return undefined
    if (
      mutation.data.project_id !== projectID ||
      receipts.get(mutation.data.trigger_receipt_id) !== projectID ||
      !validTimestamps([mutation.data.created_at, mutation.data.applied_at])
    )
      return undefined
    const sourceRefs = uniqueSourceRefs([
      projectSourceRef(projectID),
      { kind: "graph_mutation", id: mutation.data.id },
      { kind: "work_receipt", id: mutation.data.trigger_receipt_id },
      ...evidenceSourceRefs(mutation.data.evidence_refs),
    ])
    return {
      mutationId: mutation.data.id,
      decision: mutation.data.decision,
      status: mutation.data.status,
      rationale: mutation.data.rationale,
      expectedRevision: mutation.data.expected_revision,
      appliedRevision: mutation.data.applied_revision,
      triggerReceiptId: mutation.data.trigger_receipt_id,
      operationCounts: {
        addedWorkItems: mutation.data.operations.filter((operation) => operation.type === "add_work_item").length,
        addedDependencies: mutation.data.operations.filter((operation) => operation.type === "add_dependency").length,
        removedDependencies: mutation.data.operations.filter((operation) => operation.type === "remove_dependency")
          .length,
        supersededWorkItems: mutation.data.operations.filter((operation) => operation.type === "supersede_work_item")
          .length,
        addedValidationGates: mutation.data.operations.filter((operation) => operation.type === "add_validation_gate")
          .length,
        requestedCapabilities: mutation.data.operations.filter((operation) => operation.type === "request_capability")
          .length,
        requestedUserDecisions: mutation.data.operations.filter(
          (operation) => operation.type === "request_user_decision",
        ).length,
      },
      createdAt: timestamp(mutation.data.created_at),
      appliedAt: mutation.data.applied_at === undefined ? undefined : timestamp(mutation.data.applied_at),
      sourceRefs,
    }
  })
  if (changes.some((change) => !change)) return unavailableGraph(facts, false)
  const values = changes.filter((change): change is NonNullable<typeof change> => !!change)
  const sourceRefs = uniqueSourceRefs([
    projectSourceRef(projectID),
    ...values.map(
      (change): ExperienceSourceRef => ({
        kind: "graph_mutation",
        id: change.mutationId,
      }),
    ),
  ])
  const projection = GraphChangeSummary.safeParse({
    availability: "available",
    projectorVersion: PROJECTOR_VERSION,
    sourceWatermark: digest({ projectorVersion: PROJECTOR_VERSION, facts }),
    sourceRefs,
    updatedAt:
      latestTimestamp([
        facts.project.updated_at,
        ...facts.mutations.flatMap((mutation) => [mutation.created_at, mutation.applied_at]),
      ]) ?? new Date(0).toISOString(),
    projectId: facts.project.id,
    revision: facts.project.graph_revision,
    changes: values,
  })
  return projection.success ? projection.data : unavailableGraph(facts, false)
}

function unavailableDiscovery(
  facts: NonNullable<ReturnType<typeof discoveryFacts>>,
  projectID: string,
  receiptID: string,
) {
  const projectId = identifier(projectID, "project")
  const safeReceiptID = identifier(receiptID, "receipt")
  return DiscoverySummary.parse({
    availability: "unavailable",
    projectorVersion: PROJECTOR_VERSION,
    sourceWatermark: digest({ projectorVersion: PROJECTOR_VERSION, facts }),
    sourceRefs: uniqueSourceRefs([projectSourceRef(projectId), { kind: "work_receipt", id: safeReceiptID }]),
    updatedAt:
      latestTimestamp([
        facts.project.updated_at,
        facts.receipt.created_at,
        facts.receipt.processed_at,
        facts.attempt?.started_at,
        facts.attempt?.finished_at,
      ]) ?? new Date(0).toISOString(),
    receiptId: safeReceiptID,
    projectId,
    reason: {
      code: "invalid_persisted_fact",
      message: "Receipt 或 Attempt 持久化事实无法安全解析，当前发现摘要不可用。",
    },
  })
}

function discoveryFacts(projectID: string, receiptID: string) {
  return Database.transaction((db) => {
    const project = db
      .select({
        id: CompanyProjectTable.id,
        updated_at: CompanyProjectTable.updated_at,
      })
      .from(CompanyProjectTable)
      .where(eq(CompanyProjectTable.id, projectID))
      .get()
    if (!project) return undefined
    const receipt = db.select().from(CompanyWorkReceiptTable).where(eq(CompanyWorkReceiptTable.id, receiptID)).get()
    if (!receipt || receipt.project_id !== projectID) return undefined
    return {
      project,
      receipt,
      workItem: db
        .select({
          id: CompanyWorkItemTable.id,
          project_id: CompanyWorkItemTable.project_id,
        })
        .from(CompanyWorkItemTable)
        .where(eq(CompanyWorkItemTable.id, receipt.work_item_id))
        .get(),
      attempt: db
        .select()
        .from(CompanyWorkAttemptTable)
        .where(eq(CompanyWorkAttemptTable.id, receipt.attempt_id))
        .get(),
      mutation:
        receipt.processed_mutation_id === null
          ? undefined
          : db
              .select({
                id: CompanyGraphMutationTable.id,
                project_id: CompanyGraphMutationTable.project_id,
                trigger_receipt_id: CompanyGraphMutationTable.trigger_receipt_id,
              })
              .from(CompanyGraphMutationTable)
              .where(eq(CompanyGraphMutationTable.id, receipt.processed_mutation_id))
              .get(),
    }
  })
}

export function discovery(projectID: string, receiptID: string) {
  const facts = discoveryFacts(projectID, receiptID)
  if (!facts) return undefined
  if (!timestamp(facts.project.updated_at)) return unavailableDiscovery(facts, projectID, receiptID)
  const receipt = receiptFromRow(facts.receipt)
  const attempt = facts.attempt ? attemptFromRow(facts.attempt) : undefined
  if (
    !receipt.success ||
    !attempt?.success ||
    facts.workItem?.project_id !== projectID ||
    attempt.data.project_id !== projectID ||
    attempt.data.id !== receipt.data.attempt_id ||
    attempt.data.work_item_id !== receipt.data.work_item_id ||
    (receipt.data.processed_mutation_id !== undefined &&
      (facts.mutation?.project_id !== projectID || facts.mutation.trigger_receipt_id !== receipt.data.id)) ||
    !validTimestamps([
      receipt.data.created_at,
      receipt.data.processed_at,
      attempt.data.started_at,
      attempt.data.finished_at,
    ])
  )
    return unavailableDiscovery(facts, projectID, receiptID)
  const sourceRefs = uniqueSourceRefs([
    projectSourceRef(projectID),
    { kind: "work_item", id: receipt.data.work_item_id },
    { kind: "work_receipt", id: receipt.data.id },
    { kind: "work_attempt", id: attempt.data.id },
    ...(receipt.data.processed_mutation_id
      ? ([{ kind: "graph_mutation", id: receipt.data.processed_mutation_id }] satisfies ExperienceSourceRef[])
      : []),
    ...evidenceSourceRefs(receipt.data.evidence_refs),
  ])
  const projection = DiscoverySummary.safeParse({
    availability: "available",
    projectorVersion: PROJECTOR_VERSION,
    sourceWatermark: digest({ projectorVersion: PROJECTOR_VERSION, facts }),
    sourceRefs,
    updatedAt:
      latestTimestamp([
        facts.project.updated_at,
        receipt.data.created_at,
        receipt.data.processed_at,
        attempt.data.started_at,
        attempt.data.finished_at,
      ]) ?? new Date(0).toISOString(),
    receiptId: receipt.data.id,
    projectId: receipt.data.project_id,
    workItemId: receipt.data.work_item_id,
    attempt: {
      id: attempt.data.id,
      ordinal: attempt.data.ordinal,
      status: attempt.data.status,
      failureKind: attempt.data.failure_kind,
      safeSummary: attempt.data.safe_summary,
      startedAt: timestamp(attempt.data.started_at),
      finishedAt: attempt.data.finished_at === undefined ? undefined : timestamp(attempt.data.finished_at),
    },
    outcome: receipt.data.outcome,
    processingStatus: receipt.data.processing_status,
    summary: receipt.data.summary,
    confirmedFacts: receipt.data.confirmed_facts,
    invalidatedAssumptions: receipt.data.invalidated_assumptions,
    unknowns: receipt.data.unknowns,
    blockers: receipt.data.blockers,
    capabilityGaps: receipt.data.capability_gaps,
    questions: receipt.data.questions,
    processedMutationId: receipt.data.processed_mutation_id,
    createdAt: timestamp(receipt.data.created_at),
    processedAt: receipt.data.processed_at === undefined ? undefined : timestamp(receipt.data.processed_at),
  })
  return projection.success ? projection.data : unavailableDiscovery(facts, projectID, receiptID)
}

function unavailableValidation(facts: NonNullable<ReturnType<typeof validationFacts>>, overflow: boolean) {
  const projectId = identifier(facts.project.id, "project")
  return ValidationSummary.parse({
    availability: "unavailable",
    projectorVersion: PROJECTOR_VERSION,
    sourceWatermark: digest({ projectorVersion: PROJECTOR_VERSION, facts }),
    sourceRefs: [projectSourceRef(projectId)],
    updatedAt: timestamp(facts.project.updated_at) ?? new Date(0).toISOString(),
    projectId,
    reason: {
      code: overflow ? "projection_overflow" : "invalid_persisted_fact",
      message: overflow
        ? "Validation Gate 事实超过只读投影上限，当前验证状态不可用。"
        : "Validation Gate 持久化事实无法安全解析，当前验证状态不可用。",
    },
  })
}

function validationFacts(projectID: string) {
  return Database.transaction((db) => {
    const project = db
      .select({
        id: CompanyProjectTable.id,
        updated_at: CompanyProjectTable.updated_at,
      })
      .from(CompanyProjectTable)
      .where(eq(CompanyProjectTable.id, projectID))
      .get()
    if (!project) return undefined
    return {
      project,
      gates: db
        .select()
        .from(CompanyValidationGateTable)
        .where(eq(CompanyValidationGateTable.project_id, projectID))
        .orderBy(asc(CompanyValidationGateTable.created_at), asc(CompanyValidationGateTable.id))
        .limit(MAX_PROJECTION_ITEMS + 1)
        .all(),
    }
  })
}

export function validation(projectID: string) {
  const facts = validationFacts(projectID)
  if (!facts) return undefined
  if (!timestamp(facts.project.updated_at)) return unavailableValidation(facts, false)
  if (facts.gates.length > MAX_PROJECTION_ITEMS) return unavailableValidation(facts, true)
  const gates = facts.gates.map((row) => {
    const gate = gateFromRow(row)
    if (!gate.success) return undefined
    if (!validTimestamps([gate.data.created_at, gate.data.evaluated_at])) return undefined
    const evidenceRefs = evidenceSourceRefs(gate.data.evidence_refs)
    return {
      gateId: gate.data.id,
      workItemId: gate.data.work_item_id,
      kind: gate.data.kind,
      status: gate.data.status,
      criteria: gate.data.criteria,
      criteriaSha256: gate.data.criteria_sha256,
      blockingWorkItemIds: gate.data.blocking_work_item_ids,
      evidenceRefs,
      evaluator: gate.data.evaluator,
      repairRound: gate.data.repair_round,
      maxRepairRounds: gate.data.max_repair_rounds,
      failureSummary: gate.data.failure_summary,
      supersedesGateId: gate.data.supersedes_gate_id,
      createdAt: timestamp(gate.data.created_at),
      evaluatedAt: gate.data.evaluated_at === undefined ? undefined : timestamp(gate.data.evaluated_at),
      sourceRefs: uniqueSourceRefs([
        projectSourceRef(projectID),
        { kind: "validation_gate", id: gate.data.id },
        ...evidenceRefs,
      ]),
    }
  })
  if (gates.some((gate) => !gate)) return unavailableValidation(facts, false)
  const values = gates.filter((gate): gate is NonNullable<typeof gate> => !!gate)
  const sourceRefs = uniqueSourceRefs([
    projectSourceRef(projectID),
    ...values.map(
      (gate): ExperienceSourceRef => ({
        kind: "validation_gate",
        id: gate.gateId,
      }),
    ),
  ])
  const projection = ValidationSummary.safeParse({
    availability: "available",
    projectorVersion: PROJECTOR_VERSION,
    sourceWatermark: digest({ projectorVersion: PROJECTOR_VERSION, facts }),
    sourceRefs,
    updatedAt:
      latestTimestamp([
        facts.project.updated_at,
        ...facts.gates.flatMap((gate) => [gate.created_at, gate.evaluated_at]),
      ]) ?? new Date(0).toISOString(),
    projectId: facts.project.id,
    blockingGateCount: values.filter((gate) => ["pending", "running", "failed"].includes(gate.status)).length,
    gates: values,
  })
  return projection.success ? projection.data : unavailableValidation(facts, false)
}
