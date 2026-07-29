import { createHash } from "node:crypto"
import { writeSync } from "node:fs"
import { Effect, Layer } from "effect"
import { and, asc, eq } from "drizzle-orm"
import { CompanyGraphMutation, CompanyProject, CompanyProjectRecovery, CompanyWorkFacts } from "../src/company-project"
import {
  CompanyArtifactTable,
  CompanyGraphDecisionTable,
  CompanyGraphMutationTable,
  CompanyPlanTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkItemDependencyTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "../src/company-project/company-project.sql"
import { CompanyWorkProjectionTable } from "../src/company-project/work-projection.sql"
import * as WorkProjection from "../src/company-project/work-projection"
import { GraphMutationProposal } from "../src/company-project/schema"
import {
  B5CandidateRecoveryChildRequest,
  type B5CandidateRecoveryChildRequest as ChildRequest,
} from "../src/metrics/b5-candidate-recovery"
import { GraphSupervisor } from "../src/project-orchestrator/graph-supervisor"
import { ProjectOrchestrator } from "../src/project-orchestrator/project-orchestrator"
import { Database } from "../src/storage"

const request = B5CandidateRecoveryChildRequest.parse(
  JSON.parse(Buffer.from(Bun.argv[2] ?? "", "base64url").toString()),
)

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]),
  )
}

function sha256(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(normalized(value)))
    .digest("hex")
}

function title(input: ChildRequest) {
  return `B5 ${input.scenarioId} ${input.key}${input.boundary ? ` ${input.boundary}` : ""}`
}

function projectRow(input: ChildRequest) {
  const row = Database.use((db) =>
    db
      .select()
      .from(CompanyProjectTable)
      .where(eq(CompanyProjectTable.title, title(input)))
      .get(),
  )
  if (!row) throw new Error(`B5 recovery project is unavailable: ${title(input)}`)
  return row
}

function projectFacts(projectId: string) {
  return Database.use((db) => ({
    project: db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, projectId)).get(),
    plans: db
      .select()
      .from(CompanyPlanTable)
      .where(eq(CompanyPlanTable.project_id, projectId))
      .orderBy(asc(CompanyPlanTable.id))
      .all(),
    workItems: db
      .select()
      .from(CompanyWorkItemTable)
      .where(eq(CompanyWorkItemTable.project_id, projectId))
      .orderBy(asc(CompanyWorkItemTable.id))
      .all(),
    dependencies: db
      .select()
      .from(CompanyWorkItemDependencyTable)
      .innerJoin(CompanyWorkItemTable, eq(CompanyWorkItemTable.id, CompanyWorkItemDependencyTable.work_item_id))
      .where(eq(CompanyWorkItemTable.project_id, projectId))
      .orderBy(asc(CompanyWorkItemDependencyTable.work_item_id), asc(CompanyWorkItemDependencyTable.depends_on_id))
      .all(),
    receipts: db
      .select()
      .from(CompanyWorkReceiptTable)
      .where(eq(CompanyWorkReceiptTable.project_id, projectId))
      .orderBy(asc(CompanyWorkReceiptTable.id))
      .all(),
    decisions: db
      .select()
      .from(CompanyGraphDecisionTable)
      .where(eq(CompanyGraphDecisionTable.project_id, projectId))
      .orderBy(asc(CompanyGraphDecisionTable.id))
      .all(),
    mutations: db
      .select()
      .from(CompanyGraphMutationTable)
      .where(eq(CompanyGraphMutationTable.project_id, projectId))
      .orderBy(asc(CompanyGraphMutationTable.id))
      .all(),
    artifacts: db
      .select()
      .from(CompanyArtifactTable)
      .where(eq(CompanyArtifactTable.project_id, projectId))
      .orderBy(asc(CompanyArtifactTable.id))
      .all(),
    events: db
      .select()
      .from(CompanyProjectEventTable)
      .where(eq(CompanyProjectEventTable.project_id, projectId))
      .orderBy(asc(CompanyProjectEventTable.id))
      .all(),
    projection: db
      .select()
      .from(CompanyWorkProjectionTable)
      .where(eq(CompanyWorkProjectionTable.project_id, projectId))
      .get(),
  }))
}

