import fs from "node:fs/promises"
import path from "node:path"
import { canonicalize, sha256, verifyExactCommit } from "./experience-benchmark"

export const root = path.resolve(import.meta.dir, "..")
export const stageIDs = ["A0", "A1", "A2", "A3", "A4", "B0", "B1", "B2", "B3", "B4", "B5"] as const
export type StageID = (typeof stageIDs)[number]
export const stageContractPath = "docs/product-design/experience-refactor/seed-grow-stage-contract.v1.json"
export const stageEvidenceSchemaPath = "docs/product-design/experience-refactor/seed-grow-stage-evidence.v1.json"
export const orchestrationContractPath =
  "docs/product-design/experience-refactor/orchestration-contract.v1.json"
export const seedGrowBenchmarkPath =
  "docs/product-design/experience-refactor/seed-grow-benchmark-scenarios.v1.json"
export const metricContractPath = "docs/product-design/experience-refactor/metric-contract.v1.json"
export const planPath = "docs/AgentCompany-Seed-and-Grow-Development-Plan-v1.0.md"
export const automaticRequirementsPath =
  "docs/product-design/experience-refactor/automatic-evidence-requirements.v1.json"
export const stageRunnerPath = "script/seed-grow-stage-evidence.ts"
export const stageGatePath = "script/seed-grow-stage-gate.ts"

const requiredSeedGrowMetricIDs = [
  "complex_initial_assignment_median",
  "graph_mutation_without_evidence_rate",
  "receipt_recovery_success_rate",
  "graph_mutation_recovery_success_rate",
  "graph_repair_success_rate",
  "blind_retry_rate",
  "validation_gate_false_pass_rate",
  "candidate_reuse_rate",
  "new_candidate_per_completed_project",
  "unnecessary_reviewer_rate",
  "reviewer_rejection_precision",
  "reviewer_invocation_ratio_vs_legacy",
  "agent_load_balance",
  "automated_graph_decision_rate",
  "invalid_interruption_rate",
  "three_round_circuit_breaker_count",
  "graph_growth_node_count",
  "accepted_delivery_cost",
  "low_risk_quality_ratio_vs_legacy",
] as const

const requiredR4MetricIDs = [
  "delivery_consumability_rate",
  "acceptance_determinability_rate",
  "false_success_or_data_count",
  "graph_mutation_without_evidence_rate",
  "complex_initial_assignment_median",
  "receipt_recovery_success_rate",
  "graph_mutation_recovery_success_rate",
  "validation_gate_false_pass_rate",
  "blind_retry_rate",
  "invalid_interruption_rate",
  "reviewer_invocation_ratio_vs_legacy",
  "candidate_reuse_rate",
  "new_candidate_per_completed_project",
  "low_risk_quality_ratio_vs_legacy",
  "core_task_completion_rate",
] as const

export type StageCriterion = {
  id: string
  statement: string
  evidenceRefs: string[]
}

export type StageDefinition = {
  id: StageID
  capabilityPackage: string
  releaseWindow: string
  dependsOn: StageID[]
  taskIds: string[]
  governedPaths: string[]
  requiredCommandIds: string[]
  repeats: number
  criteria: StageCriterion[]
}

export type StageContract = {
  schemaVersion: number
  id: string
  version: string
  planBinding: { path: string }
  orchestrationBinding: { path: string }
  benchmarkBinding: { path: string }
  metricBinding: { path: string }
  evidenceSchemaBinding: { path: string }
  validationProfile: string
  githubActions: {
    status: string
    blocking: boolean
    replacement: string
  }
  freshness: {
    maxAgeMs: number
    futureToleranceMs: number
  }
  isolation: {
    mode: string
    requiredEnvironment: string[]
    liveDatabaseAllowed: boolean
    productionDataAllowed: boolean
    attempts: number
  }
  implementedStages: StageID[]
  commandRegistry: {
    automaticEvidenceCommands: string[]
    plannedStageCommands: string[]
  }
  stages: StageDefinition[]
}

export type SeedGrowGovernance = {
  contract: StageContract
  contractSource: string
  contractSha256: string
  schemaSource: string
  schemaSha256: string
  planSource: string
  planSha256: string
  orchestrationSource: string
  orchestrationSha256: string
  benchmarkSource: string
  benchmarkSha256: string
  metricSource: string
  metricSha256: string
  automaticRequirementsSource: string
  automaticRequirementsSha256: string
  automaticCommandIDs: string[]
  buildTreeSha: string
}

