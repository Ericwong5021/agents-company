import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const benchmarkFile = path.join(root, "docs/product-design/experience-refactor/benchmark-scenarios.v1.json")
const recordContractFile = path.join(root, "docs/product-design/experience-refactor/benchmark-execution-record.v1.json")
const governedSourcePaths = [
  "package.json",
  "bun.lock",
  "packages/app",
  "packages/control-plane",
  ":(glob,exclude)packages/control-plane/.agentcompany-test-fixtures-*/**",
  ":(glob,exclude)packages/control-plane/.webui-*-home/data/*.db-shm",
  "packages/shared",
  "script/experience-benchmark.ts",
  "docs/product-design/experience-refactor",
]

type CriterionStatus = "pass" | "fail" | "not_evaluated" | "human_pending"
type FinalDecision = "pass" | "fail" | "blocked" | "human_pending"

export type Scenario = {
  id: string
  title: string
  seed: number
  runMode: string
  acceptanceCriteria: Array<{
    id: string
    statement: string
    evidence: string
  }>
  humanEvidenceRequired: string[]
}

export type BenchmarkContract = {
  schemaVersion: number
  id: string
  version: string
  dataIsolation: {
    productionDemoDataAllowed: boolean
    externalProviderRequired: boolean
    runDirectoryPattern: string
  }
  executionRecordRequiredFields: string[]
  scenarios: Scenario[]
}

export type RecordContract = {
  schemaVersion: number
  recordVersion: string
  additionalProperties: boolean
  required: string[]
  governance: {
    criterionStatuses: CriterionStatus[]
    finalDecisions: FinalDecision[]
    r0ExecutableScenarios: string[]
    deferredScenarios: Record<string, { gate: string; blockedByTasks: string[] }>
    humanResearchBindings: Record<string, string[]>
    r0CriterionTaskBindings: Record<string, string[]>
    r0CriterionEligibility: Record<
      string,
      {
        includedInGateDecision: boolean
        deferredToGate: string | null
      }
    >
    spotCheck: {
      rate: number
      rounding: "ceil"
      seed: number
      stratification: "at_least_one_executable_automated_scenario"
      unsignedStatus: "human_pending"
    }
    reproducibilityIgnoredFields: string[]
    runnerSuccessMeaning: string
  }
}

type Evidence = {
  id: string
  kind: "playwright" | "deferred_contract" | "human_policy" | "side_effect_audit"
  source: string
  sha256: string
  summary: string
}

type Artifact = {
  id: string
  relativePath: string
  sha256: string
  mediaType: "application/json"
  byteLength: number
  openCheck: {
    status: "pass" | "fail"
    checkedBy: "JSON.parse"
  }
}

type CriterionResult = {
  criterionId: string
  status: CriterionStatus
  evidenceIds: string[]
  failureReason: string | null
  humanEvidenceRequired: boolean
  gateEligibility: {
    gate: "R0"
    includedInGateDecision: boolean
    deferredToGate: string | null
    reason: string
  }
}

export type ExecutionRecord = {
  recordSchemaVersion: number
  scenarioId: string
  scenarioVersion: string
  scenarioDigest: string
  buildSha: string
  runId: string
  seed: number
  startedAt: string
  finishedAt: string
  stateTrace: Array<{
    sequence: number
    state: "scheduled" | "running" | "completed" | "failed" | "blocked" | "human_pending"
    evidenceIds: string[]
  }>
  sideEffectLedger: {
    mode: "measured_adapter" | "deferred_no_execution"
    auditArtifactId: string | null
    auditSha256: string | null
    network: {
      policy: "loopback-only" | "not_executed"
      externalAttemptCount: number
      observedLoopbackRequestCount: number
    }
    fakeControlPlane: {
      requestCount: number
    }
    isolatedRunTree: {
      writeEntryCount: number
    }
    productionCandidates: {
      snapshotCount: number
      changedCount: number
      contentsRead: false
    }
    serverNetworkBoundary: {
      browserFullyObserved: boolean
      serverEgressInstrumented: false
      failClosedControls: string[]
    }
  }
  artifacts: Artifact[]
  evidence: Evidence[]
  criterionResults: CriterionResult[]
  humanReview: {
    selected: boolean
    status: "not_selected" | "human_pending"
    selectionSeed: number
    selectionRank: number | null
  }
  finalDecision: FinalDecision
  failureReason: string | null
  eligibility: {
    gate: "R0"
    includedInGateDenominator: boolean
    reason: string
  }
  blockedByTasks: string[]
}