function digests(projectId: string) {
  const facts = projectFacts(projectId)
  return {
    databaseSha256: sha256(facts),
    businessSha256: sha256({
      project: facts.project && {
        id: facts.project.id,
        status: facts.project.status,
        graph_revision: facts.project.graph_revision,
        orchestration_state: facts.project.orchestration_state,
      },
      workItems: facts.workItems.map((item) => ({
        id: item.id,
        status: item.status,
        origin_kind: item.origin_kind,
        graph_revision_created: item.graph_revision_created,
      })),
      dependencies: facts.dependencies.map((item) => ({
        work_item_id: item.company_work_item_dependency.work_item_id,
        depends_on_id: item.company_work_item_dependency.depends_on_id,
      })),
      receipts: facts.receipts.map((receipt) => ({
        id: receipt.id,
        processing_status: receipt.processing_status,
        processed_decision_id: receipt.processed_decision_id,
        processed_mutation_id: receipt.processed_mutation_id,
      })),
      decisions: facts.decisions.map((decision) => ({
        id: decision.id,
        status: decision.status,
        mutation_id: decision.mutation_id,
      })),
      mutations: facts.mutations.map((mutation) => ({
        id: mutation.id,
        status: mutation.status,
        applied_revision: mutation.applied_revision,
      })),
      projection: facts.projection && {
        projector_version: facts.projection.projector_version,
        source_watermark: facts.projection.source_watermark,
      },
    }),
  }
}

async function write(value: Record<string, unknown>, close = true) {
  if (close) Database.close()
  await Bun.write(Bun.stdout, `${JSON.stringify({ ...value, pid: process.pid })}\n`)
  if (close) process.exit(0)
}

function taskProposal(planId: string, sourceId: string, key: string) {
  return {
    type: "add_work_item",
    item: {
      id: `b5-recovery-added-${key}`,
      plan_id: planId,
      parent_id: sourceId,
      title: `B5 recovery continuation ${key}`,
      description: `Persist the bounded recovery continuation ${key}`,
      kind: "worker",
      work_type: "analysis",
      role: "recovery verifier",
      capability_packs: [],
      decision_scope: ["local recovery"],
      resource_scope: ["local recovery"],
      inputs: [],
      expected_outputs: ["Recovery evidence"],
      validators: ["Recovery evidence is persisted"],
      disposition: "retain",
      model_group: "standard",
      risk_level: "medium",
      review_status: "not_required",
      acceptance_criteria: ["Recovery evidence is persisted"],
      max_attempts: 3,
      purpose: "recovery",
      validation_mode: "machine",
    },
  }
}

async function createProject(input: ChildRequest, grow: boolean) {
  return Effect.runPromise(
    CompanyProject.Service.use((projects) =>
      Effect.gen(function* () {
        const project = yield* projects.create({
          goal: title(input),
          title: title(input),
          execution_strategy: "seed_and_grow",
          seed_mode: "seed_pair",
        })
        yield* projects.transition({ id: project.id, status: "planning", reason: "B5 recovery fixture" })
        const plan = yield* projects.createPlan({
          project_id: project.id,
          phase: "execution",
          summary: title(input),
          acceptance_criteria: ["Persisted recovery facts converge exactly once"],
        })
        const item = yield* projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: `${title(input)} source`,
          description: `${title(input)} committed source work`,
          kind: "worker",
          work_type: "analysis",
          role: "recovery source",
          decision_scope: ["local recovery"],
          resource_scope: ["local recovery"],
          expected_outputs: ["Persisted recovery source"],
          model_group: "standard",
          risk_level: "medium",
          review_status: "not_required",
          purpose: "first_slice",
          origin_kind: "seed",
          validation_mode: "machine",
          acceptance_criteria: ["Persisted recovery source exists"],
        })
        yield* projects.transition({ id: project.id, status: "executing", reason: "B5 recovery execution" })
        yield* projects.startWorkItem(item.id)
        const artifact = yield* projects.addArtifact({
          project_id: project.id,
          work_item_id: item.id,
          kind: "b5_recovery_anchor",
          title: `${title(input)} anchor`,
          content: `${input.candidateSha}:${input.snapshotDigest}:${input.runId}`,
          evidence: { scenarioId: input.scenarioId, runId: input.runId },
        })
        yield* projects.completeWorkItemWithReceipt({
          id: item.id,
          receipt: {
            idempotency_key: `b5-recovery-receipt-${input.key}`,
            outcome: "completed",
            summary: `${title(input)} committed receipt`,
            artifact_ids: [artifact.id],
            evidence_refs: [{ kind: "artifact", id: artifact.id }],
            confirmed_facts: [`scenario=${input.scenarioId}`, `run=${input.runId}`],
            invalidated_assumptions: [],
            unknowns: [],
            blockers: [],
            capability_gaps: [],
            task_proposals: grow ? [taskProposal(plan.id, item.id, input.key)] : [],
            dependency_proposals: [],
            questions: [],
          },
        })
        const receipt = (yield* projects.listWorkReceipts(project.id))[0]
        if (!receipt || receipt.processing_status !== "pending")
          throw new Error(`${input.scenarioId} did not persist a pending Work Receipt`)
        return { project, plan, item, receipt }
      }),
    ).pipe(Effect.provide(CompanyProject.defaultLayer)),
  )
}

