import { createHash } from "node:crypto"
import path from "node:path"
import { Effect } from "effect"
import z from "zod"
import type { Interface as AgentRunInterface } from "@/agent-run/agent-run"
import type {
  Info as CompanyAgentInfo,
  Interface as CompanyAgentInterface,
} from "@/company-agent/company-agent"
import type { Interface as CompanyGraphMutationInterface } from "@/company-project/graph-mutation"
import type { Interface as CompanyProjectInterface } from "@/company-project/company-project"
import type { Interface as CompanyProjectExecutionInterface } from "@/company-project/execution"
import type { Interface as CompanyAttentionInterface } from "@/company-project/attention"
import type { Interface as CompanyValidationGateInterface } from "@/company-project/validation-gate"
import {
  GraphMutationProposal,
  NewGraphWorkItem,
} from "@/company-project/schema"
import { validationPolicy } from "@/company-project/validation-policy"
import type { Interface as CompanyRecruitmentInterface } from "@/company-recruitment/company-recruitment"
import { CompanyID } from "@/company/schema"
import type { Interface as CapabilityMaterializerInterface } from "@/project-orchestrator/capability-materializer"
import type { Interface as DispatchCoordinatorInterface } from "@/project-orchestrator/dispatch"
import type { Interface as GraphSupervisorInterface } from "@/project-orchestrator/graph-supervisor"
import type { Interface as QuiescenceServiceInterface } from "@/project-orchestrator/quiescence"
import { evaluateSeedPolicy } from "@/project-orchestrator/seed-policy"
import { SeedPolicyFacts, type SeedPolicyFactsValue } from "@/project-orchestrator/schema"
import { produceB5CandidateRecovery } from "./b5-candidate-recovery"

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

const S14Oracle = z
  .object({
    kind: z.literal("s14_direct_single"),
    seedMode: z.literal("direct_single"),
    workItemId: z.string().trim().min(1),
    assignmentId: z.string().trim().min(1),
    reviewerWorkItemIds: z.tuple([]),
  })
  .strict()

const S16Oracle = z
  .object({
    kind: z.literal("s16_prerequisite_repair"),
    sourceWorkItemId: z.string().trim().min(1),
    downstreamWorkItemId: z.string().trim().min(1),
    recoveryWorkItemId: z.string().trim().min(1),
    receiptId: z.string().trim().min(1),
    validationGateId: z.string().trim().min(1),
    mutationId: z.string().trim().min(1),
    criteriaSha256: Digest,
    initialStatus: z.literal("failed"),
    repairedStatus: z.literal("passed"),
  })
  .strict()

const S17Oracle = z
  .object({
    kind: z.literal("s17_capability_growth"),
    receiptId: z.string().trim().min(1),
    decisionId: z.string().trim().min(1),
    mutationId: z.string().trim().min(1),
    capabilityNeedId: z.string().trim().min(1),
    assignmentIds: z.tuple([
      z.string().trim().min(1),
      z.string().trim().min(1),
      z.string().trim().min(1),
    ]),
    agentIds: z.tuple([
      z.string().trim().min(1),
      z.string().trim().min(1),
      z.string().trim().min(1),
    ]),
    replayedMaterialization: z.literal(true),
  })
  .strict()

const S18Oracle = z
  .object({
    kind: z.literal("s18_risk_reviewer"),
    workerWorkItemId: z.string().trim().min(1),
    reviewerWorkItemId: z.string().trim().min(1),
    workerAssignmentId: z.string().trim().min(1),
    reviewerAssignmentId: z.string().trim().min(1),
    reviewerAgentRunId: z.string().trim().min(1),
    validationGateId: z.string().trim().min(1),
    mutationId: z.string().trim().min(1),
    independent: z.literal(true),
    rejected: z.boolean(),
  })
  .strict()

const S21Oracle = z
  .object({
    kind: z.literal("s21_revision_conflict"),
    receiptIds: z.tuple([z.string().trim().min(1), z.string().trim().min(1)]),
    decisionIds: z.array(z.string().trim().min(1)).min(2),
    supersededDecisionIds: z.array(z.string().trim().min(1)).min(1),
    conflictCount: z.number().int().min(1),
  })
  .strict()

const S23Oracle = z
  .object({
    kind: z.literal("s23_supersede_replace"),
    receiptId: z.string().trim().min(1),
    mutationId: z.string().trim().min(1),
    supersededWorkItemId: z.string().trim().min(1),
    replacementWorkItemId: z.string().trim().min(1),
    supersedeEventId: z.string().trim().min(1),
    historyRetained: z.literal(true),
  })
  .strict()

const S25Oracle = z
  .object({
    kind: z.literal("s25_assignment_release"),
    agentId: z.string().trim().min(1),
    selectionId: z.string().trim().min(1),
    assignmentId: z.string().trim().min(1),
    identityBeforeSha256: Digest,
    identityAfterSha256: Digest,
    released: z.literal(true),
  })
  .strict()

const S26Oracle = z
  .object({
    kind: z.literal("s26_company_pool_reuse"),
    firstProjectId: z.string().trim().min(1),
    secondProjectId: z.string().trim().min(1),
    firstNeedId: z.string().trim().min(1),
    secondNeedId: z.string().trim().min(1),
    firstAssignmentId: z.string().trim().min(1),
    secondAssignmentId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    candidateCountBeforeSecond: z.number().int().nonnegative(),
    candidateCountAfterSecond: z.number().int().nonnegative(),
    secondSelectionSource: z.literal("company_pool"),
  })
  .strict()

const RecoveryOracle = z
  .object({
    kind: z.literal("b5_process_recovery"),
    scenarioId: z.enum(["S19", "S20", "S27"]),
    receiptIds: z.array(z.string().trim().min(1)),
    mutationIds: z.array(z.string().trim().min(1)),
    lostAt: z.number().int().nonnegative(),
    recoveredAt: z.number().int().nonnegative(),
    crashedPids: z.array(z.number().int().positive()).min(1),
    recoveryPids: z.array(z.number().int().positive()).min(1),
    duplicateSideEffects: z.literal(0),
    exactlyOnce: z.literal(true),
    reportSha256: Digest,
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
    oracle: z.discriminatedUnion("kind", [
      LegacyOracle,
      S13Oracle,
      S14Oracle,
      S15Oracle,
      S16Oracle,
      S17Oracle,
      S18Oracle,
      S21Oracle,
      S22Oracle,
      S23Oracle,
      S24Oracle,
      S25Oracle,
      S26Oracle,
      RecoveryOracle,
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path: ["oracle", ...path], message })
    if (value.oracle.kind === "s13_seed_pair") {
      if (new Set(value.oracle.assignmentIds).size !== value.oracle.assignmentIds.length)
        issue(["assignmentIds"], "S13 assignments must be unique")
      if (new Set(value.oracle.agentIds).size !== value.oracle.agentIds.length)
        issue(["agentIds"], "S13 agents must be independent")
    }
    if (value.oracle.kind === "s17_capability_growth") {
      if (new Set(value.oracle.assignmentIds).size !== value.oracle.assignmentIds.length)
        issue(["assignmentIds"], "S17 assignments must be unique")
      if (new Set(value.oracle.agentIds).size !== value.oracle.agentIds.length)
        issue(["agentIds"], "S17 agents must be independent")
    }
    if (
      value.oracle.kind === "s18_risk_reviewer" &&
      value.oracle.workerWorkItemId === value.oracle.reviewerWorkItemId
    )
      issue(["reviewerWorkItemId"], "S18 Reviewer must use an independent WorkItem")
    if (
      value.oracle.kind === "s18_risk_reviewer" &&
      value.oracle.workerAssignmentId === value.oracle.reviewerAssignmentId
    )
      issue(["reviewerAssignmentId"], "S18 Reviewer must use an independent Assignment")
    if (value.oracle.kind === "s21_revision_conflict") {
      const oracle = value.oracle
      if (new Set(oracle.receiptIds).size !== oracle.receiptIds.length)
        issue(["receiptIds"], "S21 receipts must be unique")
      if (new Set(oracle.decisionIds).size !== oracle.decisionIds.length)
        issue(["decisionIds"], "S21 decisions must be unique")
      if (
        new Set(oracle.supersededDecisionIds).size !==
        oracle.supersededDecisionIds.length
      )
        issue(["supersededDecisionIds"], "S21 superseded decisions must be unique")
      if (
        oracle.supersededDecisionIds.some(
          (id) => !oracle.decisionIds.includes(id),
        )
      )
        issue(["supersededDecisionIds"], "S21 superseded decisions must belong to the decision set")
    }
    if (
      value.oracle.kind === "s22_repair_circuit" &&
      new Set(value.oracle.attemptIds).size !== value.oracle.attemptIds.length
    )
      issue(["attemptIds"], "S22 repair attempts must be unique")
    if (
      value.oracle.kind === "s23_supersede_replace" &&
      value.oracle.supersededWorkItemId === value.oracle.replacementWorkItemId
    )
      issue(["replacementWorkItemId"], "S23 replacement must differ from the superseded WorkItem")
    if (
      value.oracle.kind === "s25_assignment_release" &&
      value.oracle.identityBeforeSha256 !== value.oracle.identityAfterSha256
    )
      issue(["identityAfterSha256"], "S25 assignment release changed Agent identity")
    if (
      value.oracle.kind === "s26_company_pool_reuse" &&
      value.oracle.candidateCountAfterSecond !== value.oracle.candidateCountBeforeSecond
    )
      issue(["candidateCountAfterSecond"], "S26 company-pool reuse changed the candidate count")
    if (value.oracle.kind === "b5_process_recovery") {
      const oracle = value.oracle
      if (oracle.recoveredAt < oracle.lostAt)
        issue(["recoveredAt"], "Recovery completed before the observed loss")
      if (
        oracle.crashedPids.some((pid) => oracle.recoveryPids.includes(pid))
      )
        issue(["recoveryPids"], "Recovery must run in a process distinct from every crashed process")
    }
  })
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
  agentRuns: AgentRunInterface
  agents: CompanyAgentInterface
  execution: CompanyProjectExecutionInterface
  projects: CompanyProjectInterface
  recruitment: CompanyRecruitmentInterface
  graph: CompanyGraphMutationInterface
  supervisor: GraphSupervisorInterface
  shadowSupervisor: GraphSupervisorInterface
  concurrentSupervisor: GraphSupervisorInterface
  capabilityMaterializer: CapabilityMaterializerInterface
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
  candidateSha?: string
  databasePath?: string
  runtimeHomePath?: string
  worktreePath?: string
  recoveryOutputDirectory?: string
}

