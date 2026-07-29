import { createHash } from "node:crypto"
import { Effect } from "effect"
import z from "zod"
import type { Interface as CompanyProjectInterface } from "@/company-project/company-project"
import type { Interface as CompanyProjectExecutionInterface } from "@/company-project/execution"
import type { Interface as CompanyAttentionInterface } from "@/company-project/attention"
import type { Interface as CompanyValidationGateInterface } from "@/company-project/validation-gate"
import type { Interface as CompanyRecruitmentInterface } from "@/company-recruitment/company-recruitment"
import type { Interface as DispatchCoordinatorInterface } from "@/project-orchestrator/dispatch"
import type { Interface as QuiescenceServiceInterface } from "@/project-orchestrator/quiescence"
import { evaluateSeedPolicy } from "@/project-orchestrator/seed-policy"
import { SeedPolicyFacts, type SeedPolicyFactsValue } from "@/project-orchestrator/schema"

export const B5ScenarioIds = [
  "S13",
  "S14",
  "S15",
  "S16",
  "S17",
  "S18",
  "S19",
  "S20",
  "S21",
  "S22",
  "S23",
  "S24",
  "S25",
  "S26",
  "S27",
] as const

export const B5StrategyOrder = ["legacy_full_plan", "seed_and_grow"] as const

export const B5ScenarioId = z.enum(B5ScenarioIds)
export const B5Strategy = z.enum(B5StrategyOrder)
export type B5ScenarioId = z.infer<typeof B5ScenarioId>
export type B5Strategy = z.infer<typeof B5Strategy>

const Digest = z.string().regex(/^[a-f0-9]{64}$/)

export const B5BenchmarkScenario = z
  .object({
    id: B5ScenarioId,
    title: z.string().trim().min(1),
    seed: z.number().int(),
    runMode: z.literal("automated"),
    firstRequiredStage: z.string().trim().min(1),
    inputs: z.array(z.string().trim().min(1)).min(1),
    expectedOutputs: z.array(z.string().trim().min(1)).min(1),
    allowedQuestions: z.array(z.string()),
    acceptanceCriteria: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            statement: z.string().trim().min(1),
            evidence: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1),
    failureConditions: z.array(z.string().trim().min(1)).min(1),
    observedMetrics: z.array(z.string().trim().min(1)).min(1),
    humanEvidenceRequired: z.tuple([]),
  })
  .strict()
export type B5BenchmarkScenario = z.infer<typeof B5BenchmarkScenario>

export const B5ScenarioSnapshot = z
  .object({
    scenario: B5BenchmarkScenario,
    snapshotDigest: Digest,
  })
  .strict()
export type B5ScenarioSnapshot = z.infer<typeof B5ScenarioSnapshot>

export const B5RunBinding = z
  .object({
    projectId: z.string().trim().min(1),
    scenarioId: B5ScenarioId,
    runId: z.string().trim().min(1),
    strategy: B5Strategy,
    snapshotDigest: Digest,
  })
  .strict()
export type B5RunBinding = z.infer<typeof B5RunBinding>

const SourceReference = z
  .object({
    kind: z.enum([
      "project",
      "project_event",
      "work_item",
      "work_attempt",
      "work_receipt",
      "graph_mutation",
      "project_assignment",
      "validation_gate",
      "approval_gate",
      "attention",
      "agent_run",
      "project_action",
      "artifact",
    ]),
    id: z.string().trim().min(1),
  })
  .strict()

const LegacyOracle = z
  .object({
    kind: z.literal("legacy_baseline"),
    initialWorkItemIds: z.array(z.string()),
    initialAssignmentIds: z.array(z.string()),
  })
  .strict()

const S13Oracle = z
  .object({
    kind: z.literal("s13_seed_pair"),
    seedMode: z.literal("seed_pair"),
    wayfinderWorkItemId: z.string().trim().min(1),
    builderWorkItemId: z.string().trim().min(1),
    assignmentIds: z.tuple([z.string().trim().min(1), z.string().trim().min(1)]),
    agentIds: z.tuple([z.string().trim().min(1), z.string().trim().min(1)]),
    initialGraphNodeCount: z.literal(2),
  })
  .strict()