function proposal(input: ChildRequest) {
  const project = projectRow(input)
  const facts = projectFacts(project.id)
  const item = facts.workItems.find((candidate) => candidate.origin_kind === "seed")
  const receipt = facts.receipts[0]
  const plan = facts.plans[0]
  if (!item || !receipt || !plan) throw new Error(`S20 ${input.boundary} facts are incomplete`)
  return GraphMutationProposal.parse({
    project_id: project.id,
    trigger_receipt_id: receipt.id,
    expected_revision: 0,
    orchestrator_version: 1,
    idempotency_key: `b5-recovery-mutation-${input.key}`,
    decision: "expand",
    rationale: `Recover ${input.boundary}`,
    evidence_refs: JSON.parse(receipt.evidence_refs_json),
    operations: [taskProposal(plan.id, item.id, input.key)],
  })
}

async function recoverOrchestration(projectId: string) {
  const recoveryStartedAt = Date.now()
  const phases: Array<"company_project" | "receipt_graph" | "project_orchestrator" | "projection"> = []
  const projectRecovery = await Effect.runPromise(
    CompanyProjectRecovery.Service.use((service) => service.recover()).pipe(
      Effect.provide(CompanyProjectRecovery.defaultLayer),
    ),
  )
  phases.push("company_project")
  const receiptRecovery = await Effect.runPromise(
    GraphSupervisor.Service.use((service) => service.drain(projectId)).pipe(
      Effect.provide(supervisorLayer),
    ),
  )
  phases.push("receipt_graph")
  const orchestrator = await Effect.runPromise(
    ProjectOrchestrator.Service.use((service) => service.recover()).pipe(
      Effect.provide(ProjectOrchestrator.defaultLayer),
    ),
  )
  phases.push("project_orchestrator")
  const projection = WorkProjection.rebuild(projectId)
  const projectionRow = Database.use((db) =>
    db.select().from(CompanyWorkProjectionTable).where(eq(CompanyWorkProjectionTable.project_id, projectId)).get(),
  )
  if (!projection || !projectionRow) throw new Error(`S27 projection did not converge for ${projectId}`)
  phases.push("projection")
  const reconciledAt = Date.now()
  const dispatch = await Effect.runPromise(
    ProjectOrchestrator.Service.use((service) => service.dispatchReady(projectId)).pipe(
      Effect.provide(ProjectOrchestrator.defaultLayer),
    ),
  )
  return {
    recoveryStartedAt,
    reconciledAt,
    dispatchProbedAt: Date.now(),
    projectRecovery,
    receiptRecovery,
    orchestrator,
    phases,
    projection,
    projectionRow,
    dispatch,
  }
}

const supervisorLayer = GraphSupervisor.makeLayer({ mode: "active" }).pipe(
  Layer.provide(
    Layer.mergeAll(
      CompanyProject.defaultLayer,
      CompanyWorkFacts.makeLayer({ recoverOnStart: false }),
      CompanyGraphMutation.makeLayer({ publish: async () => {} }),
    ),
  ),
)