type PlaywrightTestResult = {
  title: string
  projectName: string
  status: string
  errors: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value)
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  if (!isRecord(value)) throw new Error("Canonical JSON contains an unsupported object.")
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`
}

export function sha256(value: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

export function normalizedEvidenceReproducibilityDigest(value: Record<string, unknown>) {
  return sha256(canonicalize({ ...value, runId: "<run-id>" }))
}

export function normalizedEvidenceSummary(value: Record<string, unknown>) {
  return `${Array.isArray(value.tests) ? value.tests.length : 0} tagged Playwright test projection(s), exit ${value.exitCode}; normalized evidence ${normalizedEvidenceReproducibilityDigest(value)}.`
}

function unique(values: string[]) {
  return [...new Set(values)].sort()
}

function runGit(args: string[], allowedExitCodes = [0]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
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

function assertBenchmarkContract(value: unknown): asserts value is BenchmarkContract {
  if (
    !isRecord(value) ||
    typeof value.schemaVersion !== "number" ||
    typeof value.id !== "string" ||
    typeof value.version !== "string" ||
    !isRecord(value.dataIsolation) ||
    typeof value.dataIsolation.productionDemoDataAllowed !== "boolean" ||
    typeof value.dataIsolation.externalProviderRequired !== "boolean" ||
    typeof value.dataIsolation.runDirectoryPattern !== "string" ||
    !Array.isArray(value.executionRecordRequiredFields) ||
    !value.executionRecordRequiredFields.every((item) => typeof item === "string") ||
    !Array.isArray(value.scenarios) ||
    !value.scenarios.every(
      (scenario) =>
        isRecord(scenario) &&
        typeof scenario.id === "string" &&
        typeof scenario.title === "string" &&
        typeof scenario.seed === "number" &&
        typeof scenario.runMode === "string" &&
        Array.isArray(scenario.acceptanceCriteria) &&
        scenario.acceptanceCriteria.every(
          (criterion) =>
            isRecord(criterion) &&
            typeof criterion.id === "string" &&
            typeof criterion.statement === "string" &&
            typeof criterion.evidence === "string",
        ) &&
        Array.isArray(scenario.humanEvidenceRequired) &&
        scenario.humanEvidenceRequired.every((item) => typeof item === "string"),
    )
  ) {
    throw new Error("Benchmark scenario contract is structurally invalid.")
  }
}

function assertRecordContract(value: unknown): asserts value is RecordContract {
  if (
    !isRecord(value) ||
    typeof value.schemaVersion !== "number" ||
    typeof value.recordVersion !== "string" ||
    typeof value.additionalProperties !== "boolean" ||
    !Array.isArray(value.required) ||
    !value.required.every((item) => typeof item === "string") ||
    !isRecord(value.governance) ||
    !Array.isArray(value.governance.criterionStatuses) ||
    !Array.isArray(value.governance.finalDecisions) ||
    !Array.isArray(value.governance.r0ExecutableScenarios) ||
    !isRecord(value.governance.deferredScenarios) ||
    !isRecord(value.governance.humanResearchBindings) ||
    !isRecord(value.governance.r0CriterionTaskBindings) ||
    !isRecord(value.governance.r0CriterionEligibility) ||
    !isRecord(value.governance.spotCheck) ||
    typeof value.governance.spotCheck.rate !== "number" ||
    value.governance.spotCheck.rounding !== "ceil" ||
    typeof value.governance.spotCheck.seed !== "number" ||
    value.governance.spotCheck.stratification !== "at_least_one_executable_automated_scenario" ||
    value.governance.spotCheck.unsignedStatus !== "human_pending" ||
    !Array.isArray(value.governance.reproducibilityIgnoredFields) ||
    typeof value.governance.runnerSuccessMeaning !== "string"
  ) {
    throw new Error("Benchmark execution record contract is structurally invalid.")
  }
}

export async function readBenchmarkContracts() {
  const benchmark: unknown = await Bun.file(benchmarkFile).json()
  const recordContract: unknown = await Bun.file(recordContractFile).json()
  assertBenchmarkContract(benchmark)
  assertRecordContract(recordContract)
  return {
    benchmark,
    recordContract,
  }
}

export function deterministicHumanReviewSelection(scenarios: Scenario[], contract: RecordContract) {
  const ranked = scenarios
    .map((scenario) => ({
      id: scenario.id,
      score: sha256(`${contract.governance.spotCheck.seed}:${scenario.id}:${scenario.seed}`),
    }))
    .sort((a, b) => a.score.localeCompare(b.score) || a.id.localeCompare(b.id))
  const count = Math.ceil(scenarios.length * contract.governance.spotCheck.rate)
  const executableAutomated = ranked.find((item) => {
    const scenario = scenarios.find((candidate) => candidate.id === item.id)
    return contract.governance.r0ExecutableScenarios.includes(item.id) && scenario?.humanEvidenceRequired.length === 0
  })
  if (!executableAutomated) throw new Error("Human review selection has no executable automated R0 scenario.")
  return {
    ids: [
      executableAutomated.id,
      ...ranked.filter((item) => item.id !== executableAutomated.id).map((item) => item.id),
    ].slice(0, count),
    rank: new Map(ranked.map((item, index) => [item.id, index + 1])),
  }
}

export function scenarioDigest(scenario: Scenario) {
  return sha256(canonicalize(scenario))
}

function criterionTag(criterionID: string) {
  return `@criterion-${criterionID.toLowerCase()}`
}

function humanCriterionID(scenarioID: string, index: number) {
  return `${scenarioID}-H${index + 1}`
}

function normalizeError(value: string, runDirectory: string) {
  return value
    .replaceAll(runDirectory, "<run-directory>")
    .replaceAll(root, "<repository>")
    .replace(/\/(?:private\/)?var\/folders\/[^\s:]+/g, "<system-temp>")
    .replace(/\b\d+(?:\.\d+)?ms\b/g, "<duration>")
}

function collectPlaywrightTests(value: unknown, runDirectory: string): PlaywrightTestResult[] {
  if (!isRecord(value)) return []
  const current = Array.isArray(value.specs)
    ? value.specs.flatMap((spec): PlaywrightTestResult[] => {
        if (!isRecord(spec) || typeof spec.title !== "string" || !Array.isArray(spec.tests)) return []
        return spec.tests.flatMap((test): PlaywrightTestResult[] => {
          if (!isRecord(test)) return []
          const results = Array.isArray(test.results) ? test.results.filter(isRecord) : []
          const finalResult = results.at(-1)
          const errors =
            finalResult && Array.isArray(finalResult.errors)
              ? finalResult.errors.flatMap((error) => {
                  if (!isRecord(error) || typeof error.message !== "string") return []
                  return [normalizeError(error.message, runDirectory)]
                })
              : []
          return [
            {
              title: spec.title,
              projectName: typeof test.projectName === "string" ? test.projectName : "unknown",
              status: finalResult && typeof finalResult.status === "string" ? finalResult.status : "not_run",
              errors,
            },
          ]
        })
      })
    : []
  const nested = Array.isArray(value.suites)
    ? value.suites.flatMap((suite) => collectPlaywrightTests(suite, runDirectory))
    : []
  return [...current, ...nested].sort(
    (a, b) => a.title.localeCompare(b.title) || a.projectName.localeCompare(b.projectName),
  )
}

function parsePlaywrightReport(source: string, runDirectory: string) {
  try {
    const report = JSON.parse(source) as unknown
    return {
      parsed: true,
      tests: collectPlaywrightTests(report, runDirectory),
      parseFailure: null,
    }
  } catch {
    return {
      parsed: false,
      tests: [] as PlaywrightTestResult[],
      parseFailure: "playwright_json_report_unparseable",
    }
  }
}

function filteredEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !/(?:^|_)(?:API_?KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD)(?:_|$)|^(?:AGENTCOMPANY|OPENAI|ANTHROPIC|GOOGLE|AZURE|AWS|GITHUB|SLACK)_/i.test(
          key,
        ),
    ),
  )
}

async function isolatedEnvironment(runDirectory: string, seed: number, auditID: string) {
  const isolated = {
    home: path.join(runDirectory, "home"),
    agentCompanyHome: path.join(runDirectory, "agent-company-home"),
    workspace: path.join(runDirectory, "workspace"),
    xdgData: path.join(runDirectory, "xdg", "data"),
    xdgCache: path.join(runDirectory, "xdg", "cache"),
    xdgConfig: path.join(runDirectory, "xdg", "config"),
    xdgState: path.join(runDirectory, "xdg", "state"),
    nuxtBuild: path.join(runDirectory, "nuxt"),
  }
  await Promise.all(Object.values(isolated).map((directory) => fs.mkdir(directory, { recursive: true })))
  const defaultBrowserCache =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
      : path.join(os.homedir(), ".cache", "ms-playwright")
  const browserCache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (await fs.stat(defaultBrowserCache).then(
      () => defaultBrowserCache,
      () => undefined,
    ))
  return {
    evidence: {
      home: "<run-directory>/home",
      agentCompanyHome: "<run-directory>/agent-company-home",
      workspace: "<run-directory>/workspace",
      xdgRoots: "<run-directory>/xdg/*",
      nuxtBuild: "<run-directory>/nuxt",
      productionDatabaseAvailableToAdapter: false,
      externalProviderCredentialsRemoved: true,
      providerMode: "in_repository_fake_control_plane",
      seed,
      browserRuntimeReadOnlyCache: browserCache ? "<playwright-browser-cache>" : null,
    },
    env: {
      ...filteredEnvironment(),
      HOME: isolated.home,
      USERPROFILE: isolated.home,
      AGENTCOMPANY_HOME: isolated.agentCompanyHome,
      AGENTCOMPANY_CONFIG_DIR: path.join(isolated.agentCompanyHome, "config"),
      AGENTCOMPANY_CONFIG: "",
      AGENTCOMPANY_CONFIG_CONTENT: "",
      AGENTCOMPANY_DB: path.join(isolated.agentCompanyHome, "data", "agent-company.db"),
      AGENTCOMPANY_BENCHMARK_WORKSPACE: isolated.workspace,
      AGENTCOMPANY_BENCHMARK_SEED: String(seed),
      XDG_DATA_HOME: isolated.xdgData,
      XDG_CACHE_HOME: isolated.xdgCache,
      XDG_CONFIG_HOME: isolated.xdgConfig,
      XDG_STATE_HOME: isolated.xdgState,
      NUXT_BUILD_DIR: isolated.nuxtBuild,
      PLAYWRIGHT_BROWSERS_PATH: browserCache,
      PLAYWRIGHT_JUNIT_OUTPUT: path.join(runDirectory, "playwright", "junit.xml"),
      PLAYWRIGHT_NETWORK_AUDIT_PATH: path.join(runDirectory, "network-audit.raw.json"),
      PLAYWRIGHT_FAKE_CP_AUDIT_PATH: path.join(runDirectory, "fake-control-plane-audit.raw.json"),
      PLAYWRIGHT_SIDE_EFFECT_AUDIT_ID: auditID,
      PLAYWRIGHT_APP_SERVER_COMMAND: "bun script/dev.ts",
      PLAYWRIGHT_REUSE_SERVER: "0",
      CI: "",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      http_proxy: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      all_proxy: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    },
  }
}

async function createArtifact(runDirectory: string, id: string, relativePath: string, payload: unknown) {
  if (path.isAbsolute(relativePath) || relativePath.split(path.sep).includes("..")) {
    throw new Error(`Artifact ${id} escaped the run directory.`)
  }
  const source = `${JSON.stringify(payload, null, 2)}\n`
  const artifactPath = path.join(runDirectory, relativePath)
  await Bun.write(artifactPath, source)
  const opened = await Bun.file(artifactPath).text()
  const openStatus = (() => {
    try {
      JSON.parse(opened)
      return "pass" as const
    } catch {
      return "fail" as const
    }
  })()
  return {
    artifact: {
      id,
      relativePath,
      sha256: sha256(opened),
      mediaType: "application/json",
      byteLength: new TextEncoder().encode(opened).byteLength,
      openCheck: {
        status: openStatus,
        checkedBy: "JSON.parse",
      },
    } satisfies Artifact,
    digest: sha256(opened),
  }
}

function deferredSideEffectLedger(): ExecutionRecord["sideEffectLedger"] {
  return {
    mode: "deferred_no_execution",
    auditArtifactId: null,
    auditSha256: null,
    network: {
      policy: "not_executed",
      externalAttemptCount: 0,
      observedLoopbackRequestCount: 0,
    },
    fakeControlPlane: {
      requestCount: 0,
    },
    isolatedRunTree: {
      writeEntryCount: 0,
    },
    productionCandidates: {
      snapshotCount: 0,
      changedCount: 0,
      contentsRead: false,
    },
    serverNetworkBoundary: {
      browserFullyObserved: false,
      serverEgressInstrumented: false,
      failClosedControls: [],
    },
  }
}

function selfTestMeasuredSideEffectLedger(digest: string): ExecutionRecord["sideEffectLedger"] {
  return {
    mode: "measured_adapter",
    auditArtifactId: "side-effect-audit",
    auditSha256: digest,
    network: {
      policy: "loopback-only",
      externalAttemptCount: 0,
      observedLoopbackRequestCount: 1,
    },
    fakeControlPlane: {
      requestCount: 1,
    },
    isolatedRunTree: {
      writeEntryCount: 1,
    },
    productionCandidates: {
      snapshotCount: 1,
      changedCount: 0,
      contentsRead: false,
    },
    serverNetworkBoundary: {
      browserFullyObserved: true,
      serverEgressInstrumented: false,
      failClosedControls: [
        "browser_http_and_websocket_loopback_only",
        "external_provider_credentials_removed",
        "fake_control_plane_only",
        "server_proxy_environment_points_to_closed_loopback_port",
      ],
    },
  }
}

function productionCandidatePaths() {
  const baseDirectories = unique(
    [
      process.env.AGENTCOMPANY_HOME,
      process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "agent-company") : undefined,
      process.env.XDG_CACHE_HOME ? path.join(process.env.XDG_CACHE_HOME, "agent-company") : undefined,
      process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "agent-company") : undefined,
      process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, "agent-company") : undefined,
      path.join(os.homedir(), "Library", "Application Support", "agent-company"),
      path.join(os.homedir(), "Library", "Caches", "agent-company"),
      path.join(os.homedir(), "Library", "Preferences", "agent-company"),
      path.join(os.homedir(), ".local", "share", "agent-company"),
      path.join(os.homedir(), ".local", "state", "agent-company"),
      path.join(os.homedir(), ".cache", "agent-company"),
      path.join(os.homedir(), ".config", "agent-company"),
    ]
      .filter((item): item is string => Boolean(item))
      .map((item) => path.resolve(item)),
  )
  return unique([
    ...baseDirectories,
    ...baseDirectories.flatMap((directory) => [
      path.join(directory, "agent-company.db"),
      path.join(directory, "agent-company.db-wal"),
      path.join(directory, "agent-company.db-shm"),
      path.join(directory, "data"),
      path.join(directory, "data", "agent-company.db"),
      path.join(directory, "data", "agent-company.db-wal"),
      path.join(directory, "data", "agent-company.db-shm"),
      path.join(directory, "config"),
      path.join(directory, "config", "provider-settings.json"),
      path.join(directory, "provider-settings.json"),
      path.join(directory, "workspace"),
    ]),
    ...[process.env.AGENTCOMPANY_DB, process.env.AGENTCOMPANY_CONFIG, process.env.AGENTCOMPANY_CONFIG_DIR]
      .filter((item): item is string => Boolean(item) && item !== ":memory:")
      .map((item) => path.resolve(root, item)),
  ])
}

async function statProductionCandidates(candidates: string[]) {
  return Promise.all(
    candidates.map(async (candidate) => {
      const stat = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      })
      return {
        pathSha256: sha256(candidate),
        exists: Boolean(stat),
        type: stat
          ? stat.isFile()
            ? "file"
            : stat.isDirectory()
              ? "directory"
              : stat.isSymbolicLink()
                ? "symbolic_link"
                : "other"
          : "missing",
        size: stat?.size ?? null,
        mtimeMs: stat ? Math.trunc(stat.mtimeMs) : null,
      }
    }),
  )
}

async function isolatedRunTree(runDirectory: string) {
  const visit = async (directory: string): Promise<Array<{ relativePath: string; type: string; size: number }>> =>
    (
      await Promise.all(
        (await fs.readdir(directory, { withFileTypes: true })).map(async (entry) => {
          const absolutePath = path.join(directory, entry.name)
          const relativePath = path.relative(runDirectory, absolutePath)
          const stat = await fs.lstat(absolutePath)
          if (entry.isDirectory()) {
            return [{ relativePath, type: "directory", size: stat.size }, ...(await visit(absolutePath))]
          }
          return [
            {
              relativePath,
              type: entry.isFile() ? "file" : entry.isSymbolicLink() ? "symbolic_link" : "other",
              size: stat.size,
            },
          ]
        }),
      )
    )
      .flat()
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return visit(runDirectory)
}

function normalizeNetworkEntry(value: unknown, runDirectory: string) {
  if (
    !isRecord(value) ||
    !["http", "websocket"].includes(String(value.protocol)) ||
    typeof value.method !== "string" ||
    typeof value.origin !== "string" ||
    typeof value.pathname !== "string" ||
    typeof value.resourceType !== "string"
  ) {
    throw new Error("Browser network audit contains an invalid request entry.")
  }
  return {
    protocol: value.protocol,
    method: value.method,
    origin: normalizeError(value.origin, runDirectory),
    pathname: normalizeError(value.pathname, runDirectory),
    resourceType: value.resourceType,
  }
}

async function readNetworkAudit(runDirectory: string, auditID: string) {
  const value: unknown = await Bun.file(path.join(runDirectory, "network-audit.raw.json")).json()
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.policy !== "loopback-only" ||
    value.sideEffectAuditId !== auditID ||
    !Number.isInteger(value.externalAttemptCount) ||
    !Array.isArray(value.scenarios)
  ) {
    throw new Error("Browser network audit is missing, malformed, or bound to another run.")
  }
  const scenarios = value.scenarios
    .map((scenario) => {
      if (
        !isRecord(scenario) ||
        typeof scenario.testId !== "string" ||
        typeof scenario.title !== "string" ||
        typeof scenario.retry !== "number" ||
        !Number.isInteger(scenario.externalAttemptCount) ||
        !Array.isArray(scenario.blockedExternal) ||
        !Array.isArray(scenario.observedLoopback)
      ) {
        throw new Error("Browser network audit contains an invalid scenario entry.")
      }
      return {
        testId: scenario.testId,
        title: scenario.title,
        retry: scenario.retry,
        status: typeof scenario.status === "string" ? scenario.status : null,
        externalAttemptCount: scenario.externalAttemptCount,
        blockedExternal: scenario.blockedExternal
          .map((entry) => normalizeNetworkEntry(entry, runDirectory))
          .sort((a, b) => canonicalize(a).localeCompare(canonicalize(b))),
        observedLoopback: scenario.observedLoopback
          .map((entry) => normalizeNetworkEntry(entry, runDirectory))
          .sort((a, b) => canonicalize(a).localeCompare(canonicalize(b))),
      }
    })
    .sort((a, b) => a.testId.localeCompare(b.testId) || a.retry - b.retry)
  const externalAttemptCount = scenarios.reduce((total, scenario) => total + scenario.externalAttemptCount, 0)
  const blockedExternalCount = scenarios.reduce((total, scenario) => total + scenario.blockedExternal.length, 0)
  if (value.externalAttemptCount !== externalAttemptCount || externalAttemptCount !== blockedExternalCount) {
    throw new Error("Browser network audit external-attempt totals are internally inconsistent.")
  }
  if (externalAttemptCount !== 0) {
    throw new Error(`Browser network audit recorded ${externalAttemptCount} external network attempt(s).`)
  }
  return {
    policy: "loopback-only" as const,
    externalAttemptCount,
    observedLoopbackRequestCount: scenarios.reduce((total, scenario) => total + scenario.observedLoopback.length, 0),
    scenarios,
  }
}

async function readFakeControlPlaneAudit(runDirectory: string, auditID: string) {
  const value: unknown = await Bun.file(path.join(runDirectory, "fake-control-plane-audit.raw.json")).json()
  if (!isRecord(value) || value.schemaVersion !== 1 || value.auditId !== auditID || !Array.isArray(value.requests)) {
    throw new Error("Fake Control Plane audit is missing, malformed, or bound to another run.")
  }
  const requests = value.requests.map((request) => {
    if (
      !isRecord(request) ||
      typeof request.method !== "string" ||
      typeof request.path !== "string" ||
      !request.path.startsWith("/") ||
      request.path.includes("?") ||
      request.path.includes("#")
    ) {
      throw new Error("Fake Control Plane audit contains a non-redacted request.")
    }
    return {
      method: request.method,
      path: request.path,
    }
  })
  const grouped = new Map<string, { method: string; path: string; occurrences: number }>()
  requests.forEach((request) => {
    const key = `${request.method}\0${request.path}`
    const current = grouped.get(key)
    grouped.set(key, {
      ...request,
      occurrences: (current?.occurrences ?? 0) + 1,
    })
  })
  return {
    requestCount: requests.length,
    requests: [...grouped.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
  }
}

async function measuredSideEffects(
  runDirectory: string,
  auditID: string,
  scenario: Scenario,
  buildSha: string,
  runID: string,
  productionCandidates: string[],
  productionBefore: Awaited<ReturnType<typeof statProductionCandidates>>,
) {
  const productionAfter = await statProductionCandidates(productionCandidates)
  const changedPathHashes = productionBefore
    .filter((before, index) => canonicalize(before) !== canonicalize(productionAfter[index]))
    .map((item) => item.pathSha256)
  if (changedPathHashes.length) {
    throw new Error(`Production candidate metadata changed during benchmark: ${changedPathHashes.join(",")}`)
  }
  const [network, fakeControlPlane, runTree] = await Promise.all([
    readNetworkAudit(runDirectory, auditID),
    readFakeControlPlaneAudit(runDirectory, auditID),
    isolatedRunTree(runDirectory),
  ])
  const serverNetworkBoundary = {
    browserFullyObserved: true,
    serverEgressInstrumented: false as const,
    failClosedControls: [
      "browser_http_and_websocket_loopback_only",
      "external_provider_credentials_removed",
      "fake_control_plane_only",
      "server_proxy_environment_points_to_closed_loopback_port",
    ],
  }
  const auditPayload = {
    schemaVersion: 1,
    auditId: auditID,
    scenarioId: scenario.id,
    buildSha,
    runId: runID,
    network,
    fakeControlPlane,
    isolatedRunTree: {
      capturedBeforeGovernanceArtifacts: true,
      writeEntryCount: runTree.length,
      entries: runTree,
    },
    productionCandidates: {
      snapshotCount: productionBefore.length,
      changedCount: changedPathHashes.length,
      changedPathHashes,
      contentsRead: false,
      before: productionBefore,
      after: productionAfter,
    },
    serverNetworkBoundary,
  }
  const artifact = await createArtifact(runDirectory, "side-effect-audit", "side-effect-audit.json", auditPayload)
  return {
    artifact,
    ledger: {
      mode: "measured_adapter",
      auditArtifactId: artifact.artifact.id,
      auditSha256: artifact.digest,
      network: {
        policy: network.policy,
        externalAttemptCount: network.externalAttemptCount,
        observedLoopbackRequestCount: network.observedLoopbackRequestCount,
      },
      fakeControlPlane: {
        requestCount: fakeControlPlane.requestCount,
      },
      isolatedRunTree: {
        writeEntryCount: runTree.length,
      },
      productionCandidates: {
        snapshotCount: productionBefore.length,
        changedCount: changedPathHashes.length,
        contentsRead: false as const,
      },
      serverNetworkBoundary,
    } satisfies ExecutionRecord["sideEffectLedger"],
  }
}

function expectedCriterionIDs(scenario: Scenario) {
  return [
    ...scenario.acceptanceCriteria.map((criterion) => criterion.id),
    ...scenario.humanEvidenceRequired.map((_, index) => humanCriterionID(scenario.id, index)),
  ]
}

function criterionGateEligibility(
  scenario: Scenario,
  criterionID: string,
  humanEvidenceRequired: boolean,
  contract: RecordContract,
): CriterionResult["gateEligibility"] {
  const deferredScenario = contract.governance.deferredScenarios[scenario.id]
  if (deferredScenario) {
    return {
      gate: "R0",
      includedInGateDecision: false,
      deferredToGate: deferredScenario.gate,
      reason: `The entire scenario is deferred to ${deferredScenario.gate}.`,
    }
  }
  if (humanEvidenceRequired) {
    return {
      gate: "R0",
      includedInGateDecision: true,
      deferredToGate: null,
      reason: "The scenario human criterion is an explicit R0 blocking requirement.",
    }
  }
  const eligibility = contract.governance.r0CriterionEligibility[criterionID]
  if (!eligibility) throw new Error(`Missing R0 criterion eligibility contract for ${criterionID}.`)
  return {
    gate: "R0",
    includedInGateDecision: eligibility.includedInGateDecision,
    deferredToGate: eligibility.deferredToGate,
    reason: eligibility.includedInGateDecision
      ? "This criterion is part of the R0 decision."
      : `This criterion is explicitly deferred to ${eligibility.deferredToGate}.`,
  }
}

export function validateExecutionRecord(
  record: ExecutionRecord,
  scenario: Scenario,
  benchmark: BenchmarkContract,
  contract: RecordContract,
  expectedBuildSha?: string,
) {
  const errors: string[] = []
  const check = (condition: boolean, message: string) => {
    if (!condition) errors.push(message)
  }
  const stateTrace = record.stateTrace ?? []
  const artifacts = record.artifacts ?? []
  const evidence = record.evidence ?? []
  const criterionResults = record.criterionResults ?? []
  const blockedByTasks = record.blockedByTasks ?? []
  const recordKeys = Object.keys(record).sort()
  check(
    contract.required.every((field) => field in record),
    `${record.scenarioId}/${record.runId}: required execution fields are missing.`,
  )
  check(
    contract.additionalProperties || recordKeys.every((key) => contract.required.includes(key)),
    `${record.scenarioId}/${record.runId}: unknown execution fields are forbidden.`,
  )
  check(record.recordSchemaVersion === contract.schemaVersion, `${record.scenarioId}: record schema version mismatch.`)
  check(record.scenarioId === scenario.id, `${record.scenarioId}: scenario ID mismatch.`)
  check(record.scenarioVersion === benchmark.version, `${record.scenarioId}: scenario version mismatch.`)
  check(record.scenarioDigest === scenarioDigest(scenario), `${record.scenarioId}: scenario digest mismatch.`)
  check(/^[a-f0-9]{40}$/.test(record.buildSha), `${record.scenarioId}: build SHA is not a full commit SHA.`)
  check(
    !expectedBuildSha || record.buildSha === expectedBuildSha,
    `${record.scenarioId}: build SHA does not match the requested commit.`,
  )
  check(/^run-(?:01|02)$/.test(record.runId), `${record.scenarioId}: run ID is invalid.`)
  check(record.seed === scenario.seed, `${record.scenarioId}: seed mismatch.`)
  check(
    Number.isFinite(Date.parse(record.startedAt)) &&
      Number.isFinite(Date.parse(record.finishedAt)) &&
      Date.parse(record.finishedAt) >= Date.parse(record.startedAt),
    `${record.scenarioId}: execution timestamps are invalid.`,
  )
  check(stateTrace.length >= 2, `${record.scenarioId}: state trace is incomplete.`)
  check(
    artifacts.every(
      (artifact) =>
        !path.isAbsolute(artifact.relativePath) &&
        !artifact.relativePath.split(path.sep).includes("..") &&
        /^[a-f0-9]{64}$/.test(artifact.sha256) &&
        artifact.openCheck.status === "pass",
    ),
    `${record.scenarioId}: artifact path, digest, or open check is invalid.`,
  )
  const evidenceIDs = new Set(evidence.map((item) => item.id))
  const artifactDigests = new Set(artifacts.map((item) => item.sha256))
  check(evidenceIDs.size === evidence.length, `${record.scenarioId}: evidence IDs are not unique.`)
  check(
    new Set(artifacts.map((item) => item.id)).size === artifacts.length,
    `${record.scenarioId}: artifact IDs are not unique.`,
  )
  check(
    evidence.every(
      (item) => evidenceIDs.has(item.id) && /^[a-f0-9]{64}$/.test(item.sha256) && artifactDigests.has(item.sha256),
    ),
    `${record.scenarioId}: evidence is not backed by a recorded artifact.`,
  )
  check(
    criterionResults.length === expectedCriterionIDs(scenario).length &&
      unique(criterionResults.map((item) => item.criterionId)).join(",") ===
        unique(expectedCriterionIDs(scenario)).join(","),
    `${record.scenarioId}: criterion result set does not match the scenario contract.`,
  )
  check(
    criterionResults.every(
      (item) =>
        contract.governance.criterionStatuses.includes(item.status) &&
        (item.status === "not_evaluated" ||
          (item.evidenceIds.length > 0 && item.evidenceIds.every((id) => evidenceIDs.has(id)))) &&
        (item.status !== "fail" || Boolean(item.failureReason)),
    ),
    `${record.scenarioId}: criterion status, evidence, or failure reason is invalid.`,
  )
  const deferred = contract.governance.deferredScenarios[scenario.id]
  check(
    criterionResults.every((item) => {
      const expected = criterionGateEligibility(scenario, item.criterionId, item.humanEvidenceRequired, contract)
      return (
        item.gateEligibility.gate === expected.gate &&
        item.gateEligibility.includedInGateDecision === expected.includedInGateDecision &&
        item.gateEligibility.deferredToGate === expected.deferredToGate &&
        Boolean(item.gateEligibility.reason)
      )
    }),
    `${record.scenarioId}: criterion-level R0 eligibility contradicts the governance contract.`,
  )
  check(
    criterionResults
      .filter((item) => !item.gateEligibility.includedInGateDecision)
      .every(
        (item) =>
          item.status === "not_evaluated" &&
          item.evidenceIds.length === 0 &&
          item.gateEligibility.deferredToGate !== null,
      ),
    `${record.scenarioId}: a deferred criterion was evaluated or allowed to affect R0.`,
  )
  check(
    stateTrace.every((item) => item.evidenceIds.every((id) => evidenceIDs.has(id))),
    `${record.scenarioId}: state trace references missing evidence.`,
  )
  const humanIDs = new Set(scenario.humanEvidenceRequired.map((_, index) => humanCriterionID(scenario.id, index)))
  check(
    criterionResults
      .filter((item) => humanIDs.has(item.criterionId))
      .every((item) => item.status === (deferred ? "not_evaluated" : "human_pending")),
    `${record.scenarioId}: human evidence was automated, passed, or assigned an invalid status.`,
  )
  const sideEffectLedger = record.sideEffectLedger
  const sideEffectArtifact = artifacts.find((artifact) => artifact.id === sideEffectLedger?.auditArtifactId)
  if (deferred) {
    check(
      sideEffectLedger?.mode === "deferred_no_execution" &&
        sideEffectLedger.auditArtifactId === null &&
        sideEffectLedger.auditSha256 === null &&
        sideEffectLedger.network.policy === "not_executed" &&
        sideEffectLedger.network.externalAttemptCount === 0 &&
        sideEffectLedger.network.observedLoopbackRequestCount === 0 &&
        sideEffectLedger.fakeControlPlane.requestCount === 0 &&
        sideEffectLedger.isolatedRunTree.writeEntryCount === 0 &&
        sideEffectLedger.productionCandidates.snapshotCount === 0 &&
        sideEffectLedger.productionCandidates.changedCount === 0 &&
        !sideEffectLedger.productionCandidates.contentsRead &&
        !sideEffectLedger.serverNetworkBoundary.browserFullyObserved &&
        !sideEffectLedger.serverNetworkBoundary.serverEgressInstrumented &&
        sideEffectLedger.serverNetworkBoundary.failClosedControls.length === 0,
      `${record.scenarioId}: deferred scenario fabricated a side-effect measurement.`,
    )
  } else {
    check(
      sideEffectLedger?.mode === "measured_adapter" &&
        sideEffectLedger.auditArtifactId === "side-effect-audit" &&
        /^[a-f0-9]{64}$/.test(sideEffectLedger.auditSha256 ?? "") &&
        sideEffectArtifact?.sha256 === sideEffectLedger.auditSha256 &&
        sideEffectLedger.network.policy === "loopback-only" &&
        sideEffectLedger.network.externalAttemptCount === 0 &&
        Number.isInteger(sideEffectLedger.network.observedLoopbackRequestCount) &&
        sideEffectLedger.network.observedLoopbackRequestCount > 0 &&
        Number.isInteger(sideEffectLedger.fakeControlPlane.requestCount) &&
        sideEffectLedger.fakeControlPlane.requestCount > 0 &&
        Number.isInteger(sideEffectLedger.isolatedRunTree.writeEntryCount) &&
        sideEffectLedger.isolatedRunTree.writeEntryCount > 0 &&
        Number.isInteger(sideEffectLedger.productionCandidates.snapshotCount) &&
        sideEffectLedger.productionCandidates.snapshotCount > 0 &&
        sideEffectLedger.productionCandidates.changedCount === 0 &&
        !sideEffectLedger.productionCandidates.contentsRead &&
        sideEffectLedger.serverNetworkBoundary.browserFullyObserved &&
        !sideEffectLedger.serverNetworkBoundary.serverEgressInstrumented &&
        sideEffectLedger.serverNetworkBoundary.failClosedControls.length >= 4 &&
        evidence.some((item) => item.kind === "side_effect_audit" && item.sha256 === sideEffectLedger.auditSha256),
      `${record.scenarioId}: measured side effects are missing, unbound, or unsafe.`,
    )
  }
  const gateCriterionResults = criterionResults.filter((item) => item.gateEligibility.includedInGateDecision)
  const failed = gateCriterionResults.filter((item) => item.status === "fail")
  const notEvaluated = gateCriterionResults.filter((item) => item.status === "not_evaluated")
  const humanPending = gateCriterionResults.filter((item) => item.status === "human_pending")
  const expectedDecision: FinalDecision = deferred
    ? "blocked"
    : failed.length
      ? "fail"
      : notEvaluated.length
        ? "blocked"
        : humanPending.length || record.humanReview?.selected
          ? "human_pending"
          : "pass"
  check(
    record.finalDecision === expectedDecision,
    `${record.scenarioId}: final decision contradicts criterion evidence.`,
  )
  check(
    record.humanReview?.status === (record.humanReview?.selected ? "human_pending" : "not_selected"),
    `${record.scenarioId}: deterministic human review status is invalid.`,
  )
  check(
    record.finalDecision === "pass"
      ? record.failureReason === null && blockedByTasks.length === 0
      : Boolean(record.failureReason) && blockedByTasks.length > 0,
    `${record.scenarioId}: final failure reason or blocking tasks are invalid.`,
  )
  if (deferred) {
    check(
      !record.eligibility?.includedInGateDenominator,
      `${record.scenarioId}: deferred scenario entered R0 denominator.`,
    )
    check(record.finalDecision === "blocked", `${record.scenarioId}: deferred scenario did not remain blocked.`)
    check(
      criterionResults.every((item) => item.status === "not_evaluated"),
      `${record.scenarioId}: deferred scenario contains evaluated criteria.`,
    )
    check(
      deferred.blockedByTasks.every((task) => blockedByTasks.includes(task)) &&
        record.failureReason?.startsWith("not_implemented_for_R0:") === true,
      `${record.scenarioId}: deferred scenario lacks explicit future gate or Task evidence.`,
    )
  } else {
    check(
      record.eligibility?.includedInGateDenominator,
      `${record.scenarioId}: R0 adapter was excluded from denominator.`,
    )
  }
  return errors
}

function sideEffectAuditBindingMatches(value: Record<string, unknown>, record: ExecutionRecord) {
  return (
    value.auditId ===
      `audit-${sha256(`${record.buildSha}:${record.scenarioId}:${record.seed}:${record.runId}`).slice(0, 32)}` &&
    value.scenarioId === record.scenarioId &&
    value.buildSha === record.buildSha &&
    value.runId === record.runId
  )
}

async function confinedArtifactPath(runDirectoryRealPath: string, relativePath: string) {
  const candidate = path.resolve(runDirectoryRealPath, relativePath)
  const lexicalRelative = path.relative(runDirectoryRealPath, candidate)
  if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) return null
  const realPath = await fs.realpath(candidate).catch(() => null)
  if (!realPath) return null
  const realRelative = path.relative(runDirectoryRealPath, realPath)
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) return null
  return realPath
}

function validateNormalizedEvidence(record: ExecutionRecord, artifact: Artifact | undefined, value: unknown) {
  if (record.sideEffectLedger.mode === "deferred_no_execution") return []
  const errors: string[] = []
  if (
    !artifact ||
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "adapter",
      "scenarioId",
      "buildSha",
      "runId",
      "command",
      "cwd",
      "exitCode",
      "reportParsed",
      "parseFailure",
      "stderr",
      "tests",
      "isolation",
    ]) ||
    value.schemaVersion !== 1 ||
    value.adapter !== "playwright" ||
    value.scenarioId !== record.scenarioId ||
    value.buildSha !== record.buildSha ||
    value.runId !== record.runId ||
    value.cwd !== "packages/app" ||
    !Number.isInteger(value.exitCode) ||
    typeof value.reportParsed !== "boolean" ||
    !(value.parseFailure === null || typeof value.parseFailure === "string") ||
    (value.reportParsed ? value.parseFailure !== null : value.parseFailure === null) ||
    typeof value.stderr !== "string" ||
    !Array.isArray(value.command) ||
    !value.command.every((item) => typeof item === "string") ||
    !Array.isArray(value.tests) ||
    !value.tests.every(
      (item) =>
        isRecord(item) &&
        exactKeys(item, ["title", "projectName", "status", "errors"]) &&
        typeof item.title === "string" &&
        typeof item.projectName === "string" &&
        typeof item.status === "string" &&
        Array.isArray(item.errors) &&
        item.errors.every((error) => typeof error === "string"),
    ) ||
    !isRecord(value.isolation)
  ) {
    return ["normalized-evidence: malformed or build/scenario/run binding mismatch"]
  }
  const expectedCommand = [
    "bun",
    "x",
    "playwright",
    "test",
    "--config",
    "playwright.config.ts",
    "--grep",
    `@scenario-${record.scenarioId.toLowerCase()}`,
    "--reporter=json",
    "--output",
    "<run-directory>/playwright",
  ]
  if (canonicalize(value.command) !== canonicalize(expectedCommand)) {
    errors.push("normalized-evidence: command is not bound to the scenario")
  }
  const playwrightEvidence = record.evidence.find((item) => item.id === "playwright-report")
  if (
    !playwrightEvidence ||
    playwrightEvidence.kind !== "playwright" ||
    playwrightEvidence.source !== `packages/app/e2e @scenario-${record.scenarioId.toLowerCase()}` ||
    playwrightEvidence.sha256 !== artifact.sha256
  ) {
    errors.push("normalized-evidence: playwright-report evidence digest is unbound")
  }
  const tests = value.tests as PlaywrightTestResult[]
  if (playwrightEvidence?.summary !== normalizedEvidenceSummary(value)) {
    errors.push("normalized-evidence: reproducibility summary is unbound")
  }
  record.criterionResults
    .filter((criterion) => criterion.gateEligibility.includedInGateDecision && !criterion.humanEvidenceRequired)
    .forEach((criterion) => {
      const taggedTests = tests.filter((test) => test.title.toLowerCase().includes(criterionTag(criterion.criterionId)))
      const expectedStatus: CriterionStatus =
        !value.reportParsed || !taggedTests.length
          ? "not_evaluated"
          : value.exitCode !== 0 || taggedTests.some((test) => test.status !== "passed")
            ? "fail"
            : "pass"
      if (criterion.status !== expectedStatus || !criterion.evidenceIds.includes("playwright-report")) {
        errors.push(
          `normalized-evidence: criterion ${criterion.criterionId} reports ${criterion.status} but evidence resolves to ${expectedStatus}`,
        )
      }
    })
  return errors
}

export async function validateArtifactFiles(record: ExecutionRecord, runDirectory: string) {
  const runDirectoryRealPath = await fs.realpath(runDirectory).catch(() => null)
  if (!runDirectoryRealPath) return ["artifacts: run directory is missing"]
  const inspected = await Promise.all(
    record.artifacts.map(async (artifact) => {
      if (
        !isRecord(artifact) ||
        !exactKeys(artifact, ["id", "relativePath", "sha256", "mediaType", "byteLength", "openCheck"]) ||
        typeof artifact.id !== "string" ||
        !artifact.id ||
        typeof artifact.relativePath !== "string" ||
        !artifact.relativePath ||
        typeof artifact.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        artifact.mediaType !== "application/json" ||
        !Number.isInteger(artifact.byteLength) ||
        artifact.byteLength < 1 ||
        !isRecord(artifact.openCheck) ||
        !exactKeys(artifact.openCheck, ["status", "checkedBy"]) ||
        artifact.openCheck.status !== "pass" ||
        artifact.openCheck.checkedBy !== "JSON.parse"
      ) {
        return {
          artifact,
          value: null,
          errors: [`${typeof artifact.id === "string" ? artifact.id : "artifact"}: malformed artifact contract`],
        }
      }
      const artifactPath = await confinedArtifactPath(runDirectoryRealPath, artifact.relativePath)
      if (!artifactPath) {
        return {
          artifact,
          value: null,
          errors: [`${artifact.id}: missing, escaped, or symlinked outside run directory`],
        }
      }
      const source = await Bun.file(artifactPath)
        .text()
        .catch(() => "")
      if (!source) return { artifact, value: null, errors: [`${artifact.id}: missing or empty`] }
      const parsed = await Promise.resolve()
        .then(() => JSON.parse(source) as unknown)
        .then(
          (value) => ({ valid: true, value }),
          () => ({ valid: false, value: null }),
        )
      return {
        artifact,
        value: parsed.value,
        errors: [
          sha256(source) !== artifact.sha256 ? `${artifact.id}: digest mismatch` : null,
          new TextEncoder().encode(source).byteLength !== artifact.byteLength
            ? `${artifact.id}: byte length mismatch`
            : null,
          artifact.mediaType !== "application/json" ? `${artifact.id}: media type mismatch` : null,
          !parsed.valid ? `${artifact.id}: open check failed` : null,
        ].filter((error): error is string => Boolean(error)),
      }
    }),
  )
  const audit = inspected.find((item) => item.artifact.id === record.sideEffectLedger.auditArtifactId)
  const auditBindingError = (() => {
    if (record.sideEffectLedger.mode === "deferred_no_execution") return null
    if (!audit) return "side-effect-audit: missing artifact binding"
    const value = audit.value
    if (
      !isRecord(value) ||
      !isRecord(value.network) ||
      !isRecord(value.fakeControlPlane) ||
      !isRecord(value.isolatedRunTree) ||
      !isRecord(value.productionCandidates) ||
      !isRecord(value.serverNetworkBoundary)
    ) {
      return "side-effect-audit: malformed measured audit"
    }
    if (!sideEffectAuditBindingMatches(value, record)) {
      return "side-effect-audit: build, scenario, run, or audit ID binding mismatch"
    }
    const matches =
      value.network.policy === record.sideEffectLedger.network.policy &&
      value.network.externalAttemptCount === record.sideEffectLedger.network.externalAttemptCount &&
      value.network.observedLoopbackRequestCount === record.sideEffectLedger.network.observedLoopbackRequestCount &&
      value.fakeControlPlane.requestCount === record.sideEffectLedger.fakeControlPlane.requestCount &&
      value.isolatedRunTree.writeEntryCount === record.sideEffectLedger.isolatedRunTree.writeEntryCount &&
      value.productionCandidates.snapshotCount === record.sideEffectLedger.productionCandidates.snapshotCount &&
      value.productionCandidates.changedCount === record.sideEffectLedger.productionCandidates.changedCount &&
      value.productionCandidates.contentsRead === record.sideEffectLedger.productionCandidates.contentsRead &&
      value.serverNetworkBoundary.browserFullyObserved ===
        record.sideEffectLedger.serverNetworkBoundary.browserFullyObserved &&
      value.serverNetworkBoundary.serverEgressInstrumented ===
        record.sideEffectLedger.serverNetworkBoundary.serverEgressInstrumented &&
      canonicalize(value.serverNetworkBoundary.failClosedControls) ===
        canonicalize(record.sideEffectLedger.serverNetworkBoundary.failClosedControls)
    return matches ? null : "side-effect-audit: ledger does not match measured audit"
  })()
  const normalizedEvidence = inspected.find((item) => item.artifact.id === "normalized-evidence")
  return [
    ...inspected.flatMap((item) => item.errors),
    auditBindingError,
    ...validateNormalizedEvidence(record, normalizedEvidence?.artifact, normalizedEvidence?.value),
  ].filter((error): error is string => Boolean(error))
}

export function normalizeExecutionRecord(record: ExecutionRecord) {
  const hasNormalizedEvidence = record.artifacts.some((artifact) => artifact.id === "normalized-evidence")
  return {
    ...record,
    runId: "<run-id>",
    startedAt: "<started-at>",
    finishedAt: "<finished-at>",
    sideEffectLedger:
      record.sideEffectLedger.mode === "measured_adapter"
        ? {
            ...record.sideEffectLedger,
            auditSha256: "<side-effect-audit-sha256>",
            fakeControlPlane: { requestCount: "<measured>" },
            isolatedRunTree: { writeEntryCount: "<measured>" },
          }
        : record.sideEffectLedger,
    artifacts: record.artifacts.map((artifact) => ({
      ...artifact,
      relativePath: `<artifact:${artifact.id}>`,
      sha256:
        artifact.id === "side-effect-audit"
          ? "<side-effect-audit-sha256>"
          : artifact.id === "normalized-evidence"
            ? "<normalized-evidence-sha256>"
            : artifact.sha256,
      byteLength:
        artifact.id === "side-effect-audit" || artifact.id === "normalized-evidence"
          ? "<measured>"
          : artifact.byteLength,
    })),
    evidence: record.evidence.map((item) => ({
      ...item,
      sha256:
        item.kind === "side_effect_audit"
          ? "<side-effect-audit-sha256>"
          : hasNormalizedEvidence && (item.id === "playwright-report" || item.id === "human-policy")
            ? "<normalized-evidence-sha256>"
            : item.sha256,
    })),
  }
}

function blockingTasksForCriteria(results: CriterionResult[], contract: RecordContract) {
  return unique(
    results
      .filter((result) => result.gateEligibility.includedInGateDecision && result.status !== "pass")
      .flatMap((result) => contract.governance.r0CriterionTaskBindings[result.criterionId] ?? []),
  )
}

async function runDeferredScenario(
  scenario: Scenario,
  benchmark: BenchmarkContract,
  contract: RecordContract,
  buildSha: string,
  runID: string,
  runDirectory: string,
  selectedForHumanReview: boolean,
  selectionRank: number | null,
  startedAt: string,
) {
  const deferred = contract.governance.deferredScenarios[scenario.id]
  if (!deferred) throw new Error(`${scenario.id} has no deferred governance contract.`)
  const criterionResults = expectedCriterionIDs(scenario).map((criterionId) => ({
    criterionId,
    status: "not_evaluated" as const,
    evidenceIds: [] as string[],
    failureReason: `not_implemented_for_R0:${deferred.blockedByTasks.join(",")};gate=${deferred.gate}`,
    humanEvidenceRequired: criterionId.includes("-H"),
    gateEligibility: criterionGateEligibility(scenario, criterionId, criterionId.includes("-H"), contract),
  }))
  return {
    recordSchemaVersion: contract.schemaVersion,
    scenarioId: scenario.id,
    scenarioVersion: benchmark.version,
    scenarioDigest: scenarioDigest(scenario),
    buildSha,
    runId: runID,
    seed: scenario.seed,
    startedAt,
    finishedAt: new Date().toISOString(),
    stateTrace: [
      { sequence: 1, state: "scheduled" as const, evidenceIds: [] },
      { sequence: 2, state: "blocked" as const, evidenceIds: [] },
    ],
    sideEffectLedger: deferredSideEffectLedger(),
    artifacts: [],
    evidence: [],
    criterionResults,
    humanReview: {
      selected: selectedForHumanReview,
      status: selectedForHumanReview ? ("human_pending" as const) : ("not_selected" as const),
      selectionSeed: contract.governance.spotCheck.seed,
      selectionRank,
    },
    finalDecision: "blocked" as const,
    failureReason: `not_implemented_for_R0:${deferred.blockedByTasks.join(",")};gate=${deferred.gate}`,
    eligibility: {
      gate: "R0" as const,
      includedInGateDenominator: false,
      reason: `Deferred to ${deferred.gate}; excluded from the R0 eligible denominator.`,
    },
    blockedByTasks: deferred.blockedByTasks,
  } satisfies ExecutionRecord
}

async function runR0PlaywrightScenario(
  scenario: Scenario,
  benchmark: BenchmarkContract,
  contract: RecordContract,
  buildSha: string,
  runID: string,
  runDirectory: string,
  selectedForHumanReview: boolean,
  selectionRank: number | null,
  startedAt: string,
) {
  const auditID = `audit-${sha256(`${buildSha}:${scenario.id}:${scenario.seed}:${runID}`).slice(0, 32)}`
  const productionCandidates = productionCandidatePaths()
  const productionBefore = await statProductionCandidates(productionCandidates)
  const isolation = await isolatedEnvironment(runDirectory, scenario.seed, auditID)
  const outputDirectory = path.join(runDirectory, "playwright")
  const command = [
    "bun",
    "x",
    "playwright",
    "test",
    "--config",
    "playwright.config.ts",
    "--grep",
    `@scenario-${scenario.id.toLowerCase()}`,
    "--reporter=json",
    "--output",
    outputDirectory,
  ]
  const result = Bun.spawnSync(command, {
    cwd: path.join(root, "packages/app"),
    env: isolation.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const report = parsePlaywrightReport(result.stdout.toString(), runDirectory)
  const sideEffects = await measuredSideEffects(
    runDirectory,
    auditID,
    scenario,
    buildSha,
    runID,
    productionCandidates,
    productionBefore,
  )
  const normalizedEvidence = {
    schemaVersion: 1,
    adapter: "playwright",
    scenarioId: scenario.id,
    buildSha,
    runId: runID,
    command: command.map((item) => (item === outputDirectory ? "<run-directory>/playwright" : item)),
    cwd: "packages/app",
    exitCode: result.exitCode,
    reportParsed: report.parsed,
    parseFailure: report.parseFailure,
    stderr: normalizeError(result.stderr.toString().trim(), runDirectory),
    tests: report.tests,
    isolation: isolation.evidence,
  }
  const artifact = await createArtifact(runDirectory, "normalized-evidence", "evidence.json", normalizedEvidence)
  const evidence: Evidence[] = [
    {
      id: "playwright-report",
      kind: "playwright",
      source: `packages/app/e2e @scenario-${scenario.id.toLowerCase()}`,
      sha256: artifact.digest,
      summary: normalizedEvidenceSummary(normalizedEvidence),
    },
    {
      id: "human-policy",
      kind: "human_policy",
      source: "benchmark-scenarios.v1.json",
      sha256: artifact.digest,
      summary: "Unsigned human evidence remains pending and cannot be replaced by automation.",
    },
    {
      id: "side-effect-audit-evidence",
      kind: "side_effect_audit",
      source: "side-effect-audit.json",
      sha256: sideEffects.artifact.digest,
      summary:
        "Browser external attempts, fake Control Plane requests, isolated writes, and production candidate metadata were measured.",
    },
  ]
  const automaticResults = scenario.acceptanceCriteria.map((criterion): CriterionResult => {
    const gateEligibility = criterionGateEligibility(scenario, criterion.id, false, contract)
    if (!gateEligibility.includedInGateDecision) {
      return {
        criterionId: criterion.id,
        status: "not_evaluated",
        evidenceIds: [],
        failureReason: `deferred_to_${gateEligibility.deferredToGate}:${contract.governance.r0CriterionTaskBindings[
          criterion.id
        ]?.join(",")}`,
        humanEvidenceRequired: false,
        gateEligibility,
      }
    }
    const tag = criterionTag(criterion.id)
    const tests = report.tests.filter((test) => test.title.toLowerCase().includes(tag))
    if (!tests.length) {
      return {
        criterionId: criterion.id,
        status: "not_evaluated",
        evidenceIds: ["playwright-report"],
        failureReason: `missing_executable_criterion_tag:${tag}`,
        humanEvidenceRequired: false,
        gateEligibility,
      }
    }
    const failures = tests.filter((test) => test.status !== "passed")
    if (result.exitCode !== 0 || failures.length) {
      return {
        criterionId: criterion.id,
        status: "fail",
        evidenceIds: ["playwright-report"],
        failureReason: `playwright_test_failed:${failures.map((test) => test.title).join("|") || `exit_${result.exitCode}`}`,
        humanEvidenceRequired: false,
        gateEligibility,
      }
    }
    return {
      criterionId: criterion.id,
      status: "pass",
      evidenceIds: ["playwright-report"],
      failureReason: null,
      humanEvidenceRequired: false,
      gateEligibility,
    }
  })
  const humanResults = scenario.humanEvidenceRequired.map(
    (_, index): CriterionResult => ({
      criterionId: humanCriterionID(scenario.id, index),
      status: "human_pending",
      evidenceIds: ["human-policy"],
      failureReason: "signed_human_evidence_missing",
      humanEvidenceRequired: true,
      gateEligibility: criterionGateEligibility(scenario, humanCriterionID(scenario.id, index), true, contract),
    }),
  )
  const criterionResults = [...automaticResults, ...humanResults]
  const gateCriterionResults = criterionResults.filter((item) => item.gateEligibility.includedInGateDecision)
  const failed = gateCriterionResults.filter((item) => item.status === "fail")
  const notEvaluated = gateCriterionResults.filter((item) => item.status === "not_evaluated")
  const humanPending = gateCriterionResults.filter((item) => item.status === "human_pending")
  const finalDecision: FinalDecision = failed.length
    ? "fail"
    : notEvaluated.length
      ? "blocked"
      : humanPending.length || selectedForHumanReview
        ? "human_pending"
        : "pass"
  const criterionTasks = blockingTasksForCriteria(criterionResults, contract)
  const blockedByTasks = unique([
    ...criterionTasks,
    ...(humanPending.length ? (contract.governance.humanResearchBindings[scenario.id] ?? ["FND-03"]) : []),
    ...(selectedForHumanReview ? ["FND-03"] : []),
  ])
  const failureReason =
    finalDecision === "pass"
      ? null
      : failed.length
        ? `criteria_failed:${failed.map((item) => item.criterionId).join(",")}`
        : notEvaluated.length
          ? `not_implemented_for_R0:${blockedByTasks.join(",")};criteria_not_evaluated=${notEvaluated
              .map((item) => item.criterionId)
              .join(",")}`
          : `human_evidence_pending:${blockedByTasks.join(",")}`
  return {
    recordSchemaVersion: contract.schemaVersion,
    scenarioId: scenario.id,
    scenarioVersion: benchmark.version,
    scenarioDigest: scenarioDigest(scenario),
    buildSha,
    runId: runID,
    seed: scenario.seed,
    startedAt,
    finishedAt: new Date().toISOString(),
    stateTrace: [
      { sequence: 1, state: "scheduled" as const, evidenceIds: [] },
      { sequence: 2, state: "running" as const, evidenceIds: [] },
      {
        sequence: 3,
        state:
          finalDecision === "pass"
            ? ("completed" as const)
            : finalDecision === "fail"
              ? ("failed" as const)
              : finalDecision,
        evidenceIds: ["playwright-report"],
      },
    ],
    sideEffectLedger: sideEffects.ledger,
    artifacts: [artifact.artifact, sideEffects.artifact.artifact],
    evidence,
    criterionResults,
    humanReview: {
      selected: selectedForHumanReview,
      status: selectedForHumanReview ? ("human_pending" as const) : ("not_selected" as const),
      selectionSeed: contract.governance.spotCheck.seed,
      selectionRank,
    },
    finalDecision,
    failureReason,
    eligibility: {
      gate: "R0" as const,
      includedInGateDenominator: true,
      reason: "R0 executable adapter; included regardless of pass, fail, blocked, or human-pending outcome.",
    },
    blockedByTasks,
  } satisfies ExecutionRecord
}

export function verifyExactCommit(ref: string) {
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error("--ref must be a full lowercase 40-character commit SHA.")
  const resolved = runGit(["rev-parse", `${ref}^{commit}`]).stdout.trim()
  if (resolved !== ref)
    throw new Error("--ref must identify the exact committed SHA, not a branch, tag, or abbreviation.")
  return resolved
}

function verifyCommittedSource(ref: string) {
  verifyExactCommit(ref)
  const head = runGit(["rev-parse", "HEAD^{commit}"]).stdout.trim()
  if (head !== ref) throw new Error(`Checked-out HEAD ${head} does not match requested build ${ref}.`)
  const requiredAtRef = [
    "script/experience-benchmark.ts",
    "docs/product-design/experience-refactor/benchmark-execution-record.v1.json",
    "docs/product-design/experience-refactor/benchmark-scenarios.v1.json",
    "packages/app/e2e/r0-shell.spec.ts",
    "packages/app/playwright.config.ts",
  ]
  requiredAtRef.forEach((file) => runGit(["cat-file", "-e", `${ref}:${file}`]))
  const tracked = runGit(["diff", "--quiet", ref, "--", ...governedSourcePaths], [0, 1])
  if (tracked.exitCode !== 0) throw new Error("Governed benchmark source differs from the requested committed SHA.")
  const untracked = runGit(["ls-files", "--others", "--exclude-standard", "--", ...governedSourcePaths])
    .stdout.split(/\r?\n/)
    .filter(Boolean)
  if (untracked.length) {
    throw new Error(`Governed benchmark source contains uncommitted files: ${untracked.join(", ")}`)
  }
}

function pathContains(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function prepareOutputDirectory(ref: string, requested: string) {
  const expected = path.join(root, ".artifacts", "experience-refactor", ref)
  if (path.resolve(requested) !== expected) {
    throw new Error(`--out must resolve exactly to ${expected}`)
  }
  const repositoryRealPath = await fs.realpath(root)
  const artifactsPath = path.join(root, ".artifacts")
  const artifactsRealPath = await fs.realpath(artifactsPath).catch(() => artifactsPath)
  if (!pathContains(repositoryRealPath, artifactsRealPath)) {
    throw new Error(".artifacts resolves outside the repository and cannot be used for isolated benchmark evidence.")
  }
  const productionRoots = unique(
    [
      process.env.AGENTCOMPANY_HOME,
      process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "agent-company") : undefined,
      process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "agent-company") : undefined,
      path.join(os.homedir(), "Library", "Application Support", "agent-company"),
      path.join(os.homedir(), ".local", "share", "agent-company"),
      path.join(os.homedir(), ".config", "agent-company"),
    ].filter((item): item is string => Boolean(item)),
  )
  if (productionRoots.some((item) => pathContains(item, expected) || pathContains(expected, item))) {
    throw new Error("--out overlaps a current user production data or workspace path.")
  }
  const exists = await fs.stat(expected).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
  if (exists) throw new Error(`Refusing to overwrite immutable benchmark evidence at ${expected}`)
  await fs.mkdir(expected, { recursive: true })
  const outputRealPath = await fs.realpath(expected)
  if (!pathContains(repositoryRealPath, outputRealPath)) {
    throw new Error("Created benchmark output escaped the repository.")
  }
  return expected
}

function parseArguments(args: string[]) {
  const allowed = new Set(["--ref", "--gate", "--all", "--out", "--repeat", "--require-pass-for"])
  const parsed = args.reduce(
    (state, item, index) => {
      if (!item.startsWith("--")) return state
      if (!allowed.has(item)) throw new Error(`Unknown argument: ${item}`)
      if (state.flags.has(item)) throw new Error(`Duplicate argument: ${item}`)
      state.flags.add(item)
      if (item !== "--all") state.values.set(item, args[index + 1] ?? "")
      return state
    },
    { flags: new Set<string>(), values: new Map<string, string>() },
  )
  const consumedValues = new Set(parsed.values.values())
  const stray = args.filter((item) => !item.startsWith("--") && !consumedValues.has(item))
  if (stray.length) throw new Error(`Unexpected positional argument: ${stray[0]}`)
  const required = ["--ref", "--gate", "--all", "--out", "--repeat"]
  if (required.some((flag) => !parsed.flags.has(flag))) {
    throw new Error("Required arguments: --ref <sha> --gate R0 --all --out <dir> --repeat 2")
  }
  if (parsed.values.get("--gate") !== "R0") throw new Error("This runner implements only --gate R0.")
  if (parsed.values.get("--repeat") !== "2") throw new Error("FND-03 requires exactly --repeat 2.")
  const requirePassFor = parsed.values.get("--require-pass-for")
  if (requirePassFor && requirePassFor !== "R0") throw new Error("--require-pass-for supports only R0.")
  return {
    ref: parsed.values.get("--ref") ?? "",
    out: parsed.values.get("--out") ?? "",
    requirePass: Boolean(requirePassFor),
  }
}

async function writeRecord(record: ExecutionRecord, runDirectory: string) {
  const recordPath = path.join(runDirectory, "execution-record.json")
  await Bun.write(recordPath, `${JSON.stringify(record, null, 2)}\n`)
  return recordPath
}

export async function runBenchmark(args: string[]) {
  const options = parseArguments(args)
  verifyCommittedSource(options.ref)
  const { benchmark, recordContract } = await readBenchmarkContracts()
  if (
    benchmark.dataIsolation.productionDemoDataAllowed ||
    benchmark.dataIsolation.externalProviderRequired ||
    benchmark.scenarios.length !== 12
  ) {
    throw new Error("Benchmark isolation or scenario contract is invalid.")
  }
  const out = await prepareOutputDirectory(options.ref, options.out)
  const selection = deterministicHumanReviewSelection(benchmark.scenarios, recordContract)
  const records = new Map<string, ExecutionRecord[]>()
  for (const scenario of benchmark.scenarios) {
    const scenarioRecords: ExecutionRecord[] = []
    await fs.mkdir(path.join(out, scenario.id), { recursive: false })
    for (const repeat of [1, 2]) {
      const runID = `run-${String(repeat).padStart(2, "0")}`
      const runDirectory = path.join(out, scenario.id, runID)
      await fs.mkdir(runDirectory, { recursive: false })
      const startedAt = new Date().toISOString()
      const selected = selection.ids.includes(scenario.id)
      const record = recordContract.governance.r0ExecutableScenarios.includes(scenario.id)
        ? await runR0PlaywrightScenario(
            scenario,
            benchmark,
            recordContract,
            options.ref,
            runID,
            runDirectory,
            selected,
            selection.rank.get(scenario.id) ?? null,
            startedAt,
          )
        : await runDeferredScenario(
            scenario,
            benchmark,
            recordContract,
            options.ref,
            runID,
            runDirectory,
            selected,
            selection.rank.get(scenario.id) ?? null,
            startedAt,
          )
      const errors = [
        ...validateExecutionRecord(record, scenario, benchmark, recordContract, options.ref),
        ...(await validateArtifactFiles(record, runDirectory)),
      ]
      if (errors.length) throw new Error(errors.join("\n"))
      await writeRecord(record, runDirectory)
      scenarioRecords.push(record)
    }
    records.set(scenario.id, scenarioRecords)
  }
  const reproducibility = benchmark.scenarios.map((scenario) => {
    const digests = (records.get(scenario.id) ?? []).map((record) =>
      sha256(canonicalize(normalizeExecutionRecord(record))),
    )
    return {
      scenarioId: scenario.id,
      normalizedDigests: digests,
      match: digests.length === 2 && digests[0] === digests[1],
    }
  })
  const allRecords = [...records.values()].flat()
  const eligibleRecords = allRecords.filter((record) => record.eligibility.includedInGateDenominator)
  const executionRecords = await Promise.all(
    allRecords.map(async (record) => {
      const relativePath = path.join(record.scenarioId, record.runId, "execution-record.json")
      const source = await Bun.file(path.join(out, relativePath)).text()
      return {
        scenarioId: record.scenarioId,
        runId: record.runId,
        relativePath,
        sha256: sha256(source),
      }
    }),
  )
  const result = {
    recordSchemaVersion: 1,
    buildSha: options.ref,
    gate: "R0",
    repeats: 2,
    runnerSuccessMeaning: recordContract.governance.runnerSuccessMeaning,
    ignoredForReproducibility: recordContract.governance.reproducibilityIgnoredFields,
    selectedForHumanReview: selection.ids,
    humanReviewSeed: recordContract.governance.spotCheck.seed,
    executionRecords,
    scenarios: reproducibility,
    reproducible: reproducibility.every((item) => item.match),
    scenarioDecisions: benchmark.scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      decisions: (records.get(scenario.id) ?? []).map((record) => record.finalDecision),
      eligibleForR0: (records.get(scenario.id) ?? []).every((record) => record.eligibility.includedInGateDenominator),
    })),
    r0ScenarioPass: eligibleRecords.length > 0 && eligibleRecords.every((record) => record.finalDecision === "pass"),
    runnerDecision: reproducibility.every((item) => item.match) ? "complete" : "reproducibility_failed",
  }
  await Bun.write(path.join(out, "reproducibility-record.json"), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
  if (!result.reproducible) process.exitCode = 1
  if (options.requirePass && !result.r0ScenarioPass) process.exitCode = 2
  return result
}

function selfTestRecord(scenario: Scenario, benchmark: BenchmarkContract, contract: RecordContract) {
  const deferred = contract.governance.deferredScenarios[scenario.id]
  const digest = "a".repeat(64)
  const automaticResults = scenario.acceptanceCriteria.map((criterion): CriterionResult => {
    const gateEligibility = criterionGateEligibility(scenario, criterion.id, false, contract)
    const evaluated = gateEligibility.includedInGateDecision
    return {
      criterionId: criterion.id,
      status: evaluated ? "pass" : "not_evaluated",
      evidenceIds: evaluated ? ["self-test-evidence"] : [],
      failureReason: evaluated
        ? null
        : deferred
          ? `not_implemented_for_R0:${deferred.blockedByTasks.join(",")};gate=${deferred.gate}`
          : `deferred_to_${gateEligibility.deferredToGate}`,
      humanEvidenceRequired: false,
      gateEligibility,
    }
  })
  const humanResults = scenario.humanEvidenceRequired.map(
    (_, index): CriterionResult => ({
      criterionId: humanCriterionID(scenario.id, index),
      status: deferred ? "not_evaluated" : "human_pending",
      evidenceIds: deferred ? [] : ["self-test-evidence"],
      failureReason: deferred
        ? `not_implemented_for_R0:${deferred.blockedByTasks.join(",")};gate=${deferred.gate}`
        : "missing",
      humanEvidenceRequired: true,
      gateEligibility: criterionGateEligibility(scenario, humanCriterionID(scenario.id, index), true, contract),
    }),
  )
  const humanPending = humanResults.some((item) => item.status === "human_pending")
  const finalDecision: FinalDecision = deferred ? "blocked" : humanPending ? "human_pending" : "pass"
  const blockedByTasks =
    deferred?.blockedByTasks ??
    (humanPending ? (contract.governance.humanResearchBindings[scenario.id] ?? ["FND-03"]) : [])
  return {
    recordSchemaVersion: contract.schemaVersion,
    scenarioId: scenario.id,
    scenarioVersion: benchmark.version,
    scenarioDigest: scenarioDigest(scenario),
    buildSha: "b".repeat(40),
    runId: "run-01",
    seed: scenario.seed,
    startedAt: "2026-07-25T00:00:00.000Z",
    finishedAt: "2026-07-25T00:00:01.000Z",
    stateTrace: [
      { sequence: 1, state: "scheduled" as const, evidenceIds: [] },
      {
        sequence: 2,
        state: deferred ? ("blocked" as const) : finalDecision,
        evidenceIds: deferred ? [] : ["self-test-evidence"],
      },
    ],
    sideEffectLedger: deferred ? deferredSideEffectLedger() : selfTestMeasuredSideEffectLedger(digest),
    artifacts: deferred
      ? []
      : [
          {
            id: "self-test-artifact",
            relativePath: "evidence.json",
            sha256: digest,
            mediaType: "application/json" as const,
            byteLength: 2,
            openCheck: { status: "pass" as const, checkedBy: "JSON.parse" as const },
          },
          {
            id: "side-effect-audit",
            relativePath: "side-effect-audit.json",
            sha256: digest,
            mediaType: "application/json" as const,
            byteLength: 2,
            openCheck: { status: "pass" as const, checkedBy: "JSON.parse" as const },
          },
        ],
    evidence: deferred
      ? []
      : [
          {
            id: "self-test-evidence",
            kind: "playwright" as const,
            source: "self-test",
            sha256: digest,
            summary: "self-test",
          },
          {
            id: "side-effect-audit-evidence",
            kind: "side_effect_audit" as const,
            source: "self-test",
            sha256: digest,
            summary: "self-test",
          },
        ],
    criterionResults: [...automaticResults, ...humanResults],
    humanReview: {
      selected: false,
      status: "not_selected" as const,
      selectionSeed: contract.governance.spotCheck.seed,
      selectionRank: null,
    },
    finalDecision,
    failureReason:
      finalDecision === "pass"
        ? null
        : deferred
          ? `not_implemented_for_R0:${deferred.blockedByTasks.join(",")};gate=${deferred.gate}`
          : `human_evidence_pending:${blockedByTasks.join(",")}`,
    eligibility: {
      gate: "R0" as const,
      includedInGateDenominator: !deferred,
      reason: deferred ? `Deferred to ${deferred.gate}.` : "R0 executable adapter.",
    },
    blockedByTasks,
  } satisfies ExecutionRecord
}

export async function runBenchmarkSelfTest() {
  const { benchmark, recordContract } = await readBenchmarkContracts()
  const requiredFieldsCovered = benchmark.executionRecordRequiredFields.every((field) =>
    recordContract.required.includes(field),
  )
  if (!requiredFieldsCovered) throw new Error("Versioned record schema dropped a benchmark-required field.")
  const selection = deterministicHumanReviewSelection(benchmark.scenarios, recordContract)
  if (selection.ids.length !== Math.ceil(benchmark.scenarios.length * recordContract.governance.spotCheck.rate)) {
    throw new Error("Deterministic 20% human review selection has the wrong size.")
  }
  if (!selection.ids.includes("S05")) {
    throw new Error("Deterministic human review selection omitted the executable automated R0 scenario.")
  }
  const syntheticPlaywright = parsePlaywrightReport(
    JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: "@scenario-s05 @criterion-s05-c1 synthetic adapter",
              tests: [{ projectName: "chromium", results: [{ status: "passed", errors: [] }] }],
            },
          ],
        },
      ],
    }),
    "/isolated/run",
  )
  if (
    !syntheticPlaywright.parsed ||
    syntheticPlaywright.tests.length !== 1 ||
    syntheticPlaywright.tests[0]?.status !== "passed"
  ) {
    throw new Error("Playwright adapter normalization self-test failed.")
  }
  const s05 = benchmark.scenarios.find((scenario) => scenario.id === "S05")
  const s12 = benchmark.scenarios.find((scenario) => scenario.id === "S12")
  const s01 = benchmark.scenarios.find((scenario) => scenario.id === "S01")
  if (!s05 || !s12 || !s01) throw new Error("Self-test scenarios are missing.")
  const validPass = selfTestRecord(s05, benchmark, recordContract)
  const validHumanPending = selfTestRecord(s12, benchmark, recordContract)
  const validDeferred = selfTestRecord(s01, benchmark, recordContract)
  if (validateExecutionRecord(validPass, s05, benchmark, recordContract).length) {
    throw new Error("Valid automated execution record failed validation.")
  }
  if (validateExecutionRecord(validHumanPending, s12, benchmark, recordContract).length) {
    throw new Error("Valid human-pending execution record failed validation.")
  }
  const validS12DeferredCriterion = validHumanPending.criterionResults.find((item) => item.criterionId === "S12-C3")
  if (
    validHumanPending.finalDecision !== "human_pending" ||
    validS12DeferredCriterion?.status !== "not_evaluated" ||
    validS12DeferredCriterion.gateEligibility.includedInGateDecision
  ) {
    throw new Error("S12-C3 incorrectly affected the R0 scenario decision.")
  }
  if (validateExecutionRecord(validDeferred, s01, benchmark, recordContract).length) {
    throw new Error("Valid deferred execution record failed validation.")
  }
  const missingEvidence = structuredClone(validPass)
  missingEvidence.criterionResults[0]!.evidenceIds = []
  const forgedDeferredPass = structuredClone(validDeferred)
  forgedDeferredPass.criterionResults.forEach((item) => {
    item.status = "pass"
    item.evidenceIds = ["self-test-evidence"]
    item.failureReason = null
  })
  forgedDeferredPass.finalDecision = "pass"
  forgedDeferredPass.failureReason = null
  forgedDeferredPass.blockedByTasks = []
  forgedDeferredPass.eligibility.includedInGateDenominator = true
  const automatedHumanPass = structuredClone(validHumanPending)
  const humanResult = automatedHumanPass.criterionResults.find((item) => item.humanEvidenceRequired)
  if (!humanResult) throw new Error("Human criterion self-test fixture is missing.")
  humanResult.status = "pass"
  humanResult.failureReason = null
  automatedHumanPass.finalDecision = "pass"
  automatedHumanPass.failureReason = null
  automatedHumanPass.blockedByTasks = []
  const forgedS12C3Pass = structuredClone(validHumanPending)
  const deferredS12Criterion = forgedS12C3Pass.criterionResults.find((item) => item.criterionId === "S12-C3")
  if (!deferredS12Criterion) throw new Error("S12-C3 self-test fixture is missing.")
  deferredS12Criterion.status = "pass"
  deferredS12Criterion.evidenceIds = ["self-test-evidence"]
  deferredS12Criterion.failureReason = null
  const missingRequired = structuredClone(validPass)
  Reflect.deleteProperty(missingRequired, "evidence")
  const forgedExternalAttempt = structuredClone(validPass)
  forgedExternalAttempt.sideEffectLedger.network.externalAttemptCount = 1
  const unboundSideEffectAudit = structuredClone(validPass)
  unboundSideEffectAudit.sideEffectLedger.auditSha256 = "c".repeat(64)
  const secondRunForAuditBinding = structuredClone(validPass)
  secondRunForAuditBinding.runId = "run-02"
  const normalizedEvidence = {
    schemaVersion: 1,
    adapter: "playwright",
    scenarioId: "S05",
    buildSha: "b".repeat(40),
    runId: "run-01",
    command: ["bun", "x", "playwright", "test"],
    cwd: "packages/app",
    exitCode: 0,
    reportParsed: true,
    parseFailure: null,
    stderr: "",
    tests: [
      {
        title: "@scenario-s05 @criterion-s05-c1 semantic evidence",
        projectName: "chromium",
        status: "passed",
        errors: [],
      },
    ],
    isolation: { home: "<run-directory>/home" },
  }
  const repeatedNormalizedEvidence = { ...normalizedEvidence, runId: "run-02" }
  const changedNormalizedEvidence = {
    ...repeatedNormalizedEvidence,
    tests: normalizedEvidence.tests.map((item) => ({ ...item, title: `${item.title} changed` })),
  }
  const normalizedEvidenceRecord = structuredClone(validPass)
  normalizedEvidenceRecord.artifacts[0]!.id = "normalized-evidence"
  normalizedEvidenceRecord.evidence[0]!.id = "playwright-report"
  normalizedEvidenceRecord.evidence[0]!.summary = normalizedEvidenceSummary(normalizedEvidence)
  const repeatedNormalizedEvidenceRecord = structuredClone(normalizedEvidenceRecord)
  repeatedNormalizedEvidenceRecord.runId = "run-02"
  repeatedNormalizedEvidenceRecord.evidence[0]!.summary = normalizedEvidenceSummary(repeatedNormalizedEvidence)
  const changedNormalizedEvidenceRecord = structuredClone(repeatedNormalizedEvidenceRecord)
  changedNormalizedEvidenceRecord.evidence[0]!.summary = normalizedEvidenceSummary(changedNormalizedEvidence)
  const firstRunAuditBinding = {
    auditId: `audit-${sha256(
      `${validPass.buildSha}:${validPass.scenarioId}:${validPass.seed}:${validPass.runId}`,
    ).slice(0, 32)}`,
    scenarioId: validPass.scenarioId,
    buildSha: validPass.buildSha,
    runId: validPass.runId,
  }
  const assertions = [
    {
      name: "missing_evidence_rejected",
      passed: validateExecutionRecord(missingEvidence, s05, benchmark, recordContract).length > 0,
    },
    {
      name: "deferred_pass_rejected",
      passed: validateExecutionRecord(forgedDeferredPass, s01, benchmark, recordContract).length > 0,
    },
    {
      name: "automated_human_pass_rejected",
      passed: validateExecutionRecord(automatedHumanPass, s12, benchmark, recordContract).length > 0,
    },
    {
      name: "deferred_s12_c3_pass_rejected",
      passed: validateExecutionRecord(forgedS12C3Pass, s12, benchmark, recordContract).length > 0,
    },
    {
      name: "missing_required_field_rejected",
      passed: validateExecutionRecord(missingRequired, s05, benchmark, recordContract).length > 0,
    },
    {
      name: "mismatched_committed_sha_rejected",
      passed: validateExecutionRecord(validPass, s05, benchmark, recordContract, "c".repeat(40)).length > 0,
    },
    {
      name: "external_network_attempt_rejected",
      passed: validateExecutionRecord(forgedExternalAttempt, s05, benchmark, recordContract).length > 0,
    },
    {
      name: "unbound_side_effect_audit_rejected",
      passed: validateExecutionRecord(unboundSideEffectAudit, s05, benchmark, recordContract).length > 0,
    },
    {
      name: "cross_run_side_effect_audit_rejected",
      passed: !sideEffectAuditBindingMatches(firstRunAuditBinding, secondRunForAuditBinding),
    },
    {
      name: "normalized_evidence_content_change_detected",
      passed:
        sha256(canonicalize(normalizeExecutionRecord(normalizedEvidenceRecord))) ===
          sha256(canonicalize(normalizeExecutionRecord(repeatedNormalizedEvidenceRecord))) &&
        sha256(canonicalize(normalizeExecutionRecord(normalizedEvidenceRecord))) !==
          sha256(canonicalize(normalizeExecutionRecord(changedNormalizedEvidenceRecord))),
    },
  ]
  if (assertions.some((assertion) => !assertion.passed))
    throw new Error("Benchmark validator negative self-test failed.")
  const repeat = structuredClone(validPass)
  repeat.runId = "run-02"
  repeat.startedAt = "2026-07-25T01:00:00.000Z"
  repeat.finishedAt = "2026-07-25T01:00:01.000Z"
  repeat.artifacts[0]!.relativePath = "other-run/evidence.json"
  const reproducible =
    sha256(canonicalize(normalizeExecutionRecord(validPass))) === sha256(canonicalize(normalizeExecutionRecord(repeat)))
  if (!reproducible) throw new Error("Reproducibility normalization self-test failed.")
  return {
    result: "pass",
    scenarios: benchmark.scenarios.length,
    requiredFields: recordContract.required.length,
    criterionStatuses: recordContract.governance.criterionStatuses,
    selectedForHumanReview: selection.ids,
    humanReviewSeed: recordContract.governance.spotCheck.seed,
    playwrightAdapterNormalization: "pass",
    reproducibilityNormalization: "pass",
    negativeCases: assertions,
  }
}

if (import.meta.main) {
  if (Bun.argv.includes("--self-test")) {
    console.log(JSON.stringify(await runBenchmarkSelfTest(), null, 2))
  } else {
    await runBenchmark(Bun.argv.slice(2))
  }
}