const S15Oracle = z
  .object({
    kind: z.literal("s15_approval_stop"),
    seedMode: z.literal("discovery_first"),
    approvalGateId: z.string().trim().min(1),
    builderWorkItemId: z.string().trim().min(1),
    dispatchEventId: z.string().trim().min(1),
    builderDispatched: z.literal(false),
    externalEffectEventIds: z.tuple([]),
  })
  .strict()

const S22Oracle = z
  .object({
    kind: z.literal("s22_repair_circuit"),
    workItemId: z.string().trim().min(1),
    validationGateId: z.string().trim().min(1),
    attentionId: z.string().trim().min(1),
    attemptIds: z.tuple([
      z.string().trim().min(1),
      z.string().trim().min(1),
      z.string().trim().min(1),
    ]),
    repairRounds: z.tuple([z.literal(1), z.literal(2), z.literal(3)]),
    fourthAttemptScheduled: z.literal(false),
    fourthRepairReplayed: z.literal(true),
  })
  .strict()

const S24Oracle = z
  .object({
    kind: z.literal("s24_quiescence_blocked"),
    workItemId: z.string().trim().min(1),
    receiptId: z.string().trim().min(1),
    blockerCodes: z.array(z.string().trim().min(1)).min(1),
    deliveryArtifactIds: z.tuple([]),
  })
  .strict()

export const B5ScenarioRunResult = z
  .object({
    binding: B5RunBinding,
    projectStatus: z.enum([
      "intake",
      "planning",
      "executing",
      "reviewing",
      "awaiting_approval",
      "completed",
      "rejected",
      "blocked",
    ]),
    terminalDecision: z.enum(["completed", "correctly_stopped", "correctly_blocked", "in_progress"]),
    sourceRefs: z.array(SourceReference).min(1),
    oracle: z.discriminatedUnion("kind", [LegacyOracle, S13Oracle, S15Oracle, S22Oracle, S24Oracle]),
  })
  .strict()
export type B5ScenarioRunResult = z.infer<typeof B5ScenarioRunResult>

export const B5ScenarioPlan = [
  { id: "S13", driverId: "seed_pair_bootstrap", oracleKey: "bounded_initial_graph" },
  { id: "S14", driverId: "direct_single_low_risk", oracleKey: "no_unneeded_reviewer" },
  { id: "S15", driverId: "approval_gated_external_action", oracleKey: "dispatch_stopped" },
  { id: "S16", driverId: "prerequisite_repair", oracleKey: "same_anchor_reverified" },
  { id: "S17", driverId: "capability_gap_expansion", oracleKey: "third_assignment_materialized" },
  { id: "S18", driverId: "risk_driven_reviewer", oracleKey: "independent_review_chain" },
  { id: "S19", driverId: "receipt_process_restart", oracleKey: "receipt_exactly_once" },
  { id: "S20", driverId: "mutation_process_restart", oracleKey: "mutation_atomic_recovery" },
  { id: "S21", driverId: "revision_conflict_recompute", oracleKey: "stale_mutation_recomputed" },
  { id: "S22", driverId: "repair_circuit_breaker", oracleKey: "three_round_stop" },
  { id: "S23", driverId: "supersede_and_replace", oracleKey: "history_retained" },
  { id: "S24", driverId: "quiescence_pending_fact", oracleKey: "false_completion_rejected" },
  { id: "S25", driverId: "temporary_assignment_release", oracleKey: "identity_unchanged" },
  { id: "S26", driverId: "company_pool_reuse", oracleKey: "candidate_pool_stable" },
  { id: "S27", driverId: "full_orchestrator_restart", oracleKey: "recover_before_dispatch" },
] as const satisfies readonly {
  id: B5ScenarioId
  driverId: string
  oracleKey: string
}[]