function stableEntityId(prefix: string, value: string) {
  return `${prefix}_${digest(value).slice(0, 26)}`
}

export const runB5LocalProbe = Effect.fn("B5CandidateScenarios.localProbe")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
  projectId: string,
  workItemId: string,
  agentId: string,
  runId = input.runId,
) {
  if (!input.candidateSha || !input.databasePath || !input.runtimeHomePath || !input.worktreePath)
    throw new Error("B5 local probe requires candidate, database, runtime-home, and worktree bindings")
  const controlPlanePath = path.join(input.worktreePath, "packages/control-plane")
  const run = yield* runtime.agentRuns.create({
    id: runId,
    agentID: agentId,
    runtime: "codex",
    runtimeVersion: Bun.version,
    workflowVersion: "b5-real-candidate-v1",
    lifecycle: "on_demand",
    permissionMode: "read_only",
    companyProjectID: projectId,
    workItemID: workItemId,
    cwd: controlPlanePath,
    runtimeHomePath: input.runtimeHomePath,
  })
  yield* runtime.agentRuns.transition({ id: run.id, state: "starting" })
  yield* runtime.agentRuns.transition({ id: run.id, state: "running" })
  const script = [
    `const { Database, eq } = await import("./src/storage/index.ts")`,
    `const { CompanyProjectTable } = await import("./src/company-project/company-project.sql.ts")`,
    `const project = Database.use((db) => db.select({ id: CompanyProjectTable.id, strategy: CompanyProjectTable.execution_strategy }).from(CompanyProjectTable).where(eq(CompanyProjectTable.id, ${JSON.stringify(projectId)})).get())`,
    `Database.close()`,
    `if (!project) process.exit(2)`,
    `process.stdout.write(new Bun.CryptoHasher("sha256").update(JSON.stringify({ candidateSha: ${JSON.stringify(input.candidateSha)}, project, workItemId: ${JSON.stringify(workItemId)} })).digest("hex"))`,
  ].join(";")
  const result = Bun.spawnSync(["bun", "-e", script], {
    cwd: controlPlanePath,
    env: {
      ...process.env,
      AGENTCOMPANY_DB: input.databasePath,
      AGENTCOMPANY_HOME: input.runtimeHomePath,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  yield* runtime.agentRuns.recordEvent({
    runID: run.id,
    type: "local_command.finished",
    payload: {
      exitCode: result.exitCode,
      stdoutSha256: digest(stdout),
      stderrSha256: digest(stderr),
    },
  })
  yield* runtime.agentRuns.recordUsage({ runID: run.id, source: "unavailable" })
  yield* runtime.agentRuns.transition({
    id: run.id,
    state: result.exitCode === 0 ? "completed" : "failed",
    exitCode: result.exitCode,
    safeErrorSummary: result.exitCode === 0 ? undefined : stderr.slice(0, 2_000),
  })
  if (result.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(stdout))
    throw new Error(`B5 local probe failed for ${projectId}/${workItemId}`)
  return {
    runId: run.id,
    commandId: "bun-local-project-binding-probe",
    stdoutSha256: digest(stdout),
    stderrSha256: digest(stderr),
  }
})

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

const runS14 = Effect.fn("B5CandidateScenarios.S14")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  const policy = b5SeedPolicy(input.snapshot.scenario)
  const verdict = evaluateSeedPolicy(policy)
  if (verdict.mode !== "direct_single")
    throw new Error("S14 must evaluate through the real direct_single policy")
  const started = yield* runtime.execution.start({
    goal: "Complete one low-risk reversible local task without an unnecessary review interruption",
    title: "B5 S14 direct low-risk task",
    execution_strategy: "seed_and_grow",
    seed_policy: policy,
    ...(input.providerId && input.modelId
      ? { provider_id: input.providerId, model_id: input.modelId }
      : {}),
  })
  const items = yield* runtime.projects.listWorkItems(started.project.id)
  const assignments = yield* runtime.recruitment.listAssignments({ project_id: started.project.id })
  const workItem = items.find((item) => item.purpose === "first_slice")
  const assignment = workItem
    ? assignments.find((candidate) => candidate.work_item_id === workItem.id)
    : undefined
  const reviewers = items.filter((item) => item.kind === "reviewer")
  if (!workItem || !assignment || items.length !== 1 || assignments.length !== 1 || reviewers.length)
    throw new Error("S14 direct_single created an unnecessary role or Reviewer")
  return B5ScenarioRunResult.parse({
    binding: {
      projectId: started.project.id,
      scenarioId: "S14",
      runId: started.run_id,
      strategy: input.strategy,
      snapshotDigest: input.snapshot.snapshotDigest,
    },
    projectStatus: started.project.status,
    terminalDecision: "in_progress",
    sourceRefs: [
      { kind: "project", id: started.project.id },
      { kind: "work_item", id: workItem.id },
      { kind: "project_assignment", id: assignment.id },
      { kind: "agent_run", id: started.run_id },
    ],
    oracle: {
      kind: "s14_direct_single",
      seedMode: verdict.mode,
      workItemId: workItem.id,
      assignmentId: assignment.id,
      reviewerWorkItemIds: reviewers.map((item) => item.id),
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

const runS16 = Effect.fn("B5CandidateScenarios.S16")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  const project = yield* runtime.projects.create({
    goal: "Repair a failed prerequisite without weakening its acceptance anchor",
    title: "B5 S16 prerequisite repair",
    execution_strategy: "seed_and_grow",
    seed_mode: "direct_single",
  })
  yield* runtime.projects.transition({ id: project.id, status: "planning" })
  const plan = yield* runtime.projects.createPlan({
    project_id: project.id,
    phase: "execution",
    summary: "Verify, repair, and reverify one prerequisite",
    acceptance_criteria: ["The unchanged prerequisite anchor passes"],
  })
  const source = yield* runtime.projects.createWorkItem({
    project_id: project.id,
    plan_id: plan.id,
    title: "Probe required local capability",
    description: "Persist the failed prerequisite observation",
    kind: "worker",
    work_type: "analysis",
    role: "prerequisite evaluator",
    capability_packs: ["research-analysis@1"],
    decision_scope: ["prerequisite evidence"],
    resource_scope: ["artifacts/b5/s16"],
    expected_outputs: ["Prerequisite probe"],
    validators: ["Required local capability exists"],
    model_group: "standard",
    risk_level: "medium",
    review_status: "not_required",
    purpose: "delivery",
    origin_kind: "seed",
    validation_mode: "machine",
    owner_agent_id: stableEntityId("agent", `${input.runId}:s16-source`),
    acceptance_criteria: ["Required local capability exists"],
    max_attempts: 3,
  })
  const downstream = yield* runtime.projects.createWorkItem({
    project_id: project.id,
    plan_id: plan.id,
    title: "Dependent delivery",
    description: "Remain blocked until the exact prerequisite is repaired",
    kind: "worker",
    work_type: "analysis",
    role: "dependent operator",
    capability_packs: ["research-analysis@1"],
    decision_scope: ["bounded delivery"],
    resource_scope: ["artifacts/b5/s16"],
    expected_outputs: ["Dependent evidence"],
    validators: ["Required local capability exists"],
    model_group: "standard",
    risk_level: "medium",
    review_status: "not_required",
    purpose: "delivery",
    origin_kind: "seed",
    validation_mode: "machine",
    owner_agent_id: stableEntityId("agent", `${input.runId}:s16-downstream`),
    acceptance_criteria: ["Required local capability exists"],
    max_attempts: 3,
    depends_on: [source.id],
  })
  yield* runtime.projects.transition({ id: project.id, status: "executing" })
  yield* runtime.projects.startWorkItem(source.id)
  const failedArtifact = yield* runtime.projects.addArtifact({
    project_id: project.id,
    work_item_id: source.id,
    kind: "prerequisite_probe",
    title: "S16 failed prerequisite",
    content: JSON.stringify({ exists: false }),
  })
  yield* runtime.projects.blockWorkItem({
    id: source.id,
    error: "Required local capability is absent",
  })
  const receipt = (yield* runtime.projects.listWorkReceipts(project.id)).find(
    (candidate) => candidate.work_item_id === source.id,
  )
  if (!receipt) throw new Error("S16 failed prerequisite produced no Work Receipt")
  const processedReceipt = yield* runtime.shadowSupervisor.processReceipt(receipt.id)
  if (
    processedReceipt.status !== "processed" ||
    processedReceipt.decision.kind !== "retry"
  )
    throw new Error("S16 failed prerequisite Receipt was not processed as a retry")
  const gate = yield* runtime.validation.create({
    project_id: project.id,
    work_item_id: source.id,
    kind: "prerequisite",
    criteria: [
      {
        id: "s16-runtime-capability-exists",
        statement: "Required local capability exists",
        anchor: { kind: "prerequisite", reference: "local-capability:b5-s16-required" },
        operator: "exists",
        expected: true,
      },
    ],
    blocking_work_item_ids: [downstream.id],
    evaluator: "fact_match_v1",
    max_repair_rounds: 3,
  })
  const failed = yield* runtime.validation.evaluate({
    gate_id: gate.id,
    evaluator: "fact_match_v1",
    evidence: [
      {
        criterion_id: "s16-runtime-capability-exists",
        anchor: "prerequisite",
        reference: "local-capability:b5-s16-required",
        observed: false,
        evidence_ref: { kind: "artifact", id: failedArtifact.id },
      },
    ],
  })
  if (failed.status !== "failed") throw new Error("S16 false prerequisite passed its ValidationGate")
  const recovery = NewGraphWorkItem.parse({
    id: stableEntityId("cwi", `${input.runId}:s16-recovery`),
    plan_id: plan.id,
    parent_id: source.id,
    title: "Restore required local capability",
    description: "Restore and verify the unchanged prerequisite",
    kind: "worker",
    work_type: "analysis",
    role: "environment repair",
    capability_packs: ["research-analysis@1"],
    decision_scope: ["prerequisite evidence"],
    resource_scope: ["artifacts/b5/s16"],
    inputs: ["Failed prerequisite Work Receipt"],
    expected_outputs: ["Passing prerequisite probe"],
    validators: ["Required local capability exists"],
    disposition: "retain",
    model_group: "standard",
    risk_level: "medium",
    review_status: "not_required",
    owner_agent_id: stableEntityId("agent", `${input.runId}:s16-recovery`),
    acceptance_criteria: ["Required local capability exists"],
    max_attempts: 3,
    purpose: "recovery",
    validation_mode: "machine",
  })
  const proposal = yield* runtime.validation.planPrerequisiteRepair({
    gate_id: gate.id,
    trigger_receipt_id: receipt.id,
    recovery_item: recovery,
    idempotency_key: `b5-s16-repair-${input.runId}`,
    orchestrator_version: 1,
  })
  const mutation = yield* runtime.graph.apply(proposal)
  if (mutation.status !== "applied")
    throw new Error(`S16 prerequisite repair mutation was not applied: ${mutation.status}`)
  yield* runtime.projects.startWorkItem(recovery.id)
  const repairedArtifact = yield* runtime.projects.addArtifact({
    project_id: project.id,
    work_item_id: recovery.id,
    kind: "prerequisite_probe",
    title: "S16 repaired prerequisite",
    content: JSON.stringify({ exists: true }),
  })
  yield* runtime.projects.completeWorkItem(recovery.id)
  const repaired = yield* runtime.validation.repair({
    gate_id: gate.id,
    idempotency_key: `b5-s16-reverify-${input.runId}`,
    diagnosis: {
      kind: "missing_prerequisite",
      finding: "The required local capability was absent",
      affected_work_item_ids: [downstream.id],
      suggested_fix: "Restore the capability and reverify the same anchor",
      evidence_refs: [{ kind: "artifact", id: failedArtifact.id }],
    },
    fix_summary: "Restored the required local capability",
    repair_diff: [`dependency:${downstream.id}:${source.id}->${recovery.id}`],
    evaluator: "fact_match_v1",
    evidence: [
      {
        criterion_id: "s16-runtime-capability-exists",
        anchor: "prerequisite",
        reference: "local-capability:b5-s16-required",
        observed: true,
        evidence_ref: { kind: "artifact", id: repairedArtifact.id },
      },
    ],
  })
  if (
    repaired.status !== "passed" ||
    repaired.gate.criteria_sha256 !== gate.criteria_sha256 ||
    !(yield* runtime.projects.readyWorkItems(project.id)).some((candidate) => candidate.id === downstream.id)
  )
    throw new Error("S16 did not reverify the unchanged prerequisite anchor")
  return B5ScenarioRunResult.parse({
    binding: {
      projectId: project.id,
      scenarioId: "S16",
      runId: input.runId,
      strategy: input.strategy,
      snapshotDigest: input.snapshot.snapshotDigest,
    },
    projectStatus: (yield* runtime.projects.get(project.id))!.status,
    terminalDecision: "in_progress",
    sourceRefs: [
      { kind: "project", id: project.id },
      { kind: "work_item", id: source.id },
      { kind: "work_item", id: downstream.id },
      { kind: "work_item", id: recovery.id },
      { kind: "work_receipt", id: receipt.id },
      { kind: "validation_gate", id: gate.id },
      { kind: "graph_mutation", id: mutation.mutation.id },
      { kind: "artifact", id: repairedArtifact.id },
    ],
    oracle: {
      kind: "s16_prerequisite_repair",
      sourceWorkItemId: source.id,
      downstreamWorkItemId: downstream.id,
      recoveryWorkItemId: recovery.id,
      receiptId: receipt.id,
      validationGateId: gate.id,
      mutationId: mutation.mutation.id,
      criteriaSha256: gate.criteria_sha256,
      initialStatus: failed.status,
      repairedStatus: repaired.status,
    },
  })
})

const runS17 = Effect.fn("B5CandidateScenarios.S17")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  const companyId = CompanyID.parse("cmp_local")
  const project = yield* runtime.projects.create({
    company_id: companyId,
    goal: "Grow the project graph only after a verified capability gap",
    title: "B5 S17 capability gap",
    execution_strategy: "seed_and_grow",
    seed_mode: "seed_pair",
  })
  yield* runtime.projects.transition({ id: project.id, status: "planning" })
  const plan = yield* runtime.projects.createPlan({
    project_id: project.id,
    phase: "execution",
    summary: "Persist two initial assignments, then materialize one capability gap",
    acceptance_criteria: ["Exactly one third independent Assignment is persisted"],
  })
  const initialItems = yield* Effect.forEach(
    ["wayfinder", "builder"] as const,
    (purpose) =>
      runtime.projects.createWorkItem({
        project_id: project.id,
        plan_id: plan.id,
        title: `S17 ${purpose}`,
        description: `Produce ${purpose} evidence before capability growth`,
        kind: "worker",
        work_type: "analysis",
        role: `${purpose} evidence analyst`,
        capability_packs: ["research-analysis@1"],
        decision_scope: ["capability evidence"],
        resource_scope: ["artifacts/b5/s17"],
        expected_outputs: [`${purpose} evidence`],
        validators: [`${purpose} evidence exists`],
        model_group: "standard",
        risk_level: "medium",
        review_status: "not_required",
        purpose: purpose === "wayfinder" ? "discovery" : "first_slice",
        origin_kind: "seed",
        validation_mode: "machine",
        acceptance_criteria: [`${purpose} evidence exists`],
        max_attempts: 3,
      }),
    { concurrency: 1 },
  )
  const initial = yield* Effect.forEach(
    initialItems,
    (item, index) =>
      Effect.gen(function* () {
        const excluded = (yield* runtime.recruitment.listAssignments({ project_id: project.id })).map(
          (assignment) => assignment.agent_id,
        )
        const need = yield* runtime.recruitment.createNeed({
          company_id: companyId,
          project_id: project.id,
          work_item_id: item.id,
          need_key: `b5-s17-initial-${index + 1}`,
          role: item.role,
          work_type: item.work_type,
          capability_packs: item.capability_packs,
          risk_level: "medium",
          demand_horizon: "project",
          allowed_permission_modes: ["read_only"],
          workspace_scopes: item.resource_scope,
          independent_from_agent_ids: excluded,
        })
        return yield* runtime.recruitment.selectAndAssign({
          capability_need_id: need.id,
          exclude_agent_ids: excluded,
          permission_mode: "read_only",
        })
      }),
    { concurrency: 1 },
  )
  yield* runtime.projects.transition({ id: project.id, status: "executing" })
  yield* runtime.projects.startWorkItem(initialItems[0]!.id)
  const artifact = yield* runtime.projects.addArtifact({
    project_id: project.id,
    work_item_id: initialItems[0]!.id,
    kind: "capability_gap_probe",
    title: "S17 verified capability gap",
    content: JSON.stringify({ capability: "independent evidence verification", missing: true }),
  })
  yield* runtime.projects.completeWorkItemWithReceipt({
    id: initialItems[0]!.id,
    receipt: {
      idempotency_key: `b5-s17-receipt-${input.runId}`,
      outcome: "completed",
      summary: "A missing independent verification capability was observed",
      artifact_ids: [artifact.id],
      evidence_refs: [{ kind: "artifact", id: artifact.id }],
      confirmed_facts: ["independent verification capability is missing"],
      invalidated_assumptions: [],
      unknowns: [],
      blockers: [],
      capability_gaps: ["independent evidence verification"],
      task_proposals: [],
      dependency_proposals: [],
      questions: [],
    },
  })
  const receipt = (yield* runtime.projects.listWorkReceipts(project.id)).find(
    (candidate) => candidate.work_item_id === initialItems[0]!.id,
  )
  if (!receipt) throw new Error("S17 capability gap produced no Work Receipt")
  const processed = yield* runtime.supervisor.processReceipt(receipt.id)
  if (processed.status !== "processed" || !processed.mutation_id)
    throw new Error("S17 capability gap was not applied by GraphSupervisor")
  const materialized = yield* runtime.capabilityMaterializer.materializeDecision(processed.decision)
  const replayed = yield* runtime.capabilityMaterializer.materializeDecision(processed.decision)
  const assignments = yield* runtime.recruitment.listAssignments({ project_id: project.id })
  if (
    materialized.capability_need_ids.length !== 1 ||
    materialized.assignment_ids.length !== 1 ||
    JSON.stringify(materialized) !== JSON.stringify(replayed) ||
    assignments.length !== 3 ||
    new Set(assignments.map((assignment) => assignment.agent_id)).size !== 3
  )
    throw new Error("S17 did not materialize exactly one independent third Assignment")
  return B5ScenarioRunResult.parse({
    binding: {
      projectId: project.id,
      scenarioId: "S17",
      runId: input.runId,
      strategy: input.strategy,
      snapshotDigest: input.snapshot.snapshotDigest,
    },
    projectStatus: (yield* runtime.projects.get(project.id))!.status,
    terminalDecision: "in_progress",
    sourceRefs: [
      { kind: "project", id: project.id },
      { kind: "work_receipt", id: receipt.id },
      { kind: "graph_mutation", id: processed.mutation_id },
      ...assignments.map((assignment) => ({
        kind: "project_assignment" as const,
        id: assignment.id,
      })),
    ],
    oracle: {
      kind: "s17_capability_growth",
      receiptId: receipt.id,
      decisionId: processed.decision.id,
      mutationId: processed.mutation_id,
      capabilityNeedId: materialized.capability_need_ids[0]!,
      assignmentIds: [assignments[0]!.id, assignments[1]!.id, assignments[2]!.id],
      agentIds: [
        initial[0]!.agent.id,
        initial[1]!.agent.id,
        assignments[2]!.agent_id,
      ],
      replayedMaterialization: true,
    },
  })
})

const runS18 = Effect.fn("B5CandidateScenarios.S18")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  const companyId = CompanyID.parse("cmp_local")
  const project = yield* runtime.projects.create({
    company_id: companyId,
    goal: "Add an independent Reviewer only when persisted risk facts require one",
    title: "B5 S18 risk-driven review",
    execution_strategy: "seed_and_grow",
    seed_mode: "direct_single",
  })
  yield* runtime.projects.transition({ id: project.id, status: "planning" })
  const plan = yield* runtime.projects.createPlan({
    project_id: project.id,
    phase: "execution",
    summary: "Complete high-risk evidence and dynamically add one independent Reviewer",
    acceptance_criteria: ["Independent review passes the unchanged validation anchor"],
  })
  const worker = yield* runtime.projects.createWorkItem({
    project_id: project.id,
    plan_id: plan.id,
    title: "Produce high-risk evidence",
    description: "Persist the evidence that triggers risk-driven independent review",
    kind: "worker",
    work_type: "analysis",
    role: "risk evidence operator",
    capability_packs: ["research-analysis@1"],
    decision_scope: ["risk evidence"],
    resource_scope: ["artifacts/b5/s18"],
    expected_outputs: ["High-risk evidence"],
    validators: ["Independent Reviewer accepts the evidence"],
    model_group: "standard",
    risk_level: "high",
    review_status: "pending",
    purpose: "delivery",
    origin_kind: "seed",
    validation_mode: "independent_review",
    acceptance_criteria: ["Independent Reviewer accepts the evidence"],
    max_attempts: 3,
  })
  const workerNeed = yield* runtime.recruitment.createNeed({
    company_id: companyId,
    project_id: project.id,
    work_item_id: worker.id,
    need_key: "b5-s18-worker",
    role: worker.role,
    work_type: worker.work_type,
    capability_packs: worker.capability_packs,
    risk_level: "high",
    demand_horizon: "project",
    allowed_permission_modes: ["workspace_write"],
    workspace_scopes: worker.resource_scope,
  })
  const staffedWorker = yield* runtime.recruitment.selectAndAssign({
    capability_need_id: workerNeed.id,
    permission_mode: "workspace_write",
  })
  yield* runtime.projects.transition({ id: project.id, status: "executing" })
  yield* runtime.projects.startWorkItem(worker.id)
  const workerArtifact = yield* runtime.projects.addArtifact({
    project_id: project.id,
    work_item_id: worker.id,
    kind: "risk_evidence",
    title: "S18 high-risk evidence",
    content: JSON.stringify({ deterministic: true, accepted: false }),
    created_by_agent_id: staffedWorker.agent.id,
  })
  yield* runtime.projects.completeWorkItemWithReceipt({
    id: worker.id,
    receipt: {
      idempotency_key: `b5-s18-worker-${input.runId}`,
      outcome: "completed",
      summary: "High-risk evidence is ready for independent review",
      artifact_ids: [workerArtifact.id],
      evidence_refs: [{ kind: "artifact", id: workerArtifact.id }],
      confirmed_facts: ["high-risk evidence persisted"],
      invalidated_assumptions: [],
      unknowns: [],
      blockers: [],
      capability_gaps: [],
      task_proposals: [],
      dependency_proposals: [],
      questions: [],
    },
  })
  const receipt = (yield* runtime.projects.listWorkReceipts(project.id)).find(
    (candidate) => candidate.work_item_id === worker.id,
  )
  if (!receipt) throw new Error("S18 worker produced no Work Receipt")
  const processedReceipt = yield* runtime.shadowSupervisor.processReceipt(receipt.id)
  if (
    processedReceipt.status !== "processed" ||
    processedReceipt.mode !== "shadow" ||
    processedReceipt.mutation_id
  )
    throw new Error("S18 worker Receipt did not reach the shadow decision boundary")
  const policy = validationPolicy({
    risk_level: "high",
    external_side_effect: false,
    deterministic_anchors: true,
  })
  if (!policy.reviewer_required || policy.user_gate_required)
    throw new Error("S18 risk policy did not require independent review")
  const reviewerId = stableEntityId("cwi", `${input.runId}:s18-reviewer`)
  const mutation = yield* runtime.graph.apply(
    GraphMutationProposal.parse({
      project_id: project.id,
      trigger_receipt_id: receipt.id,
      expected_revision: 0,
      orchestrator_version: 1,
      idempotency_key: `b5-s18-reviewer-${input.runId}`,
      decision: "expand",
      rationale: "Persisted high-risk facts require an independent Reviewer",
      evidence_refs: receipt.evidence_refs,
      operations: [
        {
          type: "add_work_item",
          item: NewGraphWorkItem.parse({
            id: reviewerId,
            plan_id: plan.id,
            parent_id: worker.id,
            title: "Independently review S18 evidence",
            description: "Read the worker artifact and evaluate the unchanged acceptance anchor",
            kind: "reviewer",
            work_type: "analysis",
            role: "independent risk reviewer",
            capability_packs: ["independent-review@1"],
            decision_scope: ["acceptance evidence"],
            resource_scope: ["artifacts/b5/s18"],
            inputs: [workerArtifact.id],
            expected_outputs: ["Independent review result"],
            validators: ["Reviewer is independent from the worker"],
            disposition: "retain",
            model_group: "standard",
            risk_level: "medium",
            review_status: "pending",
            acceptance_criteria: ["Worker evidence satisfies the unchanged criterion"],
            max_attempts: 3,
            purpose: "verification",
            validation_mode: "independent_review",
          }),
        },
      ],
    }),
  )
  if (mutation.status !== "applied") throw new Error("S18 Reviewer graph mutation was not applied")
  const reviewer = (yield* runtime.projects.listWorkItems(project.id)).find(
    (candidate) => candidate.id === reviewerId,
  )
  if (!reviewer) throw new Error("S18 Reviewer WorkItem is unavailable")
  const reviewerNeed = yield* runtime.recruitment.createNeed({
    company_id: companyId,
    project_id: project.id,
    work_item_id: reviewer.id,
    source_receipt_id: receipt.id,
    need_key: "b5-s18-reviewer",
    role: reviewer.role,
    work_type: reviewer.work_type,
    capability_packs: reviewer.capability_packs,
    risk_level: "medium",
    demand_horizon: "project",
    allowed_permission_modes: ["read_only"],
    workspace_scopes: reviewer.resource_scope,
    independent_from_agent_ids: [staffedWorker.agent.id],
  })
  const staffedReviewer = yield* runtime.recruitment.selectAndAssign({
    capability_need_id: reviewerNeed.id,
    exclude_agent_ids: [staffedWorker.agent.id],
    permission_mode: "read_only",
  })
  if (staffedReviewer.agent.id === staffedWorker.agent.id)
    throw new Error("S18 selected the worker as its own Reviewer")
  yield* runtime.projects.startWorkItem(reviewer.id)
  const probe = yield* runB5LocalProbe(
    input,
    runtime,
    project.id,
    reviewer.id,
    staffedReviewer.agent.id,
    `${input.runId}-reviewer`,
  )
  const reviewArtifact = yield* runtime.projects.addArtifact({
    project_id: project.id,
    work_item_id: reviewer.id,
    kind: "review_result",
    title: "S18 independent review",
    content: JSON.stringify({ accepted: true, workerArtifactId: workerArtifact.id }),
    evidence: { agentRunId: probe.runId, independent: true },
    created_by_agent_id: staffedReviewer.agent.id,
  })
  yield* runtime.projects.completeWorkItemWithReceipt({
    id: reviewer.id,
    receipt: {
      idempotency_key: `b5-s18-reviewer-${input.runId}`,
      outcome: "completed",
      summary: "Independent Reviewer accepted the unchanged evidence anchor",
      artifact_ids: [reviewArtifact.id],
      evidence_refs: [
        { kind: "agent_run", id: probe.runId },
        { kind: "artifact", id: reviewArtifact.id },
      ],
      confirmed_facts: ["reviewer independent=true", "criterion accepted=true"],
      invalidated_assumptions: [],
      unknowns: [],
      blockers: [],
      capability_gaps: [],
      task_proposals: [],
      dependency_proposals: [],
      questions: [],
    },
  })
  yield* runtime.projects.setWorkItemReview({ id: worker.id, review_status: "accepted" })
  const artifactSha = digest(workerArtifact.content ?? "")
  const gate = yield* runtime.validation.create({
    project_id: project.id,
    work_item_id: worker.id,
    kind: "artifact",
    criteria: [
      {
        id: "s18-artifact-accepted",
        statement: "The high-risk artifact matches the independently reviewed digest",
        anchor: { kind: "artifact", reference: `artifact:${workerArtifact.id}` },
        operator: "digest",
        expected: artifactSha,
      },
    ],
    blocking_work_item_ids: [worker.id],
    evaluator: "artifact_digest_v1",
    max_repair_rounds: 3,
  })
  const evaluated = yield* runtime.validation.evaluate({
    gate_id: gate.id,
    evaluator: "artifact_digest_v1",
    evidence: [
      {
        criterion_id: "s18-artifact-accepted",
        anchor: "artifact",
        reference: `artifact:${workerArtifact.id}`,
        observed: artifactSha,
        evidence_ref: { kind: "artifact", id: reviewArtifact.id },
      },
    ],
  })
  if (evaluated.status !== "passed")
    throw new Error("S18 independent review did not pass the unchanged ValidationGate")
  return B5ScenarioRunResult.parse({
    binding: {
      projectId: project.id,
      scenarioId: "S18",
      runId: input.runId,
      strategy: input.strategy,
      snapshotDigest: input.snapshot.snapshotDigest,
    },
    projectStatus: (yield* runtime.projects.get(project.id))!.status,
    terminalDecision: "in_progress",
    sourceRefs: [
      { kind: "project", id: project.id },
      { kind: "work_item", id: worker.id },
      { kind: "work_item", id: reviewer.id },
      { kind: "project_assignment", id: staffedWorker.assignment.id },
      { kind: "project_assignment", id: staffedReviewer.assignment.id },
      { kind: "agent_run", id: probe.runId },
      { kind: "validation_gate", id: gate.id },
      { kind: "graph_mutation", id: mutation.mutation.id },
    ],
    oracle: {
      kind: "s18_risk_reviewer",
      workerWorkItemId: worker.id,
      reviewerWorkItemId: reviewer.id,
      workerAssignmentId: staffedWorker.assignment.id,
      reviewerAssignmentId: staffedReviewer.assignment.id,
      reviewerAgentRunId: probe.runId,
      validationGateId: gate.id,
      mutationId: mutation.mutation.id,
      independent: true,
      rejected: false,
    },
  })
})