export type FileBinding = {
  relativePath: string
  sha256: string
  byteLength: number
  mediaType: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function sameValues(actual: string[], expected: string[]) {
  return actual.length === expected.length && expected.every((item) => actual.includes(item))
}

export function exactKeys(value: Record<string, unknown>, expected: string[]) {
  return sameValues(Object.keys(value), expected)
}

export function confinedRelativePath(value: unknown) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..")
  )
}

export function validDate(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

export function runGit(args: string[], cwd = root, allowedExitCodes = [0]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!allowedExitCodes.includes(result.exitCode)) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} exited ${result.exitCode}`)
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function taskIDsFromPlan(source: string) {
  return [
    ...new Set(
      [...source.matchAll(/`([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)`/g)].map((match) => match[1]!),
    ),
  ].sort()
}

function validateOrchestration(value: unknown) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.id !== "agent-company-seed-grow-orchestration" ||
    value.version !== "1.0.0" ||
    value.status !== "contract_only" ||
    !isRecord(value.authority) ||
    value.authority.controlPlane !== "single_local_control_plane" ||
    value.authority.database !== "single_sqlite_authority" ||
    value.authority.runtime !== "single_agent_runtime" ||
    !isRecord(value.projectExecutionStrategy) ||
    value.projectExecutionStrategy.factOwner !== "company_project.execution_strategy" ||
    !sameValues(
      Array.isArray(value.projectExecutionStrategy.values)
        ? value.projectExecutionStrategy.values.filter((item): item is string => typeof item === "string")
        : [],
      ["legacy_full_plan", "seed_and_grow"],
    ) ||
    value.projectExecutionStrategy.default !== "legacy_full_plan" ||
    value.projectExecutionStrategy.pinnedAt !== "project_creation" ||
    value.projectExecutionStrategy.mutableWhileActive !== false ||
    !isRecord(value.rolloutFlag) ||
    value.rolloutFlag.factOwner !== "AGENTCOMPANY_SEED_GROW_ORCHESTRATION" ||
    !sameValues(
      Array.isArray(value.rolloutFlag.values)
        ? value.rolloutFlag.values.filter((item): item is string => typeof item === "string")
        : [],
      ["off", "shadow", "active"],
    ) ||
    value.rolloutFlag.default !== "off" ||
    value.rolloutFlag.invalidValue !== "reject" ||
    !isRecord(value.runtimeApprovalBoundary) ||
    value.runtimeApprovalBoundary.preserved !== true ||
    value.runtimeApprovalBoundary.automatedApprovalExecutionAllowed !== false ||
    !isRecord(value.prePublicStageGate) ||
    value.prePublicStageGate.machineEvidenceBlocking !== true ||
    value.prePublicStageGate.humanEvidenceBlocking !== false ||
    value.prePublicStageGate.waiverAccepted !== false
  ) {
    throw new Error("Seed-and-Grow orchestration contract is invalid.")
  }
}

function validateBenchmark(value: unknown, r0BenchmarkSource: string, metricIDs: string[]) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.id !== "agent-company-seed-grow-benchmark-extension" ||
    value.version !== "1.0.0" ||
    !isRecord(value.extends) ||
    value.extends.path !== "docs/product-design/experience-refactor/benchmark-scenarios.v1.json" ||
    value.extends.sha256 !== sha256(r0BenchmarkSource) ||
    !Array.isArray(value.extends.scenarioIds) ||
    !sameValues(
      value.extends.scenarioIds.filter((item): item is string => typeof item === "string"),
      Array.from({ length: 12 }, (_, index) => `S${String(index + 1).padStart(2, "0")}`),
    ) ||
    !isRecord(value.dataIsolation) ||
    value.dataIsolation.productionDataAllowed !== false ||
    value.dataIsolation.externalSideEffectsAllowed !== false ||
    !Array.isArray(value.scenarios)
  ) {
    throw new Error("Seed-and-Grow benchmark extension is invalid.")
  }
  const scenarioIDs = value.scenarios.flatMap((scenario) =>
    isRecord(scenario) && typeof scenario.id === "string" ? [scenario.id] : [],
  )
  if (
    !sameValues(
      scenarioIDs,
      Array.from({ length: 15 }, (_, index) => `S${String(index + 13).padStart(2, "0")}`),
    ) ||
    new Set(scenarioIDs).size !== scenarioIDs.length
  ) {
    throw new Error("Seed-and-Grow benchmark must contain exactly S13 through S27.")
  }
  const seeds: number[] = []
  value.scenarios.forEach((scenario) => {
    if (
      !isRecord(scenario) ||
      !exactKeys(scenario, [
        "id",
        "title",
        "seed",
        "runMode",
        "firstRequiredStage",
        "inputs",
        "expectedOutputs",
        "allowedQuestions",
        "acceptanceCriteria",
        "failureConditions",
        "observedMetrics",
        "humanEvidenceRequired",
      ]) ||
      typeof scenario.title !== "string" ||
      typeof scenario.seed !== "number" ||
      !Number.isInteger(scenario.seed) ||
      scenario.runMode !== "automated" ||
      !stageIDs.includes(scenario.firstRequiredStage as StageID) ||
      !Array.isArray(scenario.inputs) ||
      !scenario.inputs.length ||
      !scenario.inputs.every((item) => typeof item === "string") ||
      !Array.isArray(scenario.expectedOutputs) ||
      !scenario.expectedOutputs.length ||
      !scenario.expectedOutputs.every((item) => typeof item === "string") ||
      !Array.isArray(scenario.allowedQuestions) ||
      !scenario.allowedQuestions.every((item) => typeof item === "string") ||
      !Array.isArray(scenario.acceptanceCriteria) ||
      !scenario.acceptanceCriteria.length ||
      !scenario.acceptanceCriteria.every(
        (criterion) =>
          isRecord(criterion) &&
          exactKeys(criterion, ["id", "statement", "evidence"]) &&
          typeof criterion.id === "string" &&
          typeof criterion.statement === "string" &&
          typeof criterion.evidence === "string",
      ) ||
      !Array.isArray(scenario.failureConditions) ||
      !scenario.failureConditions.length ||
      !scenario.failureConditions.every((item) => typeof item === "string") ||
      !Array.isArray(scenario.observedMetrics) ||
      !scenario.observedMetrics.length ||
      !scenario.observedMetrics.every((item) => typeof item === "string" && metricIDs.includes(item)) ||
      !Array.isArray(scenario.humanEvidenceRequired) ||
      scenario.humanEvidenceRequired.length !== 0
    ) {
      throw new Error(`Seed-and-Grow benchmark scenario ${String(scenario.id)} is invalid.`)
    }
    seeds.push(scenario.seed)
  })
  if (new Set(seeds).size !== seeds.length) throw new Error("Seed-and-Grow benchmark seeds must be unique.")
}

function validateMetrics(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.metrics) || !Array.isArray(value.releaseGates)) {
    throw new Error("Seed-and-Grow metric governance is invalid.")
  }
  const metrics = value.metrics.filter(isRecord)
  const metricIDs = metrics.flatMap((metric) => (typeof metric.id === "string" ? [metric.id] : []))
  requiredSeedGrowMetricIDs.forEach((id) => {
    const metric = metrics.find((item) => item.id === id)
    if (
      !metric ||
      typeof metric.formula !== "string" ||
      typeof metric.numerator !== "string" ||
      typeof metric.denominator !== "string" ||
      !Array.isArray(metric.eventSource) ||
      !metric.eventSource.length ||
      !metric.eventSource.every((item) => typeof item === "string") ||
      typeof metric.timeWindow !== "string" ||
      typeof metric.minimumSampleSize !== "number" ||
      !Number.isInteger(metric.minimumSampleSize) ||
      metric.minimumSampleSize < 1 ||
      !isRecord(metric.target) ||
      metric.target.gate !== "R4" ||
      typeof metric.target.operator !== "string" ||
      typeof metric.target.value !== "number"
    ) {
      throw new Error(`Seed-and-Grow metric ${id} is incomplete.`)
    }
  })
  const r4 = value.releaseGates.find((gate) => isRecord(gate) && gate.id === "R4")
  const r4MetricIDs =
    isRecord(r4) && Array.isArray(r4.requiredThresholds)
      ? r4.requiredThresholds.flatMap((threshold) =>
          isRecord(threshold) && typeof threshold.metricId === "string" ? [threshold.metricId] : [],
        )
      : []
  if (!requiredR4MetricIDs.every((id) => r4MetricIDs.includes(id))) {
    throw new Error("R4 metric Gate is missing a Seed-and-Grow blocking threshold.")
  }
  return metricIDs
}

function validateEvidenceSchema(value: unknown) {
  if (
    !isRecord(value) ||
    value.type !== "object" ||
    value.additionalProperties !== false ||
    !Array.isArray(value.required) ||
    !sameValues(value.required.filter((item): item is string => typeof item === "string"), [
      "schemaVersion",
      "packageVersion",
      "packageId",
      "stage",
      "capabilityPackage",
      "buildSha",
      "buildTreeSha",
      "contractBinding",
      "schemaBinding",
      "runnerBinding",
      "validationProfile",
      "githubActions",
      "createdAt",
      "finishedAt",
      "attempts",
      "coverage",
      "overallStatus",
      "advisory",
    ]) ||
    !isRecord(value.properties) ||
    !isRecord(value.properties.buildSha) ||
    value.properties.buildSha.type !== "string" ||
    !isRecord(value.properties.attempts) ||
    value.properties.attempts.minItems !== 2 ||
    value.properties.attempts.maxItems !== 2
  ) {
    throw new Error("Seed-and-Grow evidence schema is not strict.")
  }
}

function automaticCommandIDs(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.commands)) {
    throw new Error("Automatic evidence command registry is invalid.")
  }
  const ids = value.commands.flatMap((command) =>
    isRecord(command) && typeof command.id === "string" ? [command.id] : [],
  )
  if (ids.length !== value.commands.length || new Set(ids).size !== ids.length) {
    throw new Error("Automatic evidence command IDs must be complete and unique.")
  }
  return ids
}

export function validateStageContract(
  value: unknown,
  planSource: string,
  automaticIDs: string[],
) {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "id",
      "version",
      "planBinding",
      "orchestrationBinding",
      "benchmarkBinding",
      "metricBinding",
      "evidenceSchemaBinding",
      "validationProfile",
      "githubActions",
      "freshness",
      "isolation",
      "implementedStages",
      "commandRegistry",
      "stages",
    ]) ||
    value.schemaVersion !== 1 ||
    value.id !== "agent-company-seed-grow-stage-contract" ||
    value.version !== "1.0.0" ||
    !isRecord(value.planBinding) ||
    !exactKeys(value.planBinding, ["path"]) ||
    value.planBinding.path !== planPath ||
    !isRecord(value.orchestrationBinding) ||
    !exactKeys(value.orchestrationBinding, ["path"]) ||
    value.orchestrationBinding.path !== orchestrationContractPath ||
    !isRecord(value.benchmarkBinding) ||
    !exactKeys(value.benchmarkBinding, ["path"]) ||
    value.benchmarkBinding.path !== seedGrowBenchmarkPath ||
    !isRecord(value.metricBinding) ||
    !exactKeys(value.metricBinding, ["path"]) ||
    value.metricBinding.path !== metricContractPath ||
    !isRecord(value.evidenceSchemaBinding) ||
    !exactKeys(value.evidenceSchemaBinding, ["path"]) ||
    value.evidenceSchemaBinding.path !== stageEvidenceSchemaPath ||
    value.validationProfile !== "local_exact_sha_fallback" ||
    !isRecord(value.githubActions) ||
    !exactKeys(value.githubActions, ["status", "blocking", "replacement"]) ||
    value.githubActions.status !== "unavailable" ||
    value.githubActions.blocking !== false ||
    value.githubActions.replacement !== "two_local_exact_sha_runs" ||
    !isRecord(value.freshness) ||
    !exactKeys(value.freshness, ["maxAgeMs", "futureToleranceMs"]) ||
    value.freshness.maxAgeMs !== 86_400_000 ||
    value.freshness.futureToleranceMs !== 300_000 ||
    !isRecord(value.isolation) ||
    !exactKeys(value.isolation, [
      "mode",
      "requiredEnvironment",
      "liveDatabaseAllowed",
      "productionDataAllowed",
      "attempts",
    ]) ||
    value.isolation.mode !== "detached_exact_commit_worktree" ||
    !Array.isArray(value.isolation.requiredEnvironment) ||
    value.isolation.liveDatabaseAllowed !== false ||
    value.isolation.productionDataAllowed !== false ||
    value.isolation.attempts !== 2 ||
    !Array.isArray(value.implementedStages) ||
    !value.implementedStages.length ||
    !value.implementedStages.every((item) => typeof item === "string") ||
    value.implementedStages.some((item, index) => item !== stageIDs[index]) ||
    !isRecord(value.commandRegistry) ||
    !exactKeys(value.commandRegistry, ["automaticEvidenceCommands", "plannedStageCommands"]) ||
    !Array.isArray(value.commandRegistry.automaticEvidenceCommands) ||
    !Array.isArray(value.commandRegistry.plannedStageCommands) ||
    !Array.isArray(value.stages)
  ) {
    throw new Error("Seed-and-Grow stage contract is structurally invalid.")
  }
  const registeredAutomatic = value.commandRegistry.automaticEvidenceCommands.filter(
    (item): item is string => typeof item === "string",
  )
  const registeredPlanned = value.commandRegistry.plannedStageCommands.filter(
    (item): item is string => typeof item === "string",
  )
  if (
    !sameValues(registeredAutomatic, automaticIDs) ||
    new Set(registeredAutomatic).size !== registeredAutomatic.length ||
    new Set(registeredPlanned).size !== registeredPlanned.length ||
    registeredPlanned.some((id) => registeredAutomatic.includes(id))
  ) {
    throw new Error("Seed-and-Grow command registry is incomplete or ambiguous.")
  }
  const stages = value.stages as unknown[]
  const actualStageIDs = stages.flatMap((stage) =>
    isRecord(stage) && typeof stage.id === "string" ? [stage.id] : [],
  )
  if (
    actualStageIDs.length !== stageIDs.length ||
    actualStageIDs.some((item, index) => item !== stageIDs[index])
  ) {
    throw new Error("Seed-and-Grow stage order must contain exactly A0 through B5.")
  }
  const taskIDs: string[] = []
  const criterionIDs: string[] = []
  stages.forEach((stageValue, index) => {
    if (
      !isRecord(stageValue) ||
      !exactKeys(stageValue, [
        "id",
        "capabilityPackage",
        "releaseWindow",
        "dependsOn",
        "taskIds",
        "governedPaths",
        "requiredCommandIds",
        "repeats",
        "criteria",
      ]) ||
      stageValue.id !== stageIDs[index] ||
      typeof stageValue.capabilityPackage !== "string" ||
      typeof stageValue.releaseWindow !== "string" ||
      !Array.isArray(stageValue.dependsOn) ||
      !stageValue.dependsOn.every(
        (item) => typeof item === "string" && stageIDs.slice(0, index).includes(item as StageID),
      ) ||
      !Array.isArray(stageValue.taskIds) ||
      !stageValue.taskIds.length ||
      !stageValue.taskIds.every((item) => typeof item === "string") ||
      !Array.isArray(stageValue.governedPaths) ||
      !stageValue.governedPaths.length ||
      !stageValue.governedPaths.every(confinedRelativePath) ||
      !Array.isArray(stageValue.requiredCommandIds) ||
      !stageValue.requiredCommandIds.length ||
      !stageValue.requiredCommandIds.every((item) => typeof item === "string") ||
      stageValue.repeats !== 2 ||
      !Array.isArray(stageValue.criteria) ||
      !stageValue.criteria.length
    ) {
      throw new Error(`Seed-and-Grow stage ${String(stageValue.id)} is invalid.`)
    }
    const implemented = value.implementedStages.includes(stageValue.id)
    const allowedCommands = implemented ? registeredAutomatic : registeredPlanned
    if (
      !stageValue.requiredCommandIds.every((id) => allowedCommands.includes(id)) ||
      new Set(stageValue.requiredCommandIds).size !== stageValue.requiredCommandIds.length
    ) {
      throw new Error(`Seed-and-Grow stage ${stageValue.id} command coverage is invalid.`)
    }
    const referencedCommands = new Set<string>()
    stageValue.criteria.forEach((criterion) => {
      if (
        !isRecord(criterion) ||
        !exactKeys(criterion, ["id", "statement", "evidenceRefs"]) ||
        typeof criterion.id !== "string" ||
        typeof criterion.statement !== "string" ||
        !criterion.statement ||
        !Array.isArray(criterion.evidenceRefs) ||
        !criterion.evidenceRefs.length ||
        !criterion.evidenceRefs.every((reference) => {
          if (typeof reference !== "string") return false
          if (reference.startsWith("command:")) {
            const command = reference.slice("command:".length)
            referencedCommands.add(command)
            return stageValue.requiredCommandIds.includes(command)
          }
          return ["runner:two_local_exact_sha_runs", "contract:coverage", "ci:availability"].includes(
            reference,
          )
        })
      ) {
        throw new Error(`Seed-and-Grow stage ${stageValue.id} criterion is invalid.`)
      }
      criterionIDs.push(criterion.id)
    })
    if (!sameValues([...referencedCommands], stageValue.requiredCommandIds)) {
      throw new Error(`Seed-and-Grow stage ${stageValue.id} leaves required commands unreferenced.`)
    }
    taskIDs.push(...stageValue.taskIds)
  })
  const planTaskIDs = taskIDsFromPlan(planSource)
  if (
    planTaskIDs.length !== 90 ||
    !sameValues(taskIDs, planTaskIDs) ||
    new Set(taskIDs).size !== taskIDs.length ||
    new Set(criterionIDs).size !== criterionIDs.length
  ) {
    throw new Error("Seed-and-Grow stage contract does not cover every unique plan Task and criterion.")
  }
  return value as unknown as StageContract
}

async function readCurrent(relativePath: string) {
  return Bun.file(path.join(root, relativePath)).text()
}

function readAtRef(ref: string, relativePath: string) {
  return runGit(["show", `${ref}:${relativePath}`]).stdout
}

async function assembleGovernance(
  sources: {
    contract: string
    schema: string
    plan: string
    orchestration: string
    benchmark: string
    metric: string
    automaticRequirements: string
    r0Benchmark: string
  },
  buildTreeSha: string,
) {
  const automaticIDs = automaticCommandIDs(JSON.parse(sources.automaticRequirements) as unknown)
  const metricValue: unknown = JSON.parse(sources.metric)
  const metricIDs = validateMetrics(metricValue)
  validateOrchestration(JSON.parse(sources.orchestration) as unknown)
  validateBenchmark(JSON.parse(sources.benchmark) as unknown, sources.r0Benchmark, metricIDs)
  validateEvidenceSchema(JSON.parse(sources.schema) as unknown)
  const contract = validateStageContract(
    JSON.parse(sources.contract) as unknown,
    sources.plan,
    automaticIDs,
  )
  return {
    contract,
    contractSource: sources.contract,
    contractSha256: sha256(sources.contract),
    schemaSource: sources.schema,
    schemaSha256: sha256(sources.schema),
    planSource: sources.plan,
    planSha256: sha256(sources.plan),
    orchestrationSource: sources.orchestration,
    orchestrationSha256: sha256(sources.orchestration),
    benchmarkSource: sources.benchmark,
    benchmarkSha256: sha256(sources.benchmark),
    metricSource: sources.metric,
    metricSha256: sha256(sources.metric),
    automaticRequirementsSource: sources.automaticRequirements,
    automaticRequirementsSha256: sha256(sources.automaticRequirements),
    automaticCommandIDs: automaticIDs,
    buildTreeSha,
  } satisfies SeedGrowGovernance
}

export async function loadCurrentSeedGrowGovernance(buildTreeSha = "0".repeat(40)) {
  const [
    contract,
    schema,
    plan,
    orchestration,
    benchmark,
    metric,
    automaticRequirements,
    r0Benchmark,
  ] = await Promise.all([
    readCurrent(stageContractPath),
    readCurrent(stageEvidenceSchemaPath),
    readCurrent(planPath),
    readCurrent(orchestrationContractPath),
    readCurrent(seedGrowBenchmarkPath),
    readCurrent(metricContractPath),
    readCurrent(automaticRequirementsPath),
    readCurrent("docs/product-design/experience-refactor/benchmark-scenarios.v1.json"),
  ])
  return assembleGovernance(
    {
      contract,
      schema,
      plan,
      orchestration,
      benchmark,
      metric,
      automaticRequirements,
      r0Benchmark,
    },
    buildTreeSha,
  )
}

export async function loadSeedGrowGovernance(buildSha: string) {
  verifyExactCommit(buildSha)
  const paths = [
    stageContractPath,
    stageEvidenceSchemaPath,
    planPath,
    orchestrationContractPath,
    seedGrowBenchmarkPath,
    metricContractPath,
    automaticRequirementsPath,
    "docs/product-design/experience-refactor/benchmark-scenarios.v1.json",
  ]
  const exact = Object.fromEntries(paths.map((relativePath) => [relativePath, readAtRef(buildSha, relativePath)]))
  const current = await Promise.all(paths.map(readCurrent))
  paths.forEach((relativePath, index) => {
    if (sha256(exact[relativePath]!) !== sha256(current[index]!)) {
      throw new Error(`Seed-and-Grow governance differs from exact build: ${relativePath}`)
    }
  })
  return assembleGovernance(
    {
      contract: exact[stageContractPath]!,
      schema: exact[stageEvidenceSchemaPath]!,
      plan: exact[planPath]!,
      orchestration: exact[orchestrationContractPath]!,
      benchmark: exact[seedGrowBenchmarkPath]!,
      metric: exact[metricContractPath]!,
      automaticRequirements: exact[automaticRequirementsPath]!,
      r0Benchmark: exact["docs/product-design/experience-refactor/benchmark-scenarios.v1.json"]!,
    },
    runGit(["show", "-s", "--format=%T", buildSha]).stdout.trim(),
  )
}

export function stageDefinition(contract: StageContract, stage: StageID) {
  const value = contract.stages.find((item) => item.id === stage)
  if (!value) throw new Error(`Unknown Seed-and-Grow stage: ${stage}`)
  return value
}

export function assertExactCandidate(buildSha: string, stage: StageDefinition) {
  verifyExactCommit(buildSha)
  const head = runGit(["rev-parse", "HEAD^{commit}"]).stdout.trim()
  if (head !== buildSha) {
    throw new Error(`Checked-out HEAD ${head} does not match requested Seed-and-Grow build ${buildSha}.`)
  }
  stage.governedPaths.forEach((relativePath) => {
    runGit(["cat-file", "-e", `${buildSha}:${relativePath}`])
  })
  if (runGit(["diff", "--quiet", buildSha, "--", ...stage.governedPaths], root, [0, 1]).exitCode !== 0) {
    throw new Error("Seed-and-Grow governed source differs from the requested committed SHA.")
  }
  const untracked = runGit(["ls-files", "--others", "--exclude-standard", "--", ...stage.governedPaths])
    .stdout.split(/\r?\n/)
    .filter(Boolean)
  if (untracked.length) {
    throw new Error(`Seed-and-Grow governed source contains uncommitted files: ${untracked.join(", ")}`)
  }
}

function pathIsInside(base: string, candidate: string) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export async function prepareRunDirectory(requested: string) {
  const runRoot = path.join(root, ".agent/runs/agent-company-seed-grow")
  await fs.mkdir(runRoot, { recursive: true })
  const runRootReal = await fs.realpath(runRoot)
  const output = path.resolve(requested)
  if (
    path.dirname(output) !== path.resolve(runRoot) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(path.basename(output)) ||
    !pathIsInside(runRoot, output)
  ) {
    throw new Error(`--out must be one direct run directory inside ${runRoot}.`)
  }
  const existing = await fs.lstat(output).catch(() => null)
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    throw new Error("Seed-and-Grow output must be a regular directory, never a symlink.")
  }
  if (existing && (await fs.readdir(output)).length) {
    throw new Error("Seed-and-Grow output directory must be absent or empty.")
  }
  await fs.mkdir(output, { recursive: true })
  const outputReal = await fs.realpath(output)
  if (!pathIsInside(runRootReal, outputReal)) {
    throw new Error("Seed-and-Grow output directory escaped the run root.")
  }
  return output
}

export async function resolveConfinedFile(base: string, relativePath: string) {
  if (!confinedRelativePath(relativePath)) return null
  const baseRealPath = await fs.realpath(base)
  const absolutePath = path.resolve(base, relativePath)
  if (!pathIsInside(base, absolutePath) || absolutePath === path.resolve(base)) return null
  const realPath = await fs.realpath(absolutePath).catch(() => null)
  const stat = await fs.lstat(absolutePath).catch(() => null)
  if (!realPath || !stat?.isFile() || stat.isSymbolicLink() || !pathIsInside(baseRealPath, realPath)) return null
  return realPath
}

export async function writeFileBinding(
  base: string,
  relativePath: string,
  value: string | Uint8Array,
  mediaType: string,
) {
  if (!confinedRelativePath(relativePath)) throw new Error(`Unsafe evidence path: ${relativePath}`)
  const file = path.join(base, relativePath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, value)
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  return {
    relativePath,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    mediaType,
  } satisfies FileBinding
}

export async function validateFileBinding(
  base: string,
  value: unknown,
  expectedMediaType: string,
  errors: string[],
  label: string,
) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["relativePath", "sha256", "byteLength", "mediaType"]) ||
    !confinedRelativePath(value.relativePath) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.byteLength !== "number" ||
    !Number.isInteger(value.byteLength) ||
    value.byteLength < 0 ||
    value.mediaType !== expectedMediaType
  ) {
    errors.push(`${label}: invalid file binding`)
    return null
  }
  const file = await resolveConfinedFile(base, value.relativePath)
  const bytes = file ? new Uint8Array(await Bun.file(file).arrayBuffer()) : null
  if (!file || !bytes || bytes.byteLength !== value.byteLength || sha256(bytes) !== value.sha256) {
    errors.push(`${label}: missing, escaped, or digest-mismatched file`)
    return null
  }
  return {
    file,
    bytes,
    source: new TextDecoder().decode(bytes),
  }
}

export function normalizeAutomaticPackage(value: unknown, requiredCommandIDs: string[]) {
  if (!isRecord(value) || !Array.isArray(value.commands) || !Array.isArray(value.coverage)) {
    throw new Error("Automatic evidence package cannot be normalized.")
  }
  const allCommands = value.commands.map((command) => {
    if (
      !isRecord(command) ||
      typeof command.id !== "string" ||
      !Array.isArray(command.argv) ||
      !Array.isArray(command.reports)
    ) {
      throw new Error("Automatic evidence command cannot be normalized.")
    }
    return {
      id: command.id,
      cwd: command.cwd,
      argv: command.argv,
      environment: command.environment,
      exitCode: command.exitCode,
      timedOut: command.timedOut,
      status: command.status,
      stdoutSummary: command.stdoutSummary,
      reports: command.reports.map((report) =>
        isRecord(report)
          ? {
              sourcePath: report.sourcePath,
              validator: report.validator,
              summary: report.summary,
            }
          : report,
      ),
    }
  })
  if (new Set(allCommands.map((command) => command.id)).size !== allCommands.length) {
    throw new Error("Automatic evidence command IDs are duplicated.")
  }
  const commands = allCommands.filter((command) => requiredCommandIDs.includes(command.id))
  if (!sameValues(commands.map((command) => command.id), requiredCommandIDs)) {
    throw new Error("Automatic evidence command coverage differs from the stage contract.")
  }
  return sha256(
    canonicalize({
      gate: value.gate,
      buildSha: value.buildSha,
      buildTreeSha: value.buildTreeSha,
      requirementsBinding: value.requirementsBinding,
      schemaBinding: value.schemaBinding,
      provenance: value.provenance,
      isolation: isRecord(value.isolation)
        ? {
            mode: value.isolation.mode,
            environment: value.isolation.environment,
            productionDataEnvironmentInherited: value.isolation.productionDataEnvironmentInherited,
            hostPermissionIsolation: value.isolation.hostPermissionIsolation,
            networkIsolation: value.isolation.networkIsolation,
            playwright: isRecord(value.isolation.playwright)
              ? {
                  mode: value.isolation.playwright.mode,
                  packageVersion: value.isolation.playwright.packageVersion,
                  browsersJsonSha256: value.isolation.playwright.browsersJsonSha256,
                }
              : value.isolation.playwright,
          }
        : value.isolation,
      commands,
      coverage: value.coverage,
      releaseCandidateScreenshotsPresent: value.releaseCandidateScreenshots !== null,
      releaseCandidateHR01StimuliPresent: value.releaseCandidateHR01Stimuli !== null,
      overallStatus: value.overallStatus,
    }),
  )
}

export function automaticPackageCreatedAt(value: unknown) {
  return isRecord(value) && typeof value.createdAt === "string" ? value.createdAt : null
}

export function stageCoverage(stage: StageDefinition) {
  return {
    taskIds: stage.taskIds,
    criteria: stage.criteria.map((criterion) => ({
      criterionId: criterion.id,
      evidenceRefs: criterion.evidenceRefs,
    })),
  }
}

export function sourceBinding(relativePath: string, source: string) {
  return {
    path: relativePath,
    sha256: sha256(source),
  }
}

export function isSensitiveEvidence(source: string) {
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
    /"(?:access_token|refresh_token|api_key|password)"\s*:\s*"[^"]{8,}"/i,
  ].some((pattern) => pattern.test(source))
}