const DeliveryScenarios = new Set<B5ScenarioId>([
  "S13",
  "S14",
  "S16",
  "S17",
  "S18",
  "S19",
  "S20",
  "S21",
  "S23",
  "S25",
  "S26",
  "S27",
])
const ValidationScenarios = new Set<B5ScenarioId>(["S15", "S16", "S18", "S22", "S23", "S24", "S27"])
const InterruptionScenarios = new Set<B5ScenarioId>(["S14", "S15", "S22"])
const ReviewScenarios = new Set<B5ScenarioId>(["S14", "S18"])

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
  return createHash("sha256").update(JSON.stringify(normalized(value))).digest("hex")
}

export function loadB5ScenarioSnapshots(value: unknown) {
  const scenarios = z
    .object({ scenarios: z.array(B5BenchmarkScenario) })
    .passthrough()
    .parse(value).scenarios
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
  return B5ScenarioIds.map((id) => {
    const scenario = byId.get(id)
    if (!scenario) throw new Error(`Benchmark scenario ${id} is missing`)
    return B5ScenarioSnapshot.parse({ scenario, snapshotDigest: digest(scenario) })
  })
}

export function exactB5RunBindings(value: readonly B5RunBinding[]) {
  const parsed = value.map((binding) => B5RunBinding.parse(binding))
  const byKey = new Map(parsed.map((binding) => [`${binding.scenarioId}:${binding.strategy}`, binding]))
  if (parsed.length !== 30 || byKey.size !== 30)
    throw new Error(`B5 candidate run requires exactly 30 unique strategy bindings, received ${parsed.length}`)
  return B5ScenarioIds.flatMap((scenarioId) => {
    const pair = B5StrategyOrder.map((strategy) => byKey.get(`${scenarioId}:${strategy}`))
    if (pair.some((binding) => !binding))
      throw new Error(`B5 candidate run is missing the matched ${scenarioId} strategy pair`)
    if (pair[0]!.snapshotDigest !== pair[1]!.snapshotDigest)
      throw new Error(`B5 candidate run has mismatched ${scenarioId} snapshots`)
    return pair as [B5RunBinding, B5RunBinding]
  })
}

export function requiredB5ObservationTypes(scenarioId: B5ScenarioId, strategy: B5Strategy) {
  return [
    "scenario.fixture_checked",
    "command.probe_checked",
    "git.blob_checked",
    "report.file_checked",
    "terminal.invariant_checked",
    "benchmark.checked",
    "model.usage_checked",
    ...(strategy === "seed_and_grow" ? ["shadow_pair.checked"] : []),
    ...(DeliveryScenarios.has(scenarioId) ? ["delivery.checked"] : []),
    ...(strategy === "seed_and_grow" && ["S19", "S27"].includes(scenarioId)
      ? ["receipt.recovery_checked"]
      : []),
    ...(strategy === "seed_and_grow" && ["S20", "S27"].includes(scenarioId)
      ? ["graph_mutation.recovery_checked"]
      : []),
    ...(strategy === "seed_and_grow" && ValidationScenarios.has(scenarioId)
      ? [scenarioId === "S15" ? "approval_gate.checked" : "validation_anchor.checked"]
      : []),
    ...(strategy === "seed_and_grow" && scenarioId === "S24" ? ["quiescence.checked"] : []),
    ...(strategy === "seed_and_grow" && InterruptionScenarios.has(scenarioId)
      ? ["interruption.checked"]
      : []),
    ...(ReviewScenarios.has(scenarioId) ? ["review_presence.checked"] : []),
    ...(strategy === "seed_and_grow" && ["S14", "S18"].includes(scenarioId)
      ? ["quality_pair.checked"]
      : []),
    ...(strategy === "seed_and_grow" && scenarioId === "S22" ? ["repair.circuit_checked"] : []),
  ]
}

function firstSlice(scenario: B5BenchmarkScenario) {
  return {
    id: `b5-${scenario.id.toLowerCase()}-first-slice`,
    title: scenario.expectedOutputs[0]!,
    description: scenario.acceptanceCriteria.map((criterion) => criterion.statement).join("\n"),
    work_type: "analysis" as const,
    role: "bounded evidence operator",
    capability_packs: ["research-analysis@1"],
    decision_scope: ["scenario evidence"],
    resource_scope: [`artifacts/b5/${scenario.id.toLowerCase()}`],
    acceptance_criteria: scenario.acceptanceCriteria.map((criterion) => criterion.statement),
    reality_contact: 3,
    information_gain: 3,
    user_value: 2,
    reversible: true,
    dependency_count: 0,
    reality_anchor: `benchmark:${scenario.id}`,
    within_authorized_scope: true,
    external_side_effect: scenario.id === "S15",
  }
}