const runS21 = Effect.fn("B5CandidateScenarios.S21")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  if (runtime.supervisor === runtime.concurrentSupervisor)
    throw new Error("S21 requires two independently locked GraphSupervisor instances")
  const project = yield* runtime.projects.create({
    goal: "Recompute one stale graph decision after concurrent Receipt processing",
    title: "B5 S21 revision conflict",
    execution_strategy: "seed_and_grow",
    seed_mode: "direct_single",
  })
  yield* runtime.projects.transition({ id: project.id, status: "planning" })
  const plan = yield* runtime.projects.createPlan({
    project_id: project.id,
    phase: "execution",
    summary: "Process two independently evidenced graph-growth Receipts concurrently",
    acceptance_criteria: ["One stale decision is superseded and recomputed from a fresh revision"],
  })
  const sources = yield* Effect.forEach(
    [1, 2] as const,
    (ordinal) =>
      runtime.projects.createWorkItem({
        project_id: project.id,
        plan_id: plan.id,
        title: `S21 concurrent source ${ordinal}`,
        description: `Produce graph-growth Receipt ${ordinal}`,
        kind: "worker",
        work_type: "analysis",
        role: `concurrent evidence operator ${ordinal}`,
        capability_packs: ["research-analysis@1"],
        decision_scope: ["graph growth"],
        resource_scope: ["artifacts/b5/s21"],
        expected_outputs: [`Concurrent evidence ${ordinal}`],
        validators: [`Concurrent evidence ${ordinal} exists`],
        model_group: "standard",
        risk_level: "medium",
        review_status: "not_required",
        purpose: "delivery",
        origin_kind: "seed",
        validation_mode: "machine",
        owner_agent_id: stableEntityId("agent", `${input.runId}:s21:${ordinal}`),
        acceptance_criteria: [`Concurrent evidence ${ordinal} exists`],
        max_attempts: 3,
      }),
    { concurrency: 1 },
  )
  yield* runtime.projects.transition({ id: project.id, status: "executing" })
  yield* Effect.forEach(
    sources,
    (source, index) =>
      Effect.gen(function* () {
        yield* runtime.projects.startWorkItem(source.id)
        const artifact = yield* runtime.projects.addArtifact({
          project_id: project.id,
          work_item_id: source.id,
          kind: "concurrent_graph_probe",
          title: `S21 concurrent evidence ${index + 1}`,
          content: JSON.stringify({ ordinal: index + 1 }),
        })
        yield* runtime.projects.completeWorkItemWithReceipt({
          id: source.id,
          receipt: {
            idempotency_key: `b5-s21-receipt-${input.runId}-${index + 1}`,
            outcome: "completed",
            summary: `Concurrent Receipt ${index + 1} proposes one bounded graph node`,
            artifact_ids: [artifact.id],
            evidence_refs: [{ kind: "artifact", id: artifact.id }],
            confirmed_facts: [`concurrent source ${index + 1} completed`],
            invalidated_assumptions: [],
            unknowns: [],
            blockers: [],
            capability_gaps: [],
            task_proposals: [
              NewGraphWorkItem.parse({
                id: stableEntityId("cwi", `${input.runId}:s21:growth:${index + 1}`),
                plan_id: plan.id,
                parent_id: source.id,
                title: `S21 bounded growth ${index + 1}`,
                description: `Bounded graph node from concurrent Receipt ${index + 1}`,
                kind: "worker",
                work_type: "analysis",
                role: "bounded graph operator",
                capability_packs: ["research-analysis@1"],
                decision_scope: ["graph growth"],
                resource_scope: ["artifacts/b5/s21"],
                inputs: [artifact.id],
                expected_outputs: [`Growth evidence ${index + 1}`],
                validators: ["Growth remains bounded"],
                disposition: "retain",
                model_group: "standard",
                risk_level: "medium",
                review_status: "not_required",
                acceptance_criteria: ["Growth remains bounded"],
                max_attempts: 3,
                purpose: "delivery",
                validation_mode: "machine",
              }),
            ],
            dependency_proposals: [],
            questions: [],
          },
        })
      }),
    { concurrency: 1 },
  )
  const receipts = yield* runtime.projects.listWorkReceipts(project.id)
  if (receipts.length !== 2) throw new Error("S21 requires exactly two pending Receipts")
  const results = yield* Effect.all(
    [
      runtime.supervisor.processReceipt(receipts[0]!.id),
      runtime.concurrentSupervisor.processReceipt(receipts[1]!.id),
    ],
    { concurrency: 2 },
  )
  if (results.some((result) => result.status !== "processed"))
    throw new Error("S21 concurrent Receipt processing did not finish")
  const processed = results.filter((result) => result.status === "processed")
  const conflictCount = processed.reduce((total, result) => total + result.conflict_count, 0)
  const decisions = yield* runtime.supervisor.listDecisions(project.id)
  const superseded = decisions.filter((decision) => decision.status === "superseded")
  if (
    conflictCount < 1 ||
    superseded.length < 1 ||
    decisions.filter((decision) => decision.status === "applied").length !== 2
  )
    throw new Error("S21 did not persist a superseded stale decision and two applied recomputations")
  return B5ScenarioRunResult.parse({
    binding: {
      projectId: project.id,
      scenarioId: "S21",
      runId: input.runId,
      strategy: input.strategy,
      snapshotDigest: input.snapshot.snapshotDigest,
    },
    projectStatus: (yield* runtime.projects.get(project.id))!.status,
    terminalDecision: "in_progress",
    sourceRefs: [
      { kind: "project", id: project.id },
      { kind: "work_receipt", id: receipts[0]!.id },
      { kind: "work_receipt", id: receipts[1]!.id },
      ...processed.flatMap((result) =>
        result.mutation_id
          ? [{ kind: "graph_mutation" as const, id: result.mutation_id }]
          : [],
      ),
    ],
    oracle: {
      kind: "s21_revision_conflict",
      receiptIds: [receipts[0]!.id, receipts[1]!.id],
      decisionIds: decisions.map((decision) => decision.id),
      supersededDecisionIds: superseded.map((decision) => decision.id),
      conflictCount,
    },
  })
})