async function s19() {
  if (request.mode === "crash") {
    const created = await createProject(request, false)
    await write(
      {
        projectId: created.project.id,
        workItemIds: [created.item.id],
        receiptIds: [created.receipt.id],
        mutationIds: [],
        ...digests(created.project.id),
        duplicateSideEffects: 0,
        exactlyOnce: false,
        receiptStatus: created.receipt.processing_status,
      },
      false,
    )
    await new Promise(() => {})
    return
  }
  if (request.mode !== "recover") throw new Error("S19 expects crash or recover")
  const project = projectRow(request)
  const first = await Effect.runPromise(
    GraphSupervisor.Service.use((service) => service.recover()).pipe(Effect.provide(supervisorLayer)),
  )
  const replay = await Effect.runPromise(
    GraphSupervisor.Service.use((service) => service.recover()).pipe(Effect.provide(supervisorLayer)),
  )
  const facts = projectFacts(project.id)
  const processedEvents = facts.events.filter((event) => event.type === "work_receipt.processed").length
  const receiptId = facts.receipts[0]?.id
  const firstRecoverProcessedCount = first.processed_receipt_ids.filter(
    (id) => id === receiptId,
  ).length
  const secondRecoverProcessedCount = replay.processed_receipt_ids.filter(
    (id) => id === receiptId,
  ).length
  const duplicateSideEffects =
    Math.max(0, processedEvents - 1) + Math.max(0, facts.decisions.length - 1) + Math.max(0, facts.mutations.length - 1)
  await write({
    projectId: project.id,
    workItemIds: facts.workItems.map((item) => item.id),
    receiptIds: facts.receipts.map((receipt) => receipt.id),
    mutationIds: facts.mutations.map((mutation) => mutation.id),
    ...digests(project.id),
    duplicateSideEffects,
    exactlyOnce:
      firstRecoverProcessedCount === 1 &&
      secondRecoverProcessedCount === 0 &&
      facts.receipts[0]?.processing_status === "processed" &&
      processedEvents === 1 &&
      duplicateSideEffects === 0,
    recoveredAt: Date.now(),
    receiptStatus: facts.receipts[0]?.processing_status,
    firstRecoverProcessedCount,
    secondRecoverProcessedCount,
  })
}

async function s20() {
  if (!request.boundary) throw new Error("S20 requires a mutation boundary")
  if (request.mode === "prepare") {
    const created = await createProject(request, true)
    await Effect.runPromise(
      CompanyWorkFacts.Service.use((service) => service.claimReceipt(created.receipt.id)).pipe(
        Effect.provide(CompanyWorkFacts.makeLayer({ recoverOnStart: false })),
      ),
    )
    await write({
      projectId: created.project.id,
      workItemIds: [created.item.id],
      receiptIds: [created.receipt.id],
      mutationIds: [],
      ...digests(created.project.id),
      duplicateSideEffects: 0,
      exactlyOnce: false,
      beforeRevision: 0,
    })
    return
  }
  if (request.mode === "crash") {
    await Effect.runPromise(
      CompanyGraphMutation.Service.use((service) => service.apply(proposal(request))).pipe(
        Effect.provide(
          CompanyGraphMutation.makeLayer({
            onBoundary: (boundary) => {
              if (boundary !== request.boundary) return
              writeSync(
                1,
                `${JSON.stringify({
                  kind: "b5-s20-boundary",
                  boundary,
                  pid: process.pid,
                })}\n`,
              )
              process.kill(process.pid, 9)
            },
            publish: async () => {},
          }),
        ),
      ),
    )
    throw new Error(`S20 ${request.boundary} did not terminate`)
  }
  const project = projectRow(request)
  const before = projectFacts(project.id)
  const addedId = `b5-recovery-added-${request.key}`
  const addedBefore = before.workItems.filter((item) => item.id === addedId).length
  const mutationBefore = before.mutations.length
  const appliedBefore = before.events.filter((event) => event.type === "graph_mutation.applied").length
  const atomicState =
    before.project?.graph_revision === 0 && addedBefore === 0 && mutationBefore === 0 && appliedBefore === 0
      ? "old"
      : before.project?.graph_revision === 1 && addedBefore === 1 && mutationBefore === 1 && appliedBefore === 1
        ? "new"
        : undefined
  if (!atomicState) throw new Error(`S20 ${request.boundary} exposed a partial graph state`)
  await Effect.runPromise(
    CompanyGraphMutation.Service.use((service) => service.recover()).pipe(
      Effect.provide(CompanyGraphMutation.makeLayer({ publish: async () => {} })),
    ),
  )
  const applied = await Effect.runPromise(
    CompanyGraphMutation.Service.use((service) => service.apply(proposal(request))).pipe(
      Effect.provide(CompanyGraphMutation.makeLayer({ publish: async () => {} })),
    ),
  )
  if (applied.status !== "applied") throw new Error(`S20 ${request.boundary} did not converge to an applied mutation`)
  const after = projectFacts(project.id)
  const addedAfter = after.workItems.filter((item) => item.id === addedId).length
  const appliedAfter = after.events.filter((event) => event.type === "graph_mutation.applied").length
  const duplicateSideEffects =
    Math.max(0, after.mutations.length - 1) + Math.max(0, addedAfter - 1) + Math.max(0, appliedAfter - 1)
  await write({
    projectId: project.id,
    workItemIds: after.workItems.map((item) => item.id),
    receiptIds: after.receipts.map((receipt) => receipt.id),
    mutationIds: after.mutations.map((mutation) => mutation.id),
    ...digests(project.id),
    duplicateSideEffects,
    exactlyOnce: after.project?.graph_revision === 1 && duplicateSideEffects === 0,
    recoveredAt: Date.now(),
    beforeRevision: 0,
    afterRevision: after.project?.graph_revision,
    atomicState,
    replayed: applied.replayed,
  })
}