export function b5SeedPolicy(scenario: B5BenchmarkScenario): SeedPolicyFactsValue {
  return SeedPolicyFacts.parse({
    risk_level: scenario.id === "S15" ? "high" : scenario.id === "S14" ? "low" : "medium",
    scope_defined: true,
    reversible: true,
    stable_sop: scenario.id === "S14",
    unfamiliar_workspace: scenario.id === "S13",
    cross_module: scenario.id === "S13",
    external_side_effect: scenario.id === "S15",
    blocking_unknowns: [],
    slice_candidates: [firstSlice(scenario)],
  })
}

export type B5ScenarioRuntime = {
  execution: CompanyProjectExecutionInterface
  projects: CompanyProjectInterface
  recruitment: CompanyRecruitmentInterface
  validation: CompanyValidationGateInterface
  attention: CompanyAttentionInterface
  dispatch: DispatchCoordinatorInterface
  quiescence: QuiescenceServiceInterface
}

export type B5ScenarioRunInput = {
  snapshot: B5ScenarioSnapshot
  strategy: B5Strategy
  runId: string
  providerId?: string
  modelId?: string
}

const legacyBaseline = Effect.fn("B5CandidateScenarios.legacyBaseline")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  const started = yield* runtime.execution.start({
    goal: `Execute benchmark ${input.snapshot.scenario.id} using persisted local facts only`,
    title: `B5 ${input.snapshot.scenario.id} legacy baseline`,
    execution_strategy: "legacy_full_plan",
    seed_policy: b5SeedPolicy(input.snapshot.scenario),
    ...(input.providerId && input.modelId
      ? { provider_id: input.providerId, model_id: input.modelId }
      : {}),
  })
  const items = yield* runtime.projects.listWorkItems(started.project.id)
  const assignments = yield* runtime.recruitment.listAssignments({ project_id: started.project.id })
  return B5ScenarioRunResult.parse({
    binding: {
      projectId: started.project.id,
      scenarioId: input.snapshot.scenario.id,
      runId: started.run_id,
      strategy: input.strategy,
      snapshotDigest: input.snapshot.snapshotDigest,
    },
    projectStatus: started.project.status,
    terminalDecision: "in_progress",
    sourceRefs: [
      { kind: "project", id: started.project.id },
      ...items.map((item) => ({ kind: "work_item" as const, id: item.id })),
      ...assignments.map((assignment) => ({
        kind: "project_assignment" as const,
        id: assignment.id,
      })),
      { kind: "agent_run", id: started.run_id },
    ],
    oracle: {
      kind: "legacy_baseline",
      initialWorkItemIds: items.map((item) => item.id),
      initialAssignmentIds: assignments.map((assignment) => assignment.id),
    },
  })
})