const runS23 = Effect.fn("B5CandidateScenarios.S23")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  const project = yield* runtime.projects.create({
    goal: "Supersede one invalidated WorkItem while retaining its immutable history",
    title: "B5 S23 supersede and replace",
    execution_strategy: "seed_and_grow",
    seed_mode: "direct_single",
  })
  yield* runtime.projects.transition({ id: project.id, status: "planning" })
  const plan = yield* runtime.projects.createPlan({
    project_id: project.id,
    phase: "execution",
    summary: "Persist an invalidation Receipt and replace only the affected WorkItem",
    acceptance_criteria: ["Original history remains queryable and replacement completes"],
  })
  const original = yield* runtime.projects.createWorkItem({
    project_id: project.id,
    plan_id: plan.id,
    title: "Original invalidated path",
    description: "Remain immutable after a Receipt invalidates this path",
    kind: "worker",
    work_type: "analysis",
    role: "original path operator",
    capability_packs: ["research-analysis@1"],
    decision_scope: ["bounded delivery"],
    resource_scope: ["artifacts/b5/s23"],
    expected_outputs: ["Original evidence"],
    validators: ["Path remains valid"],
    model_group: "standard",
    risk_level: "medium",
    review_status: "not_required",
    purpose: "delivery",
    origin_kind: "seed",
    validation_mode: "machine",
    owner_agent_id: stableEntityId("agent", `${input.runId}:s23-original`),
    acceptance_criteria: ["Path remains valid"],
    max_attempts: 3,
  })
  const source = yield* runtime.projects.createWorkItem({
    project_id: project.id,
    plan_id: plan.id,
    title: "Observe path invalidation",
    description: "Persist the fact that invalidates the original path",
    kind: "worker",
    work_type: "analysis",
    role: "invalidation observer",
    capability_packs: ["research-analysis@1"],
    decision_scope: ["invalidation evidence"],
    resource_scope: ["artifacts/b5/s23"],
    expected_outputs: ["Invalidation evidence"],
    validators: ["Invalidation fact is persisted"],
    model_group: "standard",
    risk_level: "medium",
    review_status: "not_required",
    purpose: "discovery",
    origin_kind: "seed",
    validation_mode: "machine",
    owner_agent_id: stableEntityId("agent", `${input.runId}:s23-source`),
    acceptance_criteria: ["Invalidation fact is persisted"],
    max_attempts: 3,
  })
  yield* runtime.projects.transition({ id: project.id, status: "executing" })
  yield* runtime.projects.startWorkItem(source.id)
  const sourceArtifact = yield* runtime.projects.addArtifact({
    project_id: project.id,
    work_item_id: source.id,
    kind: "invalidation_probe",
    title: "S23 invalidated assumption",
    content: JSON.stringify({ originalPathValid: false }),
  })
  yield* runtime.projects.completeWorkItemWithReceipt({
    id: source.id,
    receipt: {
      idempotency_key: `b5-s23-source-${input.runId}`,
      outcome: "completed",
      summary: "The original path is invalid and must be superseded",
      artifact_ids: [sourceArtifact.id],
      evidence_refs: [{ kind: "artifact", id: sourceArtifact.id }],
      confirmed_facts: ["original path invalid"],
      invalidated_assumptions: ["original path remains valid"],
      unknowns: [],
      blockers: [],
      capability_gaps: [],
      task_proposals: [],
      dependency_proposals: [],
      questions: [],
    },
  })
  const receipt = (yield* runtime.projects.listWorkReceipts(project.id)).find(
    (candidate) => candidate.work_item_id === source.id,
  )
  if (!receipt) throw new Error("S23 invalidation produced no Work Receipt")
  const replacementId = stableEntityId("cwi", `${input.runId}:s23-replacement`)
  const mutation = yield* runtime.graph.apply(
    GraphMutationProposal.parse({
      project_id: project.id,
      trigger_receipt_id: receipt.id,
      expected_revision: 0,
      orchestrator_version: 1,
      idempotency_key: `b5-s23-supersede-${input.runId}`,
      decision: "supersede",
      rationale: "Persisted Receipt invalidated only the original path",
      evidence_refs: receipt.evidence_refs,
      operations: [
        {
          type: "add_work_item",
          item: NewGraphWorkItem.parse({
            id: replacementId,
            plan_id: plan.id,
            title: "Replacement verified path",
            description: "Replace the invalidated path without deleting history",
            kind: "worker",
            work_type: "analysis",
            role: "replacement path operator",
            capability_packs: ["research-analysis@1"],
            decision_scope: ["bounded delivery"],
            resource_scope: ["artifacts/b5/s23"],
            inputs: [sourceArtifact.id],
            expected_outputs: ["Replacement evidence"],
            validators: ["Replacement path is valid"],
            disposition: "retain",
            model_group: "standard",
            risk_level: "medium",
            review_status: "not_required",
            owner_agent_id: stableEntityId("agent", `${input.runId}:s23-replacement`),
            acceptance_criteria: ["Replacement path is valid"],
            max_attempts: 3,
            purpose: "delivery",
            validation_mode: "machine",
          }),
        },
        {
          type: "supersede_work_item",
          work_item_id: original.id,
          replacement_id: replacementId,
          reason: "Receipt invalidated the original path",
        },
      ],
    }),
  )
  if (mutation.status !== "applied") throw new Error("S23 supersede mutation was not applied")
  const mutatedItems = yield* runtime.projects.listWorkItems(project.id)
  const superseded = mutatedItems.find((candidate) => candidate.id === original.id)
  const replacement = mutatedItems.find((candidate) => candidate.id === replacementId)
  if (
    superseded?.status !== "superseded" ||
    superseded.superseded_by_id !== replacementId ||
    replacement?.origin_kind !== "graph_mutation"
  )
    throw new Error("S23 did not retain the superseded WorkItem and its replacement link")
  yield* runtime.projects.startWorkItem(replacement.id)
  yield* runtime.projects.addArtifact({
    project_id: project.id,
    work_item_id: replacement.id,
    kind: "replacement_evidence",
    title: "S23 replacement evidence",
    content: JSON.stringify({ replacementPathValid: true }),
  })
  yield* runtime.projects.completeWorkItem(replacement.id)
  const event = (yield* runtime.projects.listEvents(project.id)).find(
    (candidate) => candidate.type === "work_item.superseded",
  )
  if (!event) throw new Error("S23 supersede history event is unavailable")
  return B5ScenarioRunResult.parse({
    binding: {
      projectId: project.id,
      scenarioId: "S23",
      runId: input.runId,
      strategy: input.strategy,
      snapshotDigest: input.snapshot.snapshotDigest,
    },
    projectStatus: (yield* runtime.projects.get(project.id))!.status,
    terminalDecision: "in_progress",
    sourceRefs: [
      { kind: "project", id: project.id },
      { kind: "work_receipt", id: receipt.id },
      { kind: "graph_mutation", id: mutation.mutation.id },
      { kind: "work_item", id: original.id },
      { kind: "work_item", id: replacement.id },
      { kind: "project_event", id: event.id },
    ],
    oracle: {
      kind: "s23_supersede_replace",
      receiptId: receipt.id,
      mutationId: mutation.mutation.id,
      supersededWorkItemId: original.id,
      replacementWorkItemId: replacement.id,
      supersedeEventId: event.id,
      historyRetained: true,
    },
  })
})