async function s27() {
  if (request.mode === "crash") {
    const created = await createProject(request, true)
    WorkProjection.rebuild(created.project.id)
    const beforeProjection = Database.use((db) =>
      db
        .select()
        .from(CompanyWorkProjectionTable)
        .where(eq(CompanyWorkProjectionTable.project_id, created.project.id))
        .get(),
    )
    if (!beforeProjection) throw new Error("S27 projection fixture is unavailable")
    await write(
      {
        projectId: created.project.id,
        workItemIds: [created.item.id],
        receiptIds: [created.receipt.id],
        mutationIds: [],
        ...digests(created.project.id),
        duplicateSideEffects: 0,
        exactlyOnce: false,
      },
      false,
    )
    await new Promise(() => {})
    return
  }
  if (request.mode !== "recover") throw new Error("S27 expects crash or recover")
  const project = projectRow(request)
  const projectionBefore = projectFacts(project.id).projection?.source_watermark ?? "missing"
  const startup = await recoverOrchestration(project.id)
  const facts = projectFacts(project.id)
  const processedEvents = facts.events.filter((event) => event.type === "work_receipt.processed").length
  const appliedEvents = facts.events.filter((event) => event.type === "graph_mutation.applied").length
  const duplicateSideEffects =
    Math.max(0, processedEvents - 1) +
    Math.max(0, facts.decisions.length - 1) +
    Math.max(0, facts.mutations.length - 1) +
    Math.max(0, appliedEvents - 1)
  await write({
    projectId: project.id,
    workItemIds: facts.workItems.map((item) => item.id),
    receiptIds: facts.receipts.map((receipt) => receipt.id),
    mutationIds: facts.mutations.map((mutation) => mutation.id),
    ...digests(project.id),
    duplicateSideEffects,
    exactlyOnce:
      facts.receipts[0]?.processing_status === "processed" &&
      processedEvents === 1 &&
      facts.mutations.length === 1 &&
      appliedEvents === 1 &&
      duplicateSideEffects === 0,
    recoveredAt: Date.now(),
    startup: {
      recoveryStartedAt: startup.recoveryStartedAt,
      reconciledAt: startup.reconciledAt,
      dispatchProbedAt: startup.dispatchProbedAt,
      dispatchAfterReconcile:
        startup.dispatchProbedAt >= startup.reconciledAt &&
        startup.dispatch.dispatched_work_item_ids.length === 0 &&
        startup.orchestrator.dispatches.every((item) => item.dispatched_work_item_ids.length === 0),
      phases: startup.phases,
      projectionWatermarkBefore: projectionBefore,
      projectionWatermarkAfter: startup.projectionRow.source_watermark,
      projectionConverged:
        startup.projectionRow.source_watermark === startup.projection.sourceWatermark &&
        projectionBefore !== startup.projectionRow.source_watermark,
    },
  })
}

if (request.scenarioId === "S19") await s19()
if (request.scenarioId === "S20") await s20()
if (request.scenarioId === "S27") await s27()