const runS13 = Effect.fn("B5CandidateScenarios.S13")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  const policy = b5SeedPolicy(input.snapshot.scenario)
  const verdict = evaluateSeedPolicy(policy)
  if (verdict.mode !== "seed_pair") throw new Error("S13 must evaluate through the real seed_pair policy")
  const started = yield* runtime.execution.start({
    goal: "Inspect an unfamiliar multi-module repository and implement only the first verifiable slice",
    title: "B5 S13 unfamiliar repository",
    execution_strategy: "seed_and_grow",
    seed_policy: policy,
    ...(input.providerId && input.modelId
      ? { provider_id: input.providerId, model_id: input.modelId }
      : {}),
  })
  const items = yield* runtime.projects.listWorkItems(started.project.id)
  const assignments = yield* runtime.recruitment.listAssignments({ project_id: started.project.id })
  const wayfinder = items.find((item) => item.purpose === "discovery")
  const builder = items.find((item) => item.purpose === "first_slice")
  if (!wayfinder || !builder || items.length !== 2)
    throw new Error("S13 seed_pair did not persist the exact bounded initial graph")
  const pair = [wayfinder, builder].map((item) =>
    assignments.find((assignment) => assignment.work_item_id === item.id),
  )
  if (!pair[0] || !pair[1] || pair[0].agent_id === pair[1].agent_id || assignments.length !== 2)
    throw new Error("S13 seed_pair did not persist two independent initial Assignments")
  return B5ScenarioRunResult.parse({
    binding: {
      projectId: started.project.id,
      scenarioId: "S13",
      runId: started.run_id,
      strategy: input.strategy,
      snapshotDigest: input.snapshot.snapshotDigest,
    },
    projectStatus: started.project.status,
    terminalDecision: "in_progress",
    sourceRefs: [
      { kind: "project", id: started.project.id },
      { kind: "work_item", id: wayfinder.id },
      { kind: "work_item", id: builder.id },
      { kind: "project_assignment", id: pair[0].id },
      { kind: "project_assignment", id: pair[1].id },
      { kind: "agent_run", id: started.run_id },
    ],
    oracle: {
      kind: "s13_seed_pair",
      seedMode: verdict.mode,
      wayfinderWorkItemId: wayfinder.id,
      builderWorkItemId: builder.id,
      assignmentIds: [pair[0].id, pair[1].id],
      agentIds: [pair[0].agent_id, pair[1].agent_id],
      initialGraphNodeCount: 2,
    },
  })
})

const runS15 = Effect.fn("B5CandidateScenarios.S15")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  const policy = b5SeedPolicy(input.snapshot.scenario)
  const verdict = evaluateSeedPolicy(policy)
  if (verdict.mode !== "discovery_first")
    throw new Error("S15 must evaluate through the real discovery_first policy")
  const started = yield* runtime.execution.start({
    goal: "Inspect a requested external write without executing any external side effect",
    title: "B5 S15 approval-gated external action",
    execution_strategy: "seed_and_grow",
    seed_policy: policy,
    ...(input.providerId && input.modelId
      ? { provider_id: input.providerId, model_id: input.modelId }
      : {}),
  })
  const gate = (yield* runtime.projects.listGates(started.project.id)).find(
    (candidate) => candidate.kind === "risk_approval" && candidate.status === "pending",
  )
  const builder = (yield* runtime.projects.listWorkItems(started.project.id)).find(
    (item) => item.purpose === "first_slice",
  )
  if (!gate || !builder || builder.status !== "pending" || builder.owner_agent_id)
    throw new Error("S15 did not stop the unauthorized Builder at a pending ApprovalGate")
  const barrier = yield* runtime.dispatch.pauseDispatch(
    started.project.id,
    "B5 S15 pending external-side-effect approval",
  )
  const project =
    started.project.status === "executing"
      ? yield* runtime.projects.transition({
          id: started.project.id,
          status: "awaiting_approval",
          reason: "B5 S15 requires explicit external-side-effect approval",
        })
      : started.project
  const externalEffectEventIds = (yield* runtime.projects.listEvents(started.project.id))
    .filter((event) => event.type === "external_effect.executed")
    .map((event) => event.id)
  if (!barrier.barrier_event_id || externalEffectEventIds.length)
    throw new Error("S15 dispatch barrier or side-effect invariant failed")
  return B5ScenarioRunResult.parse({
    binding: {
      projectId: project.id,
      scenarioId: "S15",
      runId: started.run_id,
      strategy: input.strategy,
      snapshotDigest: input.snapshot.snapshotDigest,
    },
    projectStatus: project.status,
    terminalDecision: "correctly_stopped",
    sourceRefs: [
      { kind: "project", id: project.id },
      { kind: "work_item", id: builder.id },
      { kind: "approval_gate", id: gate.id },
      { kind: "project_event", id: barrier.barrier_event_id },
      { kind: "agent_run", id: started.run_id },
    ],
    oracle: {
      kind: "s15_approval_stop",
      seedMode: verdict.mode,
      approvalGateId: gate.id,
      builderWorkItemId: builder.id,
      dispatchEventId: barrier.barrier_event_id,
      builderDispatched: false,
      externalEffectEventIds,
    },
  })
})