const identityDigest = (agent: CompanyAgentInfo | undefined) => {
  if (!agent) throw new Error("B5 identity snapshot requires a persisted Agent")
  return digest({
    id: agent.id,
    companyId: agent.company_id,
    roleKey: agent.role_key,
    lifecycle: agent.lifecycle,
    department: agent.department,
    reportsTo: agent.reports_to,
    responsibilities: agent.responsibilities,
  })
}

const runS25 = Effect.fn("B5CandidateScenarios.S25")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  const companyId = CompanyID.parse("cmp_local")
  const agent = yield* runtime.agents.create({
    id: stableEntityId("b5-s25-agent", input.runId).replaceAll("_", "-"),
    company_id: companyId,
    name: "B5 S25 Permanent Analyst",
    lifecycle: "employee",
    role_key: "permanent-evidence-analyst",
    preferred_runtime: "codex",
    department: "assurance",
    reports_to: "board-cto",
    responsibilities: ["evidence analyst", "analysis", "research", "research-analysis"],
  })
  const identityBeforeSha256 = identityDigest(agent)
  const project = yield* runtime.projects.create({
    company_id: companyId,
    goal: "Assign and release a permanent Agent without mutating permanent identity",
    title: "B5 S25 temporary assignment lifecycle",
    execution_strategy: "seed_and_grow",
    seed_mode: "direct_single",
  })
  yield* runtime.projects.transition({ id: project.id, status: "planning" })
  const plan = yield* runtime.projects.createPlan({
    project_id: project.id,
    phase: "execution",
    summary: "Temporarily assign one permanent evidence analyst",
    acceptance_criteria: ["Assignment releases and Agent identity remains unchanged"],
  })
  const item = yield* runtime.projects.createWorkItem({
    project_id: project.id,
    plan_id: plan.id,
    title: "S25 temporary evidence role",
    description: "Exercise one project-scoped Assignment",
    kind: "worker",
    work_type: "analysis",
    role: "evidence analyst",
    capability_packs: ["research-analysis@1"],
    decision_scope: ["project evidence"],
    resource_scope: ["artifacts/b5/s25"],
    expected_outputs: ["Assignment lifecycle evidence"],
    validators: ["Permanent identity is unchanged"],
    model_group: "standard",
    risk_level: "medium",
    review_status: "not_required",
    purpose: "delivery",
    origin_kind: "seed",
    validation_mode: "machine",
    acceptance_criteria: ["Permanent identity is unchanged"],
    max_attempts: 3,
  })
  const need = yield* runtime.recruitment.createNeed({
    company_id: companyId,
    project_id: project.id,
    work_item_id: item.id,
    need_key: "b5-s25-evidence",
    role: item.role,
    work_type: item.work_type,
    capability_packs: item.capability_packs,
    risk_level: "medium",
    demand_horizon: "project",
    required_runtime_capabilities: ["structuredOutput", "workspaceRead"],
    required_tools: ["read"],
    allowed_permission_modes: ["read_only"],
    workspace_scopes: item.resource_scope,
  })
  const selected = yield* runtime.recruitment.selectAndAssign({
    capability_need_id: need.id,
    permission_mode: "read_only",
  })
  if (selected.agent.id !== agent.id)
    throw new Error("S25 did not select the persisted permanent Agent")
  const released = yield* runtime.recruitment.releaseProject({
    company_id: companyId,
    project_id: project.id,
  })
  const assignment = (yield* runtime.recruitment.listAssignments({ project_id: project.id })).find(
    (candidate) => candidate.id === selected.assignment.id,
  )
  const identityAfterSha256 = identityDigest(yield* runtime.agents.get(agent.id))
  if (
    !released.some((selection) => selection.id === selected.assignment.selection_id) ||
    assignment?.status !== "released" ||
    identityAfterSha256 !== identityBeforeSha256
  )
    throw new Error("S25 release mutated permanent Agent identity or lost Assignment history")
  return B5ScenarioRunResult.parse({
    binding: {
      projectId: project.id,
      scenarioId: "S25",
      runId: input.runId,
      strategy: input.strategy,
      snapshotDigest: input.snapshot.snapshotDigest,
    },
    projectStatus: (yield* runtime.projects.get(project.id))!.status,
    terminalDecision: "in_progress",
    sourceRefs: [
      { kind: "project", id: project.id },
      { kind: "work_item", id: item.id },
      { kind: "project_assignment", id: selected.assignment.id },
    ],
    oracle: {
      kind: "s25_assignment_release",
      agentId: agent.id,
      selectionId: selected.assignment.selection_id,
      assignmentId: selected.assignment.id,
      identityBeforeSha256,
      identityAfterSha256,
      released: true,
    },
  })
})