const createManualSeedProject = Effect.fn("B5CandidateScenarios.createManualSeedProject")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  const project = yield* runtime.projects.create({
    goal: `Execute ${input.snapshot.scenario.id} against persisted domain services`,
    title: `B5 ${input.snapshot.scenario.id} seed scenario`,
    execution_strategy: "seed_and_grow",
    seed_mode: "direct_single",
  })
  yield* runtime.projects.transition({ id: project.id, status: "planning" })
  yield* runtime.projects.createCharter({
    project_id: project.id,
    scope: [`artifacts/b5/${input.snapshot.scenario.id.toLowerCase()}`],
    success_criteria: input.snapshot.scenario.acceptanceCriteria.map((criterion) => criterion.statement),
    acceptance_criteria: input.snapshot.scenario.acceptanceCriteria.map((criterion) => criterion.statement),
  })
  const plan = yield* runtime.projects.createPlan({
    project_id: project.id,
    phase: "execution",
    summary: `Persist ${input.snapshot.scenario.id} scenario facts`,
    acceptance_criteria: input.snapshot.scenario.acceptanceCriteria.map((criterion) => criterion.statement),
  })
  const item = yield* runtime.projects.createWorkItem({
    project_id: project.id,
    plan_id: plan.id,
    title: input.snapshot.scenario.title,
    description: input.snapshot.scenario.inputs.join("\n"),
    kind: "worker",
    work_type: "analysis",
    role: `${input.snapshot.scenario.id.toLowerCase()} fact operator`,
    capability_packs: ["research-analysis@1"],
    decision_scope: ["scenario evidence"],
    resource_scope: [`artifacts/b5/${input.snapshot.scenario.id.toLowerCase()}`],
    expected_outputs: input.snapshot.scenario.expectedOutputs,
    validators: input.snapshot.scenario.acceptanceCriteria.map((criterion) => criterion.statement),
    model_group: "standard",
    risk_level: "medium",
    review_status: "not_required",
    purpose: "delivery",
    origin_kind: "seed",
    validation_mode: "machine",
    acceptance_criteria: input.snapshot.scenario.acceptanceCriteria.map((criterion) => criterion.statement),
    max_attempts: 3,
  })
  yield* runtime.projects.transition({ id: project.id, status: "executing" })
  return { project, item }
})