const createReuseProject = Effect.fn("B5CandidateScenarios.createReuseProject")(function* (
  runtime: B5ScenarioRuntime,
  companyId: CompanyID,
  title: string,
) {
  const project = yield* runtime.projects.create({
    company_id: companyId,
    goal: "Reuse one equivalent company capability without candidate growth",
    title,
    execution_strategy: "seed_and_grow",
    seed_mode: "direct_single",
  })
  yield* runtime.projects.transition({ id: project.id, status: "planning" })
  const plan = yield* runtime.projects.createPlan({
    project_id: project.id,
    phase: "execution",
    summary: "Assign one recurring research capability",
    acceptance_criteria: ["Equivalent Need reuses the company pool"],
  })
  const item = yield* runtime.projects.createWorkItem({
    project_id: project.id,
    plan_id: plan.id,
    title: "Recurring research evidence",
    description: "Request an equivalent recurring capability",
    kind: "worker",
    work_type: "research",
    role: "research analyst",
    capability_packs: ["research-analysis@1"],
    decision_scope: ["research evidence"],
    resource_scope: ["artifacts/b5/s26"],
    expected_outputs: ["Research evidence"],
    validators: ["Equivalent Need uses the company pool"],
    model_group: "standard",
    risk_level: "medium",
    review_status: "not_required",
    purpose: "delivery",
    origin_kind: "seed",
    validation_mode: "machine",
    acceptance_criteria: ["Equivalent Need uses the company pool"],
    max_attempts: 3,
  })
  return { project, item }
})