const runS22 = Effect.fn("B5CandidateScenarios.S22")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  const seeded = yield* createManualSeedProject(input, runtime)
  yield* runtime.projects.startWorkItem(seeded.item.id)
  const artifact = yield* runtime.projects.addArtifact({
    project_id: seeded.project.id,
    work_item_id: seeded.item.id,
    kind: "policy_probe",
    title: "S22 persistent invariant evidence",
    content: JSON.stringify({ invariant: false }),
  })
  const gate = yield* runtime.validation.create({
    project_id: seeded.project.id,
    work_item_id: seeded.item.id,
    kind: "policy",
    criteria: [
      {
        id: "s22-invariant-holds",
        statement: "The deterministic invariant holds",
        anchor: { kind: "policy", reference: "policy:b5-s22-persistent-invariant" },
        operator: "equals",
        expected: true,
      },
    ],
    blocking_work_item_ids: [seeded.item.id],
    evaluator: "policy_invariant_v1",
    max_repair_rounds: 3,
  })
  yield* runtime.validation.evaluate({
    gate_id: gate.id,
    evaluator: "policy_invariant_v1",
    evidence: [
      {
        criterion_id: "s22-invariant-holds",
        anchor: "policy",
        reference: "policy:b5-s22-persistent-invariant",
        observed: false,
        evidence_ref: { kind: "artifact", id: artifact.id },
      },
    ],
  })
  const runRound = Effect.fn("B5CandidateScenarios.S22Round")(function* (round: 1 | 2 | 3) {
    if (round > 1) {
      yield* runtime.projects.retryWorkItem(seeded.item.id)
      yield* runtime.projects.startWorkItem(seeded.item.id)
    }
    yield* runtime.projects.blockWorkItem({
      id: seeded.item.id,
      error: `S22 deterministic invariant failed at round ${round}`,
    })
    return yield* runtime.validation.repair({
      gate_id: gate.id,
      idempotency_key: `b5-s22-repair-${input.runId}-${round}`,
      diagnosis: {
        kind: "implementation",
        finding: `The deterministic invariant remains false at round ${round}`,
        affected_work_item_ids: [seeded.item.id],
        suggested_fix: `Apply bounded repair ${round}`,
        evidence_refs: [{ kind: "artifact", id: artifact.id }],
      },
      fix_summary: `Applied bounded repair ${round}`,
      repair_diff: [`b5-s22-fix-${round}`],
      evaluator: "policy_invariant_v1",
      evidence: [
        {
          criterion_id: "s22-invariant-holds",
          anchor: "policy",
          reference: "policy:b5-s22-persistent-invariant",
          observed: false,
          evidence_ref: { kind: "artifact", id: artifact.id },
        },
      ],
    })
  })
  const rounds = [
    yield* runRound(1),
    yield* runRound(2),
    yield* runRound(3),
  ]
  if (
    rounds[0].status !== "retry_allowed" ||
    rounds[1].status !== "retry_allowed" ||
    rounds[2].status !== "circuit_open"
  )
    throw new Error("S22 did not open the real ValidationGate circuit on round three")
  const fourth = yield* runtime.validation.repair({
    gate_id: gate.id,
    idempotency_key: `b5-s22-repair-${input.runId}-4`,
    diagnosis: {
      kind: "implementation",
      finding: "The circuit is already open",
      affected_work_item_ids: [seeded.item.id],
      suggested_fix: "Stop automatic execution",
      evidence_refs: [{ kind: "artifact", id: artifact.id }],
    },
    fix_summary: "No fourth repair was executed",
    repair_diff: ["none"],
    evaluator: "policy_invariant_v1",
    evidence: [
      {
        criterion_id: "s22-invariant-holds",
        anchor: "policy",
        reference: "policy:b5-s22-persistent-invariant",
        observed: false,
        evidence_ref: { kind: "artifact", id: artifact.id },
      },
    ],
  })
  if (!fourth.replayed || fourth.round !== 3 || fourth.status !== "circuit_open")
    throw new Error("S22 scheduled a fourth automatic repair")
  const attention = yield* runtime.attention.create({
    project_id: seeded.project.id,
    idempotency_key: `b5-s22-circuit-${gate.id}`,
    issue: {
      issue_kind: "unresolved_material_risk",
      risk: "high",
      materiality: "unresolved_risk",
    },
    title: "S22 repair circuit opened",
    summary: "Three deterministic repair rounds failed and automatic execution stopped",
    required_decision: "Resolve the failed criterion or supersede the approved scope",
    source_refs: [
      { kind: "validation_gate", id: gate.id },
      { kind: "work_item", id: seeded.item.id },
    ],
  })
  const attempts = yield* runtime.projects.listWorkAttempts(seeded.project.id)
  const attentions = (yield* runtime.attention.list({ project_id: seeded.project.id })).filter((candidate) =>
    candidate.source_refs.some((reference) => reference.kind === "validation_gate" && reference.id === gate.id),
  )
  if (attempts.length !== 3 || attentions.length !== 1)
    throw new Error("S22 requires exactly three persisted attempts and one bound Attention")
  const project = yield* runtime.projects.get(seeded.project.id)
  if (!project || project.status === "completed") throw new Error("S22 cannot fabricate project completion")
  return B5ScenarioRunResult.parse({
    binding: {
      projectId: project.id,
      scenarioId: "S22",
      runId: input.runId,
      strategy: input.strategy,
      snapshotDigest: input.snapshot.snapshotDigest,
    },
    projectStatus: project.status,
    terminalDecision: "correctly_stopped",
    sourceRefs: [
      { kind: "project", id: project.id },
      { kind: "work_item", id: seeded.item.id },
      { kind: "validation_gate", id: gate.id },
      { kind: "attention", id: attention.record.id },
      ...attempts.map((attempt) => ({ kind: "work_attempt" as const, id: attempt.id })),
    ],
    oracle: {
      kind: "s22_repair_circuit",
      workItemId: seeded.item.id,
      validationGateId: gate.id,
      attentionId: attention.record.id,
      attemptIds: [attempts[0]!.id, attempts[1]!.id, attempts[2]!.id],
      repairRounds: [1, 2, 3],
      fourthAttemptScheduled: false,
      fourthRepairReplayed: true,
    },
  })
})