const runS26 = Effect.fn("B5CandidateScenarios.S26")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  const companyId = CompanyID.parse("cmp_local")
  const first = yield* createReuseProject(runtime, companyId, "B5 S26 first equivalent Need")
  const firstNeed = yield* runtime.recruitment.createNeed({
    company_id: companyId,
    project_id: first.project.id,
    work_item_id: first.item.id,
    need_key: "b5-s26-research",
    role: first.item.role,
    work_type: first.item.work_type,
    capability_packs: first.item.capability_packs,
    risk_level: "medium",
    demand_horizon: "recurring",
    allowed_permission_modes: ["read_only"],
    workspace_scopes: first.item.resource_scope,
  })
  const firstSelection = yield* runtime.recruitment.selectAndAssign({
    capability_need_id: firstNeed.id,
    permission_mode: "read_only",
  })
  yield* runtime.recruitment.releaseProject({
    company_id: companyId,
    project_id: first.project.id,
  })
  const candidateCountBeforeSecond = (
    yield* runtime.agents.list({ company_id: companyId, lifecycle: "candidate" })
  ).length
  const second = yield* createReuseProject(runtime, companyId, "B5 S26 second equivalent Need")
  const secondNeed = yield* runtime.recruitment.createNeed({
    company_id: companyId,
    project_id: second.project.id,
    work_item_id: second.item.id,
    need_key: "b5-s26-research",
    role: second.item.role,
    work_type: second.item.work_type,
    capability_packs: second.item.capability_packs,
    risk_level: "medium",
    demand_horizon: "recurring",
    allowed_permission_modes: ["read_only"],
    workspace_scopes: second.item.resource_scope,
  })
  const secondSelection = yield* runtime.recruitment.selectAndAssign({
    capability_need_id: secondNeed.id,
    permission_mode: "read_only",
  })
  const selectedDecision = secondSelection.selections.find(
    (candidate) => candidate.decision === "selected",
  )
  const candidateCountAfterSecond = (
    yield* runtime.agents.list({ company_id: companyId, lifecycle: "candidate" })
  ).length
  if (
    secondSelection.agent.id !== firstSelection.agent.id ||
    selectedDecision?.source !== "company_pool" ||
    candidateCountAfterSecond !== candidateCountBeforeSecond
  )
    throw new Error("S26 equivalent Need did not reuse the company pool without candidate growth")
  return B5ScenarioRunResult.parse({
    binding: {
      projectId: second.project.id,
      scenarioId: "S26",
      runId: input.runId,
      strategy: input.strategy,
      snapshotDigest: input.snapshot.snapshotDigest,
    },
    projectStatus: (yield* runtime.projects.get(second.project.id))!.status,
    terminalDecision: "in_progress",
    sourceRefs: [
      { kind: "project", id: second.project.id },
      { kind: "work_item", id: second.item.id },
      { kind: "project_assignment", id: secondSelection.assignment.id },
    ],
    oracle: {
      kind: "s26_company_pool_reuse",
      firstProjectId: first.project.id,
      secondProjectId: second.project.id,
      firstNeedId: firstNeed.id,
      secondNeedId: secondNeed.id,
      firstAssignmentId: firstSelection.assignment.id,
      secondAssignmentId: secondSelection.assignment.id,
      agentId: secondSelection.agent.id,
      candidateCountBeforeSecond,
      candidateCountAfterSecond,
      secondSelectionSource: selectedDecision.source,
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

const runRecoveryScenario = Effect.fn("B5CandidateScenarios.recovery")(function* (
  input: B5ScenarioRunInput,
  runtime: B5ScenarioRuntime,
) {
  if (
    !input.candidateSha ||
    !input.recoveryOutputDirectory ||
    !["S19", "S20", "S27"].includes(input.snapshot.scenario.id)
  )
    throw new Error("B5 recovery scenario requires candidate and output bindings")
  const recovery = yield* Effect.promise(() =>
    produceB5CandidateRecovery({
      candidateSha: input.candidateSha!,
      scenarioId: input.snapshot.scenario.id as "S19" | "S20" | "S27",
      snapshotDigest: input.snapshot.snapshotDigest,
      runId: input.runId,
      outputDirectory: input.recoveryOutputDirectory!,
    }),
  )
  if (
    !recovery.exactlyOnce ||
    recovery.duplicateSideEffects !== 0 ||
    recovery.recoveredAt <= recovery.lostAt
  )
    throw new Error(`${recovery.scenarioId} did not prove exactly-once process recovery`)
  if (
    recovery.scenarioId === "S19" &&
    (!recovery.process ||
      !recovery.receiptRecovery ||
      recovery.receiptRecovery.firstRecoverProcessedCount !== 1 ||
      recovery.receiptRecovery.secondRecoverProcessedCount !== 0)
  )
    throw new Error("S19 did not prove one real Receipt recovery followed by an idempotent replay")
  if (
    recovery.scenarioId === "S20" &&
    (recovery.boundaries.length !== 3 ||
      recovery.boundaries.some(
        (boundary) =>
          boundary.duplicateSideEffects !== 0 ||
          boundary.afterRevision !== boundary.beforeRevision + 1,
      ))
  )
    throw new Error("S20 did not prove atomic recovery at all mutation boundaries")
  if (
    recovery.scenarioId === "S27" &&
    (!recovery.process ||
      !recovery.startup?.dispatchAfterReconcile ||
      !recovery.startup.projectionConverged ||
      recovery.startup.dispatchProbedAt < recovery.startup.reconciledAt)
  )
    throw new Error("S27 did not reconcile recovery and projection before dispatch")
  const project = yield* runtime.projects.get(recovery.projectId)
  if (!project) throw new Error(`${recovery.scenarioId} recovered Project is unavailable`)
  const primaryIndex = Math.max(
    0,
    recovery.entityIds.projectIds.findLastIndex((projectId) => projectId === recovery.projectId),
  )
  const receiptId =
    recovery.entityIds.receiptIds[primaryIndex] ?? recovery.entityIds.receiptIds[0]
  const mutationId =
    recovery.entityIds.mutationIds[primaryIndex] ?? recovery.entityIds.mutationIds[0]
  const crashedPids = recovery.process
    ? [recovery.process.crashedPid]
    : recovery.boundaries.map((boundary) => boundary.crashedPid)
  const recoveryPids = recovery.process
    ? [recovery.process.recoveryPid]
    : recovery.boundaries.map((boundary) => boundary.recoveryPid)
  return B5ScenarioRunResult.parse({
    binding: {
      projectId: recovery.projectId,
      scenarioId: recovery.scenarioId,
      runId: input.runId,
      strategy: input.strategy,
      snapshotDigest: input.snapshot.snapshotDigest,
    },
    projectStatus: project.status,
    terminalDecision: "in_progress",
    sourceRefs: [
      { kind: "project", id: recovery.projectId },
      ...recovery.entityIds.workItemIds.slice(0, 1).map((id) => ({
        kind: "work_item" as const,
        id,
      })),
      ...(receiptId ? [{ kind: "work_receipt" as const, id: receiptId }] : []),
      ...(mutationId ? [{ kind: "graph_mutation" as const, id: mutationId }] : []),
    ],
    oracle: {
      kind: "b5_process_recovery",
      scenarioId: recovery.scenarioId,
      receiptIds: recovery.entityIds.receiptIds,
      mutationIds: recovery.entityIds.mutationIds,
      lostAt: recovery.lostAt,
      recoveredAt: recovery.recoveredAt,
      crashedPids,
      recoveryPids,
      duplicateSideEffects: recovery.duplicateSideEffects,
      exactlyOnce: recovery.exactlyOnce,
      reportSha256: recovery.report.sha256,
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
  if (input.snapshot.scenario.id === "S14") return yield* runS14(input, runtime)
  if (input.snapshot.scenario.id === "S15") return yield* runS15(input, runtime)
  if (input.snapshot.scenario.id === "S16") return yield* runS16(input, runtime)
  if (input.snapshot.scenario.id === "S17") return yield* runS17(input, runtime)
  if (input.snapshot.scenario.id === "S18") return yield* runS18(input, runtime)
  if (["S19", "S20"].includes(input.snapshot.scenario.id))
    return yield* runRecoveryScenario(input, runtime)
  if (input.snapshot.scenario.id === "S21") return yield* runS21(input, runtime)
  if (input.snapshot.scenario.id === "S22") return yield* runS22(input, runtime)
  if (input.snapshot.scenario.id === "S23") return yield* runS23(input, runtime)
  if (input.snapshot.scenario.id === "S24") return yield* runS24(input, runtime)
  if (input.snapshot.scenario.id === "S25") return yield* runS25(input, runtime)
  if (input.snapshot.scenario.id === "S26") return yield* runS26(input, runtime)
  if (input.snapshot.scenario.id === "S27") return yield* runRecoveryScenario(input, runtime)
  throw new Error(`B5 scenario ${input.snapshot.scenario.id} driver is not implemented`)
})