const runS24 = Effect.fn("B5CandidateScenarios.S24")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  const seeded = yield* createManualSeedProject(input, runtime)
  yield* runtime.projects.startWorkItem(seeded.item.id)
  const artifact = yield* runtime.projects.addArtifact({
    project_id: seeded.project.id,
    work_item_id: seeded.item.id,
    kind: "pending_fact_probe",
    title: "S24 pending Receipt evidence",
    content: JSON.stringify({ completedWork: true, processedReceipt: false }),
  })
  yield* runtime.projects.completeWorkItemWithReceipt({
    id: seeded.item.id,
    receipt: {
      idempotency_key: `b5-s24-receipt-${input.runId}`,
      outcome: "completed",
      summary: "Work completed while its Seed Receipt remains pending",
      artifact_ids: [artifact.id],
      evidence_refs: [{ kind: "artifact", id: artifact.id }],
      confirmed_facts: ["work_completed=true"],
      invalidated_assumptions: [],
      unknowns: [],
      blockers: [],
      capability_gaps: [],
      task_proposals: [],
      dependency_proposals: [],
      questions: [],
    },
  })
  const receipt = (yield* runtime.projects.listWorkReceipts(seeded.project.id)).find(
    (candidate) => candidate.work_item_id === seeded.item.id,
  )
  if (!receipt || receipt.processing_status !== "pending")
    throw new Error("S24 requires a real pending Seed Receipt")
  const result = yield* runtime.quiescence.check(seeded.project.id)
  const artifacts = yield* runtime.projects.listArtifacts(seeded.project.id)
  const deliveryArtifactIds = artifacts
    .filter((candidate) => candidate.kind === "delivery_package")
    .map((candidate) => candidate.id)
  const project = yield* runtime.projects.get(seeded.project.id)
  if (
    !project ||
    project.status === "completed" ||
    result.status !== "blocked" ||
    !result.blocker_codes.includes("unprocessed_receipts") ||
    deliveryArtifactIds.length
  )
    throw new Error("S24 did not reject false completion from persisted pending facts")
  return B5ScenarioRunResult.parse({
    binding: {
      projectId: project.id,
      scenarioId: "S24",
      runId: input.runId,
      strategy: input.strategy,
      snapshotDigest: input.snapshot.snapshotDigest,
    },
    projectStatus: project.status,
    terminalDecision: "correctly_blocked",
    sourceRefs: [
      { kind: "project", id: project.id },
      { kind: "work_item", id: seeded.item.id },
      { kind: "work_receipt", id: receipt.id },
      { kind: "artifact", id: artifact.id },
    ],
    oracle: {
      kind: "s24_quiescence_blocked",
      workItemId: seeded.item.id,
      receiptId: receipt.id,
      blockerCodes: result.blocker_codes,
      deliveryArtifactIds,
    },
  })
})

export const runB5Scenario = Effect.fn("B5CandidateScenarios.run")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  B5ScenarioSnapshot.parse(input.snapshot)
  B5Strategy.parse(input.strategy)
  if (input.strategy === "legacy_full_plan") return yield* legacyBaseline(input, runtime)
  if (input.snapshot.scenario.id === "S13") return yield* runS13(input, runtime)
  if (input.snapshot.scenario.id === "S15") return yield* runS15(input, runtime)
  if (input.snapshot.scenario.id === "S22") return yield* runS22(input, runtime)
  if (input.snapshot.scenario.id === "S24") return yield* runS24(input, runtime)
  throw new Error(`B5 scenario ${input.snapshot.scenario.id} driver is not implemented`)
})
