import { createHash, randomUUID } from "node:crypto"
import { cp, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database as SQLiteDatabase } from "bun:sqlite"
import {
  MetricContract,
  MetricEvaluationReport,
  PrePublicCandidateMetricIds,
  PrePublicScenarioMetricIds,
  PrePublicMetricContractSha256,
  metricContractDigest,
} from "@agents-company/shared/seed-grow-metrics"
import {
  RolloutPromotionDecision,
  RolloutPromotionEvaluationRequest,
  RolloutStatus,
  RolloutTransitionRequest,
  RolloutTransitionResult,
} from "@agents-company/shared/rollout"
import { ShadowComparisonReport } from "@agents-company/shared/seed-grow-shadow"
import { Effect } from "effect"
import z from "zod"
import {
  PersistedFactArtifact,
  bindPersistedFactArtifact,
  makePersistedFactArtifactAdapterFromArtifact,
} from "../src/metrics/persisted-fact-artifact"
import { B5ScenarioIds, B5StrategyOrder, B5RunBinding, exactB5RunBindings } from "../src/metrics/b5-candidate-scenarios"
import {
  B5CandidateAttemptSummary,
  B5RollbackObservation,
  B5ScenarioObservationReport,
  b5CanonicalNormalizedResultSha256,
} from "./produce-seed-grow-candidate-facts"
import { Service, makeLayer } from "../src/metrics/seed-grow-reporter"

export type GateStatus = "pass" | "failed" | "blocked" | "invalid"

export class PrePublicGateError extends Error {
  readonly status: Exclude<GateStatus, "pass">

  constructor(status: Exclude<GateStatus, "pass">, message: string) {
    super(message)
    this.name = "PrePublicGateError"
    this.status = status
  }
}

const root = path.resolve(import.meta.dir, "../../..")
const trustedGitSearchPath = (
  process.platform === "win32"
    ? ["C:\\Program Files\\Git\\cmd", "C:\\Windows\\System32"]
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
).join(path.delimiter)
const gitExecutable =
  Bun.which("git", { PATH: trustedGitSearchPath }) ??
  (() => {
    throw new Error("A system Git executable is required for the Pre-Public gate.")
  })()
const trustedExecutablePath = [
  path.dirname(process.execPath),
  path.dirname(gitExecutable),
  ...trustedGitSearchPath.split(path.delimiter),
]
  .filter((value, index, values) => values.indexOf(value) === index)
  .join(path.delimiter)
const stageIDs = ["A0", "A1", "A2", "A3", "A4", "B0", "B1", "B2", "B3", "B4", "B5"] as const
type StageID = (typeof stageIDs)[number]
type Governance = {
  buildTreeSha: string
  metricSource: string
  metricSha256: string
  automaticCommandIDs: string[]
}
const runnerPath = "packages/control-plane/script/seed-grow-pre-public-gate.ts"
const b5CommandId = "b5-candidate-facts"
const deploymentCommandId = "seed-grow-real-surfaces"
const physicalIdentityKeys = ["worktree", "runtimeHome", "database", "output", "isolationRoot"] as const
const b5ReportRoot = ".artifacts/seed-grow-b5/real-candidate-facts"
const deploymentReportPath = "packages/app/.artifacts/seed-grow-b4/result.json"
const b5ReportSourcePaths = [
  "facts.json",
  "summary.json",
  "metric-report.json",
  "shadow-report.json",
  "rollback-kill-switch.json",
  "rollback-legacy-fallback.json",
  ...B5ScenarioIds.flatMap((scenarioId) => B5StrategyOrder.map((strategy) => `reports/${scenarioId}-${strategy}.json`)),
].map((relativePath) => `${b5ReportRoot}/${relativePath}`)
const runtimeBindingPaths = [
  runnerPath,
  "script/experience-automatic-evidence.ts",
  "script/experience-benchmark.ts",
  "script/seed-grow-stage-evidence.ts",
  "script/seed-grow-stage-gate.ts",
  "script/seed-grow-stage-core.ts",
  "script/seed-grow-real-surfaces.ts",
  "script/validate-seed-grow-b4-artifacts.ts",
  "packages/control-plane/script/produce-seed-grow-candidate-facts.ts",
  "packages/control-plane/script/b5-candidate-recovery-child.ts",
  "packages/control-plane/src/metrics/b5-candidate-recovery.ts",
  "packages/control-plane/src/metrics/b5-candidate-scenarios.ts",
  "packages/control-plane/src/metrics/persisted-fact-artifact.ts",
  "packages/control-plane/src/metrics/persisted-fact-exporter.ts",
  "packages/control-plane/src/metrics/seed-grow-reporter.ts",
  "packages/shared/src/seed-grow-metrics.ts",
  "packages/shared/src/seed-grow-shadow.ts",
  "docs/product-design/experience-refactor/automatic-evidence-package.v1.json",
  "docs/product-design/experience-refactor/automatic-evidence-requirements.v1.json",
  "docs/product-design/experience-refactor/seed-grow-benchmark-scenarios.v1.json",
  "docs/product-design/experience-refactor/seed-grow-stage-contract.v1.json",
  "docs/product-design/experience-refactor/seed-grow-stage-evidence.v1.json",
  "docs/product-design/experience-refactor/metric-contract.v1.json",
] as const
const verifierOwnedPath = (relativePath: string) =>
  relativePath === "bun.lock" ||
  relativePath === "package.json" ||
  relativePath === ".gitattributes" ||
  relativePath === ".gitmodules" ||
  relativePath.endsWith("/package.json") ||
  relativePath === "docs/AgentCompany-Seed-and-Grow-Development-Plan-v1.0.md" ||
  relativePath.startsWith("docs/product-design/experience-refactor/") ||
  /(^|\/)(scripts?|tests?|e2e|fixtures?|snapshots?)(\/|$)/.test(relativePath) ||
  /(^|\/)[^/]+\.(test|spec)\.[^/]+$/.test(relativePath) ||
  /(^|\/)bunfig\.toml$/.test(relativePath) ||
  /(^|\/)\.(eslint|oxlint|prettier)[^/]*$/.test(relativePath) ||
  /(^|\/)[^/]+\.config\.(cjs|js|json|mjs|ts)$/.test(relativePath) ||
  /(^|\/)(eslint|oxlint|playwright|vitest|tsconfig)[^/]*\.(cjs|js|json|mjs|ts)$/.test(relativePath)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const commitSha = z.string().regex(/^[a-f0-9]{40}$/)
const identifier = z.string().trim().min(1).max(240)
const absolutePath = z.string().refine((value) => path.isAbsolute(value))
const timestamp = z.number().int().nonnegative()
const stageStatus = z.enum(["pass", "failed", "blocked", "invalid"])
const sourceBinding = z
  .object({
    path: z.string().trim().min(1),
    sha256: digest,
  })
  .strict()
const fileBinding = z
  .object({
    relativePath: z.string().trim().min(1),
    sha256: digest,
    byteLength: z.number().int().nonnegative(),
    mediaType: z.string().trim().min(1),
  })
  .strict()
const automaticReport = z
  .object({
    sourcePath: z.string().trim().min(1),
    validator: z.enum(["junit", "r0_branch_coverage", "artifact"]),
    file: fileBinding,
    summary: z.record(z.string(), z.unknown()),
  })
  .strict()
const automaticCommand = z
  .object({
    id: identifier,
    cwd: z.string().trim().min(1),
    argv: z.array(z.string()).min(1),
    environment: z.record(z.string(), z.string()),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    status: z.enum(["pass", "fail"]),
    stdout: fileBinding,
    stderr: fileBinding,
    stdoutSummary: z.record(z.string(), z.unknown()).nullable(),
    reports: z.array(automaticReport),
  })
  .strict()
const automaticPackage = z
  .object({
    packageId: identifier,
    buildSha: commitSha,
    buildTreeSha: commitSha,
    provenance: z
      .object({
        kind: z.enum(["executed", "structural_fixture"]),
        worktreeHead: commitSha.nullable(),
      })
      .strict(),
    isolation: z.record(z.string(), z.unknown()),
    commands: z.array(automaticCommand).min(1),
    overallStatus: z.enum(["pass", "fail"]),
  })
  .passthrough()
const realSurfaceDeployment = z
  .object({
    result: z.literal("pass"),
    candidateSha: commitSha,
    project: z
      .object({
        id: identifier,
        executionStrategy: z.literal("seed_and_grow"),
        seedMode: z.literal("seed_pair"),
        state: z.literal("completed"),
        workProjectionAvailability: z.literal("available"),
        wayfinder: z.literal("project-wayfinder"),
        builder: z.literal("evidence analyst"),
        independentAgents: z.literal(true),
        realProviderCalls: z
          .array(
            z
              .object({
                path: z.string().trim().min(1),
                kind: z.enum(["wayfinder", "builder", "title", "other"]),
              })
              .strict(),
          )
          .min(2),
      })
      .strict(),
    controlPlane: z
      .object({
        healthy: z.literal(true),
        version: identifier,
        readiness: z.literal(true),
        providerConfiguredThroughProductAPI: z.literal(true),
        projectCreatedThroughProductAPI: z.literal(true),
        restarted: z.literal(true),
        persistentCompanyIdentity: z.literal(true),
        sourceWatermarks: z
          .object({
            work: digest,
            organization: digest,
            graph: digest,
            validation: digest,
          })
          .strict(),
      })
      .strict(),
    browser: z
      .object({
        productionWebUI: z.literal(true),
        seedPairVisible: z.literal(true),
        assignmentReasonAndSourceRefs: z.literal(true),
        graphValidationDiagnostics: z.literal(true),
        eventSourceRequests: z.number().int().positive(),
        sseReconnected: z.literal(true),
        refreshConverged: z.literal(true),
        states: z
          .object({
            loading: z.literal(true),
            empty: z.literal(true),
            filteredEmpty: z.literal(true),
            error: z.literal(true),
            offline: z.literal(true),
            offlineDiagnostic: identifier,
          })
          .strict(),
        accessibility: z
          .object({
            contextTabsKeyboard: z.literal(true),
            tabpanelRelationship: z.literal(true),
            sourceTraceKeyboard: z.literal(true),
          })
          .strict(),
      })
      .strict(),
    desktop: z
      .object({
        productionWebUI: z.literal(true),
        embeddedControlPlane: z.literal(true),
        persistedCompanyHome: z.literal(true),
        sourceWatermarkConverged: z.literal(true),
        productionWebUIProjectionConverged: z.literal(true),
        projectionStatuses: z
          .object({
            work: z.literal(200),
            organization: z.literal(200),
            graph: z.literal(200),
            validation: z.literal(200),
          })
          .strict(),
        rendererURL: z.string().url(),
        seedPairVisible: z.literal(true),
        assignmentEvidenceVisible: z.literal(true),
      })
      .strict(),
    screenshotDiff: z
      .object({
        width: z.number().int().min(390),
        height: z.number().int().min(720),
        changedPixels: z.literal(0),
        ratio: z.literal(0),
        maxChannelDelta: z.literal(0),
        beforeSha256: digest,
        afterSha256: digest,
      })
      .strict(),
    visualQA: z.literal("pass"),
    evidence: z
      .object({
        report: z.literal(deploymentReportPath),
        beforeScreenshot: z.literal("packages/app/.artifacts/seed-grow-b4/work-before-restart.png"),
        afterScreenshot: z.literal("packages/app/.artifacts/seed-grow-b4/work-after-restart.png"),
      })
      .strict(),
    uncovered: z.tuple([]),
    cleanup: z
      .object({
        providerPortClosed: z.literal(true),
        controlPlanePortClosed: z.literal(true),
        controlPlaneProxyPortClosed: z.literal(true),
        desktopDebugPortClosed: z.literal(true),
        webUIPortClosed: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const providerKinds = new Set(value.project.realProviderCalls.map((call) => call.kind))
    if (!providerKinds.has("wayfinder") || !providerKinds.has("builder"))
      context.addIssue({
        code: "custom",
        path: ["project", "realProviderCalls"],
        message: "Real provider evidence must include wayfinder and builder calls",
      })
  })
const pngArtifactSummary = z
  .object({
    validator: z.literal("artifact"),
    kind: z.literal("png"),
    width: z.number().int().min(390),
    height: z.number().int().min(720),
  })
  .strict()
const absoluteFileReference = z
  .object({
    path: absolutePath,
    sha256: digest,
  })
  .strict()
const CandidateInput = z
  .object({
    candidateSha: commitSha,
    verifierSha: commitSha,
    targetRef: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine(
        (value) =>
          !value.startsWith("-") &&
          !value.includes("..") &&
          !value.includes("@{") &&
          !value.includes("//") &&
          !value.endsWith("/") &&
          !value.endsWith(".lock"),
      ),
  })
  .strict()

const BootstrapRequest = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("bootstrap"),
    candidate: CandidateInput,
    outputDirectory: absolutePath,
  })
  .strict()

const PromoteRequest = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("promote"),
    previousBootstrap: absoluteFileReference,
    current: CandidateInput,
    databaseDirectory: absolutePath,
    outputDirectory: absolutePath,
  })
  .strict()
  .superRefine((value, context) => {
    const database = path.resolve(value.databaseDirectory)
    const output = path.resolve(value.outputDirectory)
    if (
      database === output ||
      database.startsWith(`${output}${path.sep}`) ||
      output.startsWith(`${database}${path.sep}`)
    )
      context.addIssue({
        code: "custom",
        path: ["databaseDirectory"],
        message: "Database and output directories must be disjoint",
      })
  })

const Request = z.discriminatedUnion("mode", [BootstrapRequest, PromoteRequest])

const StageSummary = z
  .object({
    stage: z.enum(stageIDs),
    evidenceDirectory: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
      .refine((value) => value !== "." && value !== ".."),
    runSha256: digest,
    decisionSha256: digest,
    status: stageStatus,
  })
  .strict()

const FinalRun = z
  .object({
    schemaVersion: z.literal(1),
    id: z.literal("agent-company-seed-grow-final-candidate-evidence"),
    buildSha: commitSha,
    buildTreeSha: commitSha,
    createdAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    automaticAttempts: z
      .array(
        z
          .object({
            id: z.enum(["attempt-01", "attempt-02"]),
            status: stageStatus,
            normalizedDigest: digest,
          })
          .strict(),
      )
      .length(2),
    stages: z.array(StageSummary).length(stageIDs.length),
    status: stageStatus,
  })
  .strict()

const FinalDecision = z
  .object({
    schemaVersion: z.literal(1),
    id: z.literal("agent-company-seed-grow-final-decision"),
    buildSha: commitSha,
    buildTreeSha: commitSha,
    finalRun: fileBinding,
    required: z.array(z.enum(stageIDs)),
    passed: z.array(z.enum(stageIDs)),
    failed: z.array(z.enum(stageIDs)),
    blocked: z.array(z.enum(stageIDs)),
    invalid: z.array(z.enum(stageIDs)),
    missing: z.array(z.enum(stageIDs)),
    stages: z.array(StageSummary).length(stageIDs.length),
    decidedAt: z.string().datetime(),
    status: stageStatus,
    advisory: z.array(z.string()),
  })
  .strict()

const StageDecision = z
  .object({
    schemaVersion: z.literal(1),
    decisionVersion: z.literal("1.0.0"),
    decisionId: z.string().trim().min(1),
    stage: z.enum(stageIDs),
    capabilityPackage: z.string().trim().min(1),
    buildSha: commitSha,
    evidencePackage: z
      .object({
        relativePath: z.literal("run.json"),
        sha256: digest,
      })
      .strict(),
    contractBinding: sourceBinding,
    schemaBinding: sourceBinding,
    gateBinding: sourceBinding,
    evaluatedAt: z.string().datetime(),
    status: stageStatus,
    required: z.array(z.string()),
    passed: z.array(z.string()),
    failed: z.array(z.string()),
    missing: z.array(z.string()),
    invalid: z.array(z.string()),
    advisory: z.array(z.string()),
    normalizedDigest: digest,
  })
  .strict()

const RepeatEvidence = z
  .object({
    runId: identifier,
    ordinal: z.union([z.literal(1), z.literal(2)]),
    environmentSha256: digest,
    evidenceSha256: digest,
    normalizedResultSha256: digest,
    startedAt: timestamp,
    finishedAt: timestamp,
  })
  .strict()

const CandidateEvidence = z
  .object({
    evidenceDirectory: absolutePath,
    finalRun: absoluteFileReference,
    finalDecision: absoluteFileReference,
    stageRunSha256s: z.record(z.enum(stageIDs), digest),
    stageDecisionSha256s: z.record(z.enum(stageIDs), digest),
    repeats: z.tuple([RepeatEvidence, RepeatEvidence]),
  })
  .strict()

function mergeCandidateFacts(
  artifacts: [z.infer<typeof PersistedFactArtifact>, z.infer<typeof PersistedFactArtifact>],
  repeats: [z.infer<typeof RepeatEvidence>, z.infer<typeof RepeatEvidence>],
  terminalEvidence: [
    { sha256: string; deploymentReportSha256: string },
    { sha256: string; deploymentReportSha256: string },
  ],
) {
  if (
    artifacts[0].candidateSha !== artifacts[1].candidateSha ||
    artifacts[0].metricContractDigest !== artifacts[1].metricContractDigest ||
    artifacts[0].metricQueryVersion !== artifacts[1].metricQueryVersion ||
    artifacts[0].shadowQueryVersion !== artifacts[1].shadowQueryVersion ||
    artifacts[0].producer.executableDigest !== artifacts[1].producer.executableDigest
  )
    fail("invalid", "B5 attempt fact contracts differ")
  if (
    new Set(artifacts.flatMap((artifact) => artifact.runBindings.map((binding) => binding.runId))).size !== 60 ||
    new Set(artifacts.flatMap((artifact) => artifact.events.map((event) => event.eventId))).size !==
      artifacts[0].events.length + artifacts[1].events.length ||
    new Set(artifacts.flatMap((artifact) => artifact.events.map((event) => `${event.source.kind}:${event.source.id}`)))
      .size !==
      artifacts[0].events.length + artifacts[1].events.length
  )
    fail("invalid", "B5 attempt facts are copied or have colliding run, event, or source identities")
  const terminalEvents = artifacts.map((artifact, index) => {
    const binding = artifact.runBindings.find((item) => item.scenarioId === "S13" && item.strategy === "seed_and_grow")
    if (!binding) fail("invalid", `B5 attempt ${index + 1} has no terminal run binding`)
    const repeat = repeats[index]
    return {
      eventId: `candidate-terminal-${artifact.candidateSha.slice(0, 16)}-${index + 1}`,
      eventType: "candidate.terminal_checked",
      occurredAt: new Date(repeat.finishedAt).toISOString(),
      projectId: binding.projectId,
      scenarioId: binding.scenarioId,
      runId: binding.runId,
      strategy: binding.strategy,
      subjectId: artifact.candidateSha,
      source: {
        kind: "gate_report" as const,
        id: `candidate-terminal-${repeat.runId}`,
        candidateSha: artifact.candidateSha,
        runId: binding.runId,
        digest: terminalEvidence[index].sha256,
      },
      properties: {
        candidateSha: artifact.candidateSha,
        isolatedRunIndex: index + 1,
        localGate: "success",
        deployment: "success",
        rollback: "success",
        reproducible: true,
        terminalEvidenceDigest: terminalEvidence[index].sha256,
        deploymentReportSha256: terminalEvidence[index].deploymentReportSha256,
      },
    }
  })
  return bindPersistedFactArtifact({
    schemaVersion: 1,
    kind: "seed-grow-local-gate-persisted-facts",
    id: `b5-two-attempts-${artifacts[0].candidateSha}`,
    producer: artifacts[0].producer,
    candidateSha: artifacts[0].candidateSha,
    metricContractDigest: artifacts[0].metricContractDigest,
    metricQueryVersion: artifacts[0].metricQueryVersion,
    shadowQueryVersion: artifacts[0].shadowQueryVersion,
    window: {
      id: `b5-two-attempts-${artifacts[0].candidateSha}`,
      startedAt: new Date(
        Math.min(
          ...artifacts.map((artifact) => Date.parse(artifact.window.startedAt)),
          ...repeats.map((repeat) => repeat.startedAt),
        ),
      ).toISOString(),
      endedAt: new Date(
        Math.max(
          ...artifacts.map((artifact) => Date.parse(artifact.window.endedAt)),
          ...repeats.map((repeat) => repeat.finishedAt),
        ),
      ).toISOString(),
    },
    runBindings: artifacts.flatMap((artifact) => artifact.runBindings),
    events: [...artifacts.flatMap((artifact) => artifact.events), ...terminalEvents],
  })
}

async function reportsFromFacts(
  artifact: z.infer<typeof PersistedFactArtifact>,
  evidenceSha256: string,
  contract: z.infer<typeof MetricContract>,
  metricIds: readonly (typeof PrePublicCandidateMetricIds)[number][],
  comparisonId: string,
) {
  const adapter = makePersistedFactArtifactAdapterFromArtifact(artifact, evidenceSha256)
  const reports = await Effect.runPromise(
    Effect.gen(function* () {
      const reporter = yield* Service
      return {
        metric: yield* reporter.report({
          contract,
          candidateSha: artifact.candidateSha,
          metricIds: [...metricIds],
          strategy: "seed_and_grow",
        }),
        shadow: yield* reporter.compareShadow({
          contract,
          candidateSha: artifact.candidateSha,
          comparisonId,
          scenarioIds: [...B5ScenarioIds],
        }),
      }
    }).pipe(Effect.provide(makeLayer(adapter))),
  ).catch((error) => fail("invalid", error instanceof Error ? error.message : String(error)))
  const metric = parseOrInvalid(MetricEvaluationReport, reports.metric, "Metric report")
  const shadow = parseOrInvalid(ShadowComparisonReport, reports.shadow, "Shadow report")
  if (
    metric.results.length !== metricIds.length ||
    new Set(metric.results.map((result) => result.metricId)).size !== metricIds.length ||
    !metricIds.every((metricId) => metric.results.some((result) => result.metricId === metricId))
  )
    fail("invalid", "Metric report result set differs from the requested candidate metrics")
  return { metric, shadow }
}

const BootstrapArtifact = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("seed-grow-bootstrap-candidate"),
    inputSha256: digest,
    candidate: CandidateInput,
    runnerBinding: sourceBinding,
    metricContract: z
      .object({
        path: z.literal("docs/product-design/experience-refactor/metric-contract.v1.json"),
        sourceSha256: digest,
        contractSha256: digest,
      })
      .strict(),
    candidateEvidence: CandidateEvidence,
    factArtifact: fileBinding,
    metricReport: fileBinding,
    shadowReport: fileBinding,
    promotionClaimed: z.literal(false),
    status: z.literal("pass"),
    createdAt: timestamp,
  })
  .strict()

const RollbackArtifact = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("seed-grow-isolated-rollback-evidence"),
    id: identifier,
    inputSha256: digest,
    candidateSha: commitSha,
    localRepeat: RepeatEvidence,
    observation: B5RollbackObservation,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.candidateSha !== value.observation.candidateSha)
      context.addIssue({
        code: "custom",
        path: ["candidateSha"],
        message: "Rollback artifact candidate does not match its observation",
      })
    if (value.localRepeat.ordinal === 1 && value.observation.target !== "kill_switch")
      context.addIssue({
        code: "custom",
        path: ["observation", "target"],
        message: "First rollback repeat must exercise the kill switch",
      })
    if (value.localRepeat.ordinal === 2 && value.observation.target !== "legacy_fallback")
      context.addIssue({
        code: "custom",
        path: ["observation", "target"],
        message: "Second rollback repeat must exercise legacy fallback",
      })
  })

const PromotionChildInput = z
  .object({
    schemaVersion: z.literal(1),
    candidateIds: z.tuple([identifier, identifier]),
    candidates: z.tuple([
      z.object({ id: identifier, candidate: CandidateInput, evidence: CandidateEvidence }).strict(),
      z.object({ id: identifier, candidate: CandidateInput, evidence: CandidateEvidence }).strict(),
    ]),
    rollbacks: z.tuple([RollbackArtifact, RollbackArtifact]),
    rollbackEvidenceSha256s: z.tuple([digest, digest]),
    promotionRequest: RolloutPromotionEvaluationRequest,
    transitionRequest: RolloutTransitionRequest,
  })
  .strict()

const PromotionChildResult = z
  .object({
    schemaVersion: z.literal(1),
    inputSha256: digest,
    promotion: RolloutPromotionDecision,
    persistedPromotion: RolloutPromotionDecision,
    transition: RolloutTransitionResult,
    persistedStatus: RolloutStatus,
    persistedEvidenceSha256: digest,
    persistedJournalSha256: digest,
    process: z
      .object({
        pid: z.number().int().positive(),
        databasePathSha256: digest,
        homePathSha256: digest,
      })
      .strict(),
  })
  .strict()

const PromotionVerificationInput = z
  .object({
    schemaVersion: z.literal(1),
    verifierCandidate: CandidateInput,
    expected: PromotionChildResult,
  })
  .strict()

const PromotionVerificationResult = z
  .object({
    schemaVersion: z.literal(1),
    inputSha256: digest,
    verified: z.literal(true),
    verifierPid: z.number().int().positive(),
    databasePathSha256: digest,
    homePathSha256: digest,
  })
  .strict()

function bindRollbackObservation(
  observation: z.infer<typeof B5RollbackObservation>,
  repeat: z.infer<typeof RepeatEvidence>,
  inputSha256: string,
) {
  return RollbackArtifact.parse({
    schemaVersion: 1,
    kind: "seed-grow-isolated-rollback-evidence",
    id: `rollback-${observation.target}-${observation.candidateSha.slice(0, 16)}-${repeat.ordinal}`,
    inputSha256,
    candidateSha: observation.candidateSha,
    localRepeat: repeat,
    observation,
  })
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (!value || typeof value !== "object") return value
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

function same(left: unknown, right: unknown) {
  return canonical(left) === canonical(right)
}

function fail(status: Exclude<GateStatus, "pass">, message: string): never {
  throw new PrePublicGateError(status, message)
}

function parseOrInvalid<T>(schema: z.ZodType<T>, value: unknown, label: string) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) fail("invalid", `${label} is malformed: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

async function regularFile(target: string, label: string) {
  const info = await lstat(target).catch(() => null)
  if (!info) fail("blocked", `${label} is missing: ${target}`)
  if (!info.isFile() || info.isSymbolicLink()) fail("invalid", `${label} must be a regular file: ${target}`)
  const bytes = new Uint8Array(await Bun.file(target).arrayBuffer())
  return {
    bytes,
    source: new TextDecoder().decode(bytes),
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
  }
}

async function regularDirectory(target: string, label: string) {
  const info = await lstat(target).catch(() => null)
  if (!info) fail("blocked", `${label} is missing: ${target}`)
  if (!info.isDirectory() || info.isSymbolicLink()) fail("invalid", `${label} must be a regular directory: ${target}`)
  return realpath(target)
}

export async function readBoundJSON(reference: z.input<typeof absoluteFileReference>, label: string) {
  const parsed = parseOrInvalid(absoluteFileReference, reference, `${label} reference`)
  const file = await regularFile(parsed.path, label)
  if (file.sha256 !== parsed.sha256) fail("invalid", `${label} SHA-256 mismatch`)
  const value = await Promise.resolve()
    .then(() => JSON.parse(file.source) as unknown)
    .catch(() => fail("invalid", `${label} is not valid JSON`))
  return { ...file, value, path: parsed.path }
}

async function parseJSONFile<T>(target: string, schema: z.ZodType<T>, label: string) {
  const file = await regularFile(target, label)
  const value = await Promise.resolve()
    .then(() => JSON.parse(file.source) as unknown)
    .catch(() => fail("invalid", `${label} is not valid JSON`))
  return { ...file, value: parseOrInvalid(schema, value, label), path: target }
}

function git(args: string[]) {
  const result = Bun.spawnSync([gitExecutable, ...args], {
    cwd: root,
    env: isolatedChildEnvironment({}),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0)
    fail("invalid", `Git verification failed: ${new TextDecoder().decode(result.stderr).trim().slice(0, 2_000)}`)
  return new TextDecoder().decode(result.stdout).trim()
}

function gitSource(args: string[]) {
  const result = Bun.spawnSync([gitExecutable, ...args], {
    cwd: root,
    env: isolatedChildEnvironment({}),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0)
    fail("invalid", `Git verification failed: ${new TextDecoder().decode(result.stderr).trim().slice(0, 2_000)}`)
  return new TextDecoder().decode(result.stdout)
}

function resolveCommit(value: string) {
  return git(["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`])
}

function runnerSourceAt(verifierSha: string) {
  return gitSource(["show", `${verifierSha}:${runnerPath}`])
}

function verifyCurrentCandidate(candidate: z.infer<typeof CandidateInput>, requireTarget = true) {
  const head = resolveCommit("HEAD")
  const target = requireTarget ? resolveCommit(candidate.targetRef) : candidate.candidateSha
  const candidateExecution =
    process.env.AGENTCOMPANY_GATE_CANDIDATE_EXECUTION === "1" &&
    ["--promotion-child", "--promotion-verify-child"].includes(Bun.argv[2] ?? "")
  if (
    (!candidateExecution && head !== candidate.verifierSha) ||
    (candidateExecution && head !== candidate.candidateSha)
  )
    fail(
      "invalid",
      candidateExecution
        ? "Candidate execution worktree HEAD does not match the candidate SHA"
        : "Checked-out HEAD does not match the pinned verifier SHA",
    )
  if (candidate.verifierSha === candidate.candidateSha) fail("invalid", "Candidate cannot provide its own verifier")
  if (target !== candidate.candidateSha) fail("invalid", "Target ref does not resolve to the candidate SHA")
  const ancestry = Bun.spawnSync(
    [gitExecutable, "merge-base", "--is-ancestor", candidate.verifierSha, candidate.candidateSha],
    { cwd: root, env: isolatedChildEnvironment({}), stdout: "pipe", stderr: "pipe" },
  )
  if (ancestry.exitCode !== 0) fail("invalid", "Pinned verifier is not an ancestor of the candidate")
  const trackedDiff = Bun.spawnSync(
    [gitExecutable, "diff", "--quiet", candidateExecution ? candidate.candidateSha : candidate.verifierSha, "--"],
    {
      cwd: root,
      env: isolatedChildEnvironment({}),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (trackedDiff.exitCode !== 0) fail("invalid", "Pinned verifier worktree differs from its exact Git tree")
  if (git(["status", "--porcelain=v1", "--untracked-files=all"]))
    fail("invalid", "Pinned verifier worktree contains tracked or untracked drift")
  const verifierOwnedChanges = git(["diff", "--name-only", candidate.verifierSha, candidate.candidateSha, "--"])
    .split("\n")
    .filter(verifierOwnedPath)
  if (verifierOwnedChanges.length)
    fail("invalid", `Candidate changed pinned acceptance assets: ${verifierOwnedChanges.join(", ")}`)
  runtimeBindingPaths.forEach((relativePath) => {
    const candidateBlob = git(["rev-parse", "--verify", `${candidate.candidateSha}:${relativePath}`])
    const verifierBlob = git(["rev-parse", "--verify", `${candidate.verifierSha}:${relativePath}`])
    const workingBlob = git(["hash-object", "--", relativePath])
    if (candidateBlob !== verifierBlob || verifierBlob !== workingBlob)
      fail("invalid", `Candidate changed a pinned verifier runtime dependency: ${relativePath}`)
  })
}

export function verifyDirectParent(previousCandidateSha: string, currentCandidateSha: string) {
  parseOrInvalid(commitSha, previousCandidateSha, "Previous candidate SHA")
  parseOrInvalid(commitSha, currentCandidateSha, "Current candidate SHA")
  const command = ["rev-list", "--parents", "-n", "1", currentCandidateSha]
  const output = git(command)
  const commits = output.split(/\s+/)
  if (commits.length !== 2 || commits[0] !== currentCandidateSha || commits[1] !== previousCandidateSha)
    fail("invalid", "Previous candidate is not the current candidate's single direct parent")
  return {
    previousCandidateSha,
    currentCandidateSha,
    parentSha: commits[1],
    verified: true as const,
    commandEvidenceSha256: sha256(canonical({ argv: ["git", ...command], stdout: output })),
  }
}

async function fileInside(directory: string, relativePath: string, label: string) {
  if (
    path.isAbsolute(relativePath) ||
    !relativePath ||
    relativePath.split(/[\\/]/).some((part) => part === ".." || part === "")
  )
    fail("invalid", `${label} path escaped its evidence directory`)
  const target = path.resolve(directory, relativePath)
  if (!target.startsWith(`${path.resolve(directory)}${path.sep}`))
    fail("invalid", `${label} path escaped its evidence directory`)
  const file = await regularFile(target, label)
  const directoryReal = await realpath(directory)
  const fileReal = await realpath(target)
  if (!fileReal.startsWith(`${directoryReal}${path.sep}`))
    fail("invalid", `${label} resolved outside its evidence directory`)
  return { ...file, path: target }
}

async function automaticReportFile(
  automatic: {
    path: string
    value: z.infer<typeof automaticPackage>
  },
  commandId: string,
  sourcePath: string,
  label: string,
  expectedMediaType = "application/json",
) {
  const commands = automatic.value.commands.filter((command) => command.id === commandId)
  if (commands.length !== 1 || commands[0].status !== "pass")
    fail("invalid", `${label} command is missing, duplicated, or non-passing`)
  const commandReports = commands[0].reports
  if (
    new Set(commandReports.map((report) => report.sourcePath)).size !== commandReports.length ||
    new Set(commandReports.map((report) => report.file.relativePath)).size !== commandReports.length
  )
    fail("invalid", `${label} command report bindings are duplicated`)
  const reports = commandReports.filter((report) => report.sourcePath === sourcePath)
  if (reports.length !== 1 || reports[0].validator !== "artifact")
    fail("invalid", `${label} report is missing, duplicated, or uses the wrong validator`)
  const report = reports[0]
  if (report.file.relativePath !== path.posix.join("files", commandId, "reports", path.posix.basename(sourcePath)))
    fail("invalid", `${label} archive path is not bound to its command and source path`)
  const file = await fileInside(path.dirname(automatic.path), report.file.relativePath, label)
  if (
    file.sha256 !== report.file.sha256 ||
    file.byteLength !== report.file.byteLength ||
    report.file.mediaType !== expectedMediaType
  )
    fail("invalid", `${label} report binding mismatch`)
  return file
}

function parsedJSON<T>(source: string, schema: z.ZodType<T>, label: string) {
  const value = Promise.resolve()
    .then(() => JSON.parse(source) as unknown)
    .catch(() => fail("invalid", `${label} is not valid JSON`))
  return value.then((raw) => parseOrInvalid(schema, raw, label))
}

async function validateDeploymentAttempt(
  automatic: {
    path: string
    sha256: string
    value: z.infer<typeof automaticPackage>
  },
  candidateSha: string,
  label: string,
) {
  const build = automatic.value.commands.filter((command) => command.id === "app-build")
  const production = automatic.value.commands.filter((command) => command.id === "app-production")
  const surfaces = automatic.value.commands.filter((command) => command.id === deploymentCommandId)
  if (build.length !== 1 || production.length !== 1 || surfaces.length !== 1)
    fail("invalid", `${label} deployment commands are missing or duplicated`)
  const buildCommand = build[0]
  const productionCommand = production[0]
  const surfacesCommand = surfaces[0]
  if (
    buildCommand.cwd !== "packages/app" ||
    !same(buildCommand.argv, ["bun", "run", "build"]) ||
    productionCommand.cwd !== "packages/app" ||
    !same(productionCommand.argv, ["bun", "run", "test:production"]) ||
    surfacesCommand.cwd !== "." ||
    !same(surfacesCommand.argv, ["bun", "script/seed-grow-real-surfaces.ts"]) ||
    [buildCommand, productionCommand, surfacesCommand].some(
      (command) => command.status !== "pass" || command.exitCode !== 0 || command.timedOut,
    ) ||
    !same(
      surfacesCommand.reports.map((report) => report.sourcePath),
      [
        "packages/app/.artifacts/seed-grow-b4/work-before-restart.png",
        "packages/app/.artifacts/seed-grow-b4/work-after-restart.png",
        deploymentReportPath,
      ],
    ) ||
    !same(surfacesCommand.stdoutSummary, {
      kind: "json_pass",
      field: "result",
      value: "pass",
      candidateShaMatches: true,
    })
  )
    fail("invalid", `${label} deployment command contract mismatch`)
  const report = await automaticReportFile(
    automatic,
    deploymentCommandId,
    deploymentReportPath,
    `${label} deployment report`,
  )
  const beforeScreenshot = await automaticReportFile(
    automatic,
    deploymentCommandId,
    "packages/app/.artifacts/seed-grow-b4/work-before-restart.png",
    `${label} deployment before screenshot`,
    "image/png",
  )
  const afterScreenshot = await automaticReportFile(
    automatic,
    deploymentCommandId,
    "packages/app/.artifacts/seed-grow-b4/work-after-restart.png",
    `${label} deployment after screenshot`,
    "image/png",
  )
  const deployment = await parsedJSON(report.source, realSurfaceDeployment, `${label} deployment report`)
  const screenshotReports = surfacesCommand.reports.slice(0, 2)
  const screenshotSummaries = screenshotReports.map((binding, index) =>
    parseOrInvalid(
      pngArtifactSummary,
      binding.summary,
      `${label} deployment ${index === 0 ? "before" : "after"} screenshot summary`,
    ),
  )
  if (
    deployment.candidateSha !== candidateSha ||
    deployment.screenshotDiff.beforeSha256 !== beforeScreenshot.sha256 ||
    deployment.screenshotDiff.afterSha256 !== afterScreenshot.sha256 ||
    screenshotSummaries.some(
      (summary) =>
        summary.width !== deployment.screenshotDiff.width || summary.height !== deployment.screenshotDiff.height,
    )
  )
    fail("invalid", `${label} deployment report or screenshot binding mismatch`)
  const normalizedResultSha256 = sha256(
    canonical({
      project: {
        executionStrategy: deployment.project.executionStrategy,
        seedMode: deployment.project.seedMode,
        state: deployment.project.state,
        workProjectionAvailability: deployment.project.workProjectionAvailability,
        wayfinder: deployment.project.wayfinder,
        builder: deployment.project.builder,
        independentAgents: deployment.project.independentAgents,
        realProviderKinds: [...new Set(deployment.project.realProviderCalls.map((call) => call.kind))].sort(),
      },
      controlPlane: {
        healthy: deployment.controlPlane.healthy,
        version: deployment.controlPlane.version,
        readiness: deployment.controlPlane.readiness,
        providerConfiguredThroughProductAPI: deployment.controlPlane.providerConfiguredThroughProductAPI,
        projectCreatedThroughProductAPI: deployment.controlPlane.projectCreatedThroughProductAPI,
        restarted: deployment.controlPlane.restarted,
        persistentCompanyIdentity: deployment.controlPlane.persistentCompanyIdentity,
      },
      browser: {
        productionWebUI: deployment.browser.productionWebUI,
        seedPairVisible: deployment.browser.seedPairVisible,
        assignmentReasonAndSourceRefs: deployment.browser.assignmentReasonAndSourceRefs,
        graphValidationDiagnostics: deployment.browser.graphValidationDiagnostics,
        eventSourceObserved: deployment.browser.eventSourceRequests > 0,
        sseReconnected: deployment.browser.sseReconnected,
        refreshConverged: deployment.browser.refreshConverged,
        states: {
          ...deployment.browser.states,
          offlineDiagnostic: Boolean(deployment.browser.states.offlineDiagnostic),
        },
        accessibility: deployment.browser.accessibility,
      },
      desktop: {
        productionWebUI: deployment.desktop.productionWebUI,
        embeddedControlPlane: deployment.desktop.embeddedControlPlane,
        persistedCompanyHome: deployment.desktop.persistedCompanyHome,
        sourceWatermarkConverged: deployment.desktop.sourceWatermarkConverged,
        productionWebUIProjectionConverged: deployment.desktop.productionWebUIProjectionConverged,
        projectionStatuses: deployment.desktop.projectionStatuses,
        seedPairVisible: deployment.desktop.seedPairVisible,
        assignmentEvidenceVisible: deployment.desktop.assignmentEvidenceVisible,
      },
      screenshotDiff: deployment.screenshotDiff,
      visualQA: deployment.visualQA,
      uncovered: deployment.uncovered,
      cleanup: deployment.cleanup,
    }),
  )
  return {
    deployment,
    reportSha256: report.sha256,
    normalizedResultSha256,
    evidenceSha256: sha256(
      canonical({
        automaticPackageSha256: automatic.sha256,
        appBuild: buildCommand,
        appProduction: productionCommand,
        realSurfaces: surfacesCommand,
        reportSha256: report.sha256,
        beforeScreenshotSha256: beforeScreenshot.sha256,
        afterScreenshotSha256: afterScreenshot.sha256,
      }),
    ),
  }
}

async function persistedFactsFromReport(
  file: Awaited<ReturnType<typeof automaticReportFile>>,
  candidateSha: string,
  contractSha256: string,
  label: string,
) {
  const artifact = await parsedJSON(file.source, PersistedFactArtifact, label)
  const { snapshotDigest, ...core } = artifact
  const rebound = bindPersistedFactArtifact(core)
  if (rebound.snapshotDigest !== snapshotDigest) fail("invalid", `${label} snapshot digest mismatch`)
  if (
    artifact.candidateSha !== candidateSha ||
    artifact.metricContractDigest !== contractSha256 ||
    artifact.producer.commandId !== "seed-grow-persisted-fact-exporter" ||
    artifact.producer.version !== "v1" ||
    artifact.producer.executableDigest !==
      sha256(gitSource(["show", `${candidateSha}:packages/control-plane/src/metrics/persisted-fact-exporter.ts`]))
  )
    fail("invalid", `${label} candidate, contract, or producer binding mismatch`)
  const bindings = artifact.runBindings.map((binding) => B5RunBinding.parse(binding))
  try {
    exactB5RunBindings(bindings)
  } catch (error) {
    fail("invalid", `${label} run matrix mismatch: ${error instanceof Error ? error.message : String(error)}`)
  }
  return artifact
}

function attemptPhysicalIdentity(summary: z.infer<typeof B5CandidateAttemptSummary>) {
  return {
    worktree: summary.environment.worktree.absolutePathSha256,
    runtimeHome: summary.environment.runtimeHome.absolutePathSha256,
    database: summary.environment.database.absolutePathSha256,
    output: summary.environment.output.absolutePathSha256,
    isolationRoot: summary.environment.isolationRoot.absolutePathSha256,
  }
}

async function validateB5Attempt(
  automatic: {
    path: string
    sha256: string
    value: z.infer<typeof automaticPackage>
  },
  candidateSha: string,
  contract: z.infer<typeof MetricContract>,
  label: string,
) {
  const commands = automatic.value.commands.filter((command) => command.id === b5CommandId)
  if (commands.length !== 1) fail("invalid", `${label} B5 producer command is missing or duplicated`)
  const command = commands[0]
  if (
    command.cwd !== "packages/control-plane" ||
    !same(command.argv, [
      "bun",
      "script/produce-seed-grow-candidate-facts.ts",
      "--candidate-sha",
      "HEAD",
      "--attempt-id",
      "automatic",
      "--out",
      b5ReportRoot,
    ]) ||
    command.status !== "pass" ||
    command.exitCode !== 0 ||
    command.timedOut ||
    !same(
      command.reports.map((report) => report.sourcePath),
      b5ReportSourcePaths,
    )
  )
    fail("invalid", `${label} B5 producer command contract mismatch`)
  const reports = new Map(
    await Promise.all(
      b5ReportSourcePaths.map(
        async (sourcePath) =>
          [
            sourcePath,
            await automaticReportFile(automatic, b5CommandId, sourcePath, `${label} ${sourcePath}`),
          ] as const,
      ),
    ),
  )
  const report = (relativePath: string) => reports.get(`${b5ReportRoot}/${relativePath}`)!
  const summary = await parsedJSON(report("summary.json").source, B5CandidateAttemptSummary, `${label} B5 summary`)
  const parent = git(["rev-list", "--parents", "-n", "1", candidateSha]).split(/\s+/)
  if (
    parent.length !== 2 ||
    summary.candidate.requestedSha !== candidateSha ||
    summary.candidate.headSha !== candidateSha ||
    summary.candidate.treeSha !== git(["rev-parse", `${candidateSha}^{tree}`]) ||
    summary.candidate.parentSha !== parent[1] ||
    summary.attemptId !== "automatic" ||
    summary.producer.sha256 !==
      sha256(
        gitSource(["show", `${candidateSha}:packages/control-plane/script/produce-seed-grow-candidate-facts.ts`]),
      ) ||
    summary.outputIsolationSha256 !== summary.environment.output.stateSha256 ||
    new Set(
      Object.values(summary.environment)
        .filter(
          (value): value is { absolutePathSha256: string; stateSha256: string } =>
            typeof value === "object" && value !== null && "absolutePathSha256" in value,
        )
        .map((value) => value.absolutePathSha256),
    ).size !== 5 ||
    summary.window.startedAt < Date.parse(command.startedAt) ||
    summary.window.finishedAt > Date.parse(command.finishedAt)
  )
    fail("invalid", `${label} B5 summary candidate, producer, or execution window mismatch`)
  const topLevelBindings = [
    ["facts.json", summary.files.facts],
    ["metric-report.json", summary.files.metricReport],
    ["shadow-report.json", summary.files.shadowReport],
    ["rollback-kill-switch.json", summary.files.rollbackKillSwitch],
    ["rollback-legacy-fallback.json", summary.files.rollbackLegacyFallback],
  ] as const
  topLevelBindings.forEach(([relativePath, binding]) => {
    const file = report(relativePath)
    if (
      binding.relativePath !== relativePath ||
      binding.sha256 !== file.sha256 ||
      binding.byteLength !== file.byteLength ||
      binding.mediaType !== "application/json"
    )
      fail("invalid", `${label} B5 ${relativePath} summary binding mismatch`)
  })
  const expectedObservationPaths = B5ScenarioIds.flatMap((scenarioId) =>
    B5StrategyOrder.map((strategy) => `reports/${scenarioId}-${strategy}.json`),
  )
  if (
    summary.files.observationReports.length !== expectedObservationPaths.length ||
    !summary.files.observationReports.every((binding, index) => {
      const relativePath = expectedObservationPaths[index]
      const file = report(relativePath)
      return (
        binding.relativePath === relativePath &&
        binding.sha256 === file.sha256 &&
        binding.byteLength === file.byteLength &&
        binding.mediaType === "application/json"
      )
    })
  )
    fail("invalid", `${label} B5 observation report bindings are incomplete or reordered`)
  const observationReports = await Promise.all(
    expectedObservationPaths.map(async (relativePath, index) => ({
      file: report(relativePath),
      value: await parsedJSON(report(relativePath).source, B5ScenarioObservationReport, `${label} B5 ${relativePath}`),
      binding: summary.orderedRunBindings[index],
    })),
  )
  if (
    observationReports.some(
      (observation) =>
        observation.value.candidateSha !== candidateSha ||
        observation.value.attemptId !== "automatic" ||
        observation.value.attemptIsolationId !== summary.attemptIsolationId ||
        !same(observation.value.binding, observation.binding),
    )
  )
    fail("invalid", `${label} B5 scenario reports are not bound to the candidate attempt`)
  const facts = await persistedFactsFromReport(
    report("facts.json"),
    candidateSha,
    metricContractDigest(contract),
    `${label} B5 facts`,
  )
  if (!same(facts.runBindings, summary.orderedRunBindings))
    fail("invalid", `${label} B5 fact and summary run bindings differ`)
  observationReports.forEach((observation) => {
    const reportChecks = facts.events.filter(
      (event) =>
        event.runId === observation.binding.runId &&
        event.eventType === "fact.gate_observation" &&
        event.properties.observationType === "report.file_checked",
    )
    const terminalChecks = facts.events.filter(
      (event) => event.runId === observation.binding.runId && event.eventType === "terminal.invariant_checked",
    )
    if (
      reportChecks.length !== 1 ||
      reportChecks[0].properties.reportSha256 !== observation.file.sha256 ||
      terminalChecks.length !== 1 ||
      terminalChecks[0].properties.invariantReportSha256 !== observation.file.sha256
    )
      fail("invalid", `${label} B5 scenario archive is not bound to its persisted facts`)
  })
  const persistedMetric = await parsedJSON(
    report("metric-report.json").source,
    MetricEvaluationReport,
    `${label} B5 metric report`,
  )
  const persistedShadow = await parsedJSON(
    report("shadow-report.json").source,
    ShadowComparisonReport,
    `${label} B5 shadow report`,
  )
  const recomputed = await reportsFromFacts(
    facts,
    report("facts.json").sha256,
    contract,
    PrePublicScenarioMetricIds,
    persistedShadow.comparisonId,
  )
  if (
    !same(persistedMetric, recomputed.metric) ||
    !same(persistedShadow, recomputed.shadow) ||
    persistedMetric.status !== "pass" ||
    persistedShadow.status !== "pass"
  )
    fail("invalid", `${label} B5 reports differ from trusted fact recomputation`)
  const rollbackValues = [
    await parsedJSON(
      report("rollback-kill-switch.json").source,
      B5RollbackObservation,
      `${label} B5 kill-switch rollback`,
    ),
    await parsedJSON(
      report("rollback-legacy-fallback.json").source,
      B5RollbackObservation,
      `${label} B5 legacy-fallback rollback`,
    ),
  ] as const
  if (
    rollbackValues[0].target !== "kill_switch" ||
    rollbackValues[1].target !== "legacy_fallback" ||
    rollbackValues.some(
      (rollback) =>
        rollback.candidateSha !== candidateSha ||
        rollback.attemptId !== "automatic" ||
        rollback.attemptIsolationId !== summary.attemptIsolationId ||
        rollback.process.producerSha256 !== summary.producer.sha256 ||
        rollback.process.startedAt < summary.window.startedAt ||
        rollback.process.startedAt > rollback.observedAt ||
        rollback.observedAt < summary.window.startedAt ||
        rollback.observedAt > summary.window.finishedAt ||
        rollback.dispatch.observedAt < summary.window.startedAt ||
        rollback.dispatch.observedAt > summary.window.finishedAt ||
        rollback.dispatch.resultSha256 !== sha256(canonical(rollback.dispatch.result)) ||
        rollback.isolation.databasePathSha256 !== summary.environment.database.absolutePathSha256,
    )
  )
    fail("invalid", `${label} B5 rollback observations are not bound to the candidate attempt`)
  const normalizedResultSha256 = b5CanonicalNormalizedResultSha256({
    scenarioReports: observationReports.map((observation) => observation.value),
    metricReport: recomputed.metric,
    shadowReport: recomputed.shadow,
    rollbackObservations: [...rollbackValues],
  })
  if (normalizedResultSha256 !== summary.normalizedResultSha256)
    fail("invalid", `${label} B5 normalized result does not match archived evidence`)
  return {
    summary,
    facts,
    metric: persistedMetric,
    shadow: persistedShadow,
    rollbackValues,
    normalizedResultSha256,
    reportSha256s: Object.fromEntries([...reports.entries()].map(([sourcePath, file]) => [sourcePath, file.sha256])),
    environmentIdentity: attemptPhysicalIdentity(summary),
    environmentSha256: sha256(canonical(attemptPhysicalIdentity(summary))),
    terminalEvidenceSha256: sha256(
      canonical({
        automaticPackageSha256: automatic.sha256,
        summarySha256: report("summary.json").sha256,
        metricSha256: report("metric-report.json").sha256,
        shadowSha256: report("shadow-report.json").sha256,
        rollbackSha256s: [report("rollback-kill-switch.json").sha256, report("rollback-legacy-fallback.json").sha256],
      }),
    ),
  }
}

function stageStatusError(status: GateStatus, label: string): never {
  if (status === "blocked") fail("blocked", `${label} is blocked`)
  if (status === "failed") fail("failed", `${label} failed`)
  fail("invalid", `${label} is invalid`)
}

function orderedStages(values: readonly string[]) {
  return values.length === stageIDs.length && stageIDs.every((stage, index) => values[index] === stage)
}

async function validateAllStageEvidence(
  candidate: z.infer<typeof CandidateInput>,
  governance: Governance,
  evidenceDirectory: string,
) {
  const gateRuntime = await import(path.join(root, "script/seed-grow-stage-gate.ts"))
  const coreRuntime = await import(path.join(root, "script/seed-grow-stage-core.ts"))
  evidenceDirectory = path.resolve(evidenceDirectory)
  await regularDirectory(evidenceDirectory, "All-stage evidence directory")
  const finalRun = await parseJSONFile(path.join(evidenceDirectory, "final-run.json"), FinalRun, "Final run")
  const finalDecision = await parseJSONFile(
    path.join(evidenceDirectory, "final-decision.json"),
    FinalDecision,
    "Final decision",
  )
  if (
    finalRun.value.buildSha !== candidate.candidateSha ||
    finalDecision.value.buildSha !== candidate.candidateSha ||
    finalRun.value.buildTreeSha !== governance.buildTreeSha ||
    finalDecision.value.buildTreeSha !== governance.buildTreeSha
  )
    fail("invalid", "Final evidence candidate or tree binding mismatch")
  if (
    finalRun.value.status !== "pass" ||
    finalDecision.value.status !== "pass" ||
    finalRun.value.automaticAttempts.some((attempt) => attempt.status !== "pass")
  )
    stageStatusError(
      finalRun.value.status !== "pass" ? finalRun.value.status : finalDecision.value.status,
      "Final all-stage evidence",
    )
  if (
    finalRun.value.automaticAttempts[0]?.id !== "attempt-01" ||
    finalRun.value.automaticAttempts[1]?.id !== "attempt-02" ||
    new Set(finalRun.value.automaticAttempts.map((attempt) => attempt.normalizedDigest)).size !== 1
  )
    fail("invalid", "Final attempts are not two reproducible local runs")
  if (
    !orderedStages(finalRun.value.stages.map((stage) => stage.stage)) ||
    !orderedStages(finalDecision.value.required) ||
    !orderedStages(finalDecision.value.passed) ||
    finalDecision.value.failed.length ||
    finalDecision.value.blocked.length ||
    finalDecision.value.invalid.length ||
    finalDecision.value.missing.length ||
    !same(finalRun.value.stages, finalDecision.value.stages) ||
    finalDecision.value.finalRun.relativePath !== "final-run.json" ||
    finalDecision.value.finalRun.sha256 !== finalRun.sha256 ||
    finalDecision.value.finalRun.byteLength !== finalRun.byteLength ||
    finalDecision.value.finalRun.mediaType !== "application/json"
  )
    fail("invalid", "Final run and decision are inconsistent")
  const stageRunSha256s = {} as Record<StageID, string>
  const stageDecisionSha256s = {} as Record<StageID, string>
  const packageByAttempt = new Map<
    string,
    {
      path: string
      source: string
      sha256: string
      value: z.infer<typeof automaticPackage>
    }[]
  >()
  for (const summary of finalRun.value.stages) {
    if (summary.evidenceDirectory !== `${path.basename(evidenceDirectory)}-${summary.stage.toLowerCase()}`)
      fail("invalid", `${summary.stage} evidence directory name is not bound to the final run`)
    const stageDirectory = path.join(path.dirname(evidenceDirectory), summary.evidenceDirectory)
    await regularDirectory(stageDirectory, `${summary.stage} evidence directory`)
    const run = await regularFile(path.join(stageDirectory, "run.json"), `${summary.stage} run`)
    const decision = await parseJSONFile(
      path.join(stageDirectory, "stage-decision.json"),
      StageDecision,
      `${summary.stage} decision`,
    )
    if (run.sha256 !== summary.runSha256 || decision.sha256 !== summary.decisionSha256)
      fail("invalid", `${summary.stage} final summary digest mismatch`)
    const evaluation = await gateRuntime.evaluateSeedGrowStageEvidence({
      buildSha: candidate.candidateSha,
      stage: summary.stage,
      evidenceDirectory: stageDirectory,
      governance,
    })
    if (evaluation.status !== "pass") stageStatusError(evaluation.status, `${summary.stage} evidence`)
    if (
      decision.value.stage !== summary.stage ||
      decision.value.buildSha !== candidate.candidateSha ||
      decision.value.status !== evaluation.status ||
      decision.value.normalizedDigest !== evaluation.normalizedDigest ||
      decision.value.evidencePackage.sha256 !== run.sha256 ||
      !same(decision.value.required, evaluation.required) ||
      !same(decision.value.passed, evaluation.passed) ||
      !same(decision.value.failed, evaluation.failed) ||
      !same(decision.value.missing, evaluation.missing) ||
      !same(decision.value.invalid, evaluation.invalid)
    )
      fail("invalid", `${summary.stage} persisted decision differs from re-evaluation`)
    const runValue = await Promise.resolve()
      .then(() => JSON.parse(run.source) as unknown)
      .catch(() => fail("invalid", `${summary.stage} run is not valid JSON`))
    if (!runValue || typeof runValue !== "object" || !Array.isArray((runValue as Record<string, unknown>).attempts))
      fail("invalid", `${summary.stage} run attempts are malformed`)
    const attempts = (runValue as Record<string, unknown>).attempts as unknown[]
    for (const [index, attemptValue] of attempts.entries()) {
      if (
        !attemptValue ||
        typeof attemptValue !== "object" ||
        !("id" in attemptValue) ||
        !("automaticPackage" in attemptValue)
      )
        fail("invalid", `${summary.stage} attempt is malformed`)
      const attempt = attemptValue as Record<string, unknown>
      const binding = parseOrInvalid(
        fileBinding,
        attempt.automaticPackage,
        `${summary.stage} ${String(attempt.id)} package binding`,
      )
      const automatic = await fileInside(
        stageDirectory,
        binding.relativePath,
        `${summary.stage} ${String(attempt.id)} automatic package`,
      )
      if (
        automatic.sha256 !== binding.sha256 ||
        automatic.byteLength !== binding.byteLength ||
        binding.mediaType !== "application/json"
      )
        fail("invalid", `${summary.stage} ${String(attempt.id)} package digest mismatch`)
      const value = await Promise.resolve()
        .then(() => JSON.parse(automatic.source) as unknown)
        .catch(() => fail("invalid", `${summary.stage} automatic package is not valid JSON`))
      const parsedPackage = parseOrInvalid(
        automaticPackage,
        value,
        `${summary.stage} ${String(attempt.id)} automatic package`,
      )
      const entries = packageByAttempt.get(String(attempt.id)) ?? []
      entries.push({
        path: automatic.path,
        source: automatic.source,
        sha256: automatic.sha256,
        value: parsedPackage,
      })
      packageByAttempt.set(String(attempt.id), entries)
      if (index > 1) fail("invalid", `${summary.stage} has more than two attempts`)
    }
    stageRunSha256s[summary.stage] = run.sha256
    stageDecisionSha256s[summary.stage] = decision.sha256
  }
  const repeats = finalRun.value.automaticAttempts.map((attempt, index) => {
    const packages = packageByAttempt.get(attempt.id) ?? []
    if (packages.length !== stageIDs.length || new Set(packages.map((item) => item.sha256)).size !== 1)
      fail("invalid", `${attempt.id} is not the same independently executed package across every stage`)
    const automatic = packages[0]!
    if (
      automatic.value.overallStatus !== "pass" ||
      automatic.value.buildSha !== candidate.candidateSha ||
      automatic.value.buildTreeSha !== governance.buildTreeSha ||
      automatic.value.provenance.kind !== "executed" ||
      automatic.value.provenance.worktreeHead !== candidate.candidateSha ||
      coreRuntime.normalizeAutomaticPackage(automatic.value, governance.automaticCommandIDs) !==
        attempt.normalizedDigest
    )
      fail("invalid", `${attempt.id} is not exact-SHA executed evidence`)
    const commands = automatic.value.commands
    const intervals = commands.map((command) => ({
      startedAt: Date.parse(command.startedAt),
      finishedAt: Date.parse(command.finishedAt),
    }))
    if (
      !commands.length ||
      intervals.some(
        (interval) =>
          !Number.isFinite(interval.startedAt) ||
          !Number.isFinite(interval.finishedAt) ||
          interval.finishedAt < interval.startedAt,
      ) ||
      !automatic.value.packageId
    )
      fail("invalid", `${attempt.id} has invalid execution identity or timestamps`)
    return {
      repeat: RepeatEvidence.parse({
        runId: `${automatic.value.packageId}-${attempt.id}`,
        ordinal: index + 1,
        environmentSha256: sha256(
          canonical({
            buildTreeSha: automatic.value.buildTreeSha,
            runnerBinding: automatic.value.runnerBinding,
            provenance: automatic.value.provenance,
            isolation: automatic.value.isolation,
          }),
        ),
        evidenceSha256: automatic.sha256,
        normalizedResultSha256: attempt.normalizedDigest,
        startedAt: Math.min(...intervals.map((interval) => interval.startedAt)),
        finishedAt: Math.max(...intervals.map((interval) => interval.finishedAt)),
      }),
      automatic,
    }
  })
  if (
    new Set(repeats.map((item) => item.repeat.evidenceSha256)).size !== 2 ||
    new Set(repeats.map((item) => item.repeat.normalizedResultSha256)).size !== 1
  )
    fail("invalid", "The two local attempts are duplicated or not normalized-equivalent")
  return {
    evidence: CandidateEvidence.parse({
      evidenceDirectory,
      finalRun: { path: finalRun.path, sha256: finalRun.sha256 },
      finalDecision: { path: finalDecision.path, sha256: finalDecision.sha256 },
      stageRunSha256s,
      stageDecisionSha256s,
      repeats: repeats.map((item) => item.repeat),
    }),
    automaticAttempts: repeats,
  }
}

function isolatedChildEnvironment(overrides: Record<string, string>) {
  return {
    ...Object.fromEntries(
      ["LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TERM", "COLORTERM"]
        .map((key) => [key, process.env[key]])
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    PATH: trustedExecutablePath,
    TZ: "UTC",
    CI: "1",
    AGENTCOMPANY_DISABLE_CLAUDE_IMPORT: "1",
    AGENTCOMPANY_DISABLE_DEFAULT_PLUGINS: "1",
    AGENTCOMPANY_DISABLE_PROVIDER_ENV: "1",
    AGENTCOMPANY_PURE: "1",
    ...overrides,
  }
}

async function prepareCandidateWorktree(candidate: z.infer<typeof CandidateInput>) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ac-pre-public-gate-"))
  const worktree = path.join(temporaryRoot, "worktree")
  const added = Bun.spawnSync([gitExecutable, "worktree", "add", "--detach", worktree, candidate.candidateSha], {
    cwd: root,
    env: isolatedChildEnvironment({}),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (added.exitCode !== 0) {
    await rm(temporaryRoot, { recursive: true, force: true })
    fail("invalid", `Cannot create exact candidate worktree: ${added.stderr.toString().trim().slice(0, 2_000)}`)
  }
  try {
    const installer = (await import(path.join(root, "script/experience-automatic-evidence.ts"))) as {
      installDependencies: (worktree: string, isolationRoot: string) => Promise<{ lockSha256: string }>
    }
    const installed = await installer.installDependencies(worktree, path.join(temporaryRoot, "dependency-isolation"))
    if (installed.lockSha256 !== sha256(gitSource(["show", `${candidate.candidateSha}:bun.lock`])))
      fail("invalid", "Candidate dependency lock binding mismatch")
    return { temporaryRoot, worktree }
  } catch (error) {
    Bun.spawnSync([gitExecutable, "worktree", "remove", "--force", worktree], {
      cwd: root,
      env: isolatedChildEnvironment({}),
      stdout: "pipe",
      stderr: "pipe",
    })
    await rm(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}

async function removeCandidateWorktree(execution: Awaited<ReturnType<typeof prepareCandidateWorktree>>) {
  const removed = Bun.spawnSync([gitExecutable, "worktree", "remove", "--force", execution.worktree], {
    cwd: root,
    env: isolatedChildEnvironment({}),
    stdout: "pipe",
    stderr: "pipe",
  })
  await rm(execution.temporaryRoot, { recursive: true, force: true })
  if (removed.exitCode !== 0)
    fail("invalid", `Cannot remove candidate worktree: ${removed.stderr.toString().trim().slice(0, 2_000)}`)
}

async function generateTrustedCandidateEvidence(candidate: z.infer<typeof CandidateInput>, requireTarget: boolean) {
  verifyCurrentCandidate(candidate, requireTarget)
  const execution = await prepareCandidateWorktree(candidate)
  const outputName = `gate-${candidate.candidateSha.slice(0, 12)}-${randomUUID().replaceAll("-", "")}`
  const sourceRoot = path.join(execution.worktree, ".agent/runs/agent-company-seed-grow")
  const trustedRoot = path.join(root, ".agent/runs/agent-company-seed-grow")
  try {
    const runtimeHome = path.join(execution.temporaryRoot, "runner-home")
    await mkdir(runtimeHome, { recursive: true })
    const child = Bun.spawn(
      [
        process.execPath,
        "script/seed-grow-stage-evidence.ts",
        "--ref",
        candidate.candidateSha,
        "--all",
        "--out",
        path.join(sourceRoot, outputName),
      ],
      {
        cwd: execution.worktree,
        env: isolatedChildEnvironment({
          HOME: runtimeHome,
          USERPROFILE: runtimeHome,
          AGENTCOMPANY_HOME: path.join(runtimeHome, "agentcompany"),
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timeout = setTimeout(() => child.kill(), 14_400_000)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    clearTimeout(timeout)
    if (exitCode !== 0)
      fail(
        exitCode === 1 || exitCode === 2 ? "blocked" : "invalid",
        `Trusted all-stage evidence runner failed: ${(stderr || stdout).trim().slice(-8_000)}`,
      )
    await mkdir(trustedRoot, { recursive: true })
    for (const directory of [outputName, ...stageIDs.map((stage) => `${outputName}-${stage.toLowerCase()}`)])
      await cp(path.join(sourceRoot, directory), path.join(trustedRoot, directory), {
        recursive: true,
        force: false,
        errorOnExist: true,
      })
    verifyCurrentCandidate(candidate, requireTarget)
    return path.join(trustedRoot, outputName)
  } finally {
    await removeCandidateWorktree(execution)
  }
}

async function validateCandidate(
  candidateValue: z.infer<typeof CandidateInput>,
  evidenceDirectory?: string,
  requireTarget = true,
) {
  const candidate = CandidateInput.parse(candidateValue)
  const coreRuntime = await import(path.join(root, "script/seed-grow-stage-core.ts"))
  const governance = (await coreRuntime
    .loadSeedGrowGovernance(candidate.candidateSha)
    .catch((error: unknown) => fail("invalid", error instanceof Error ? error.message : String(error)))) as Governance
  const contractValue = await Promise.resolve()
    .then(() => JSON.parse(governance.metricSource) as unknown)
    .catch(() => fail("invalid", "Metric contract is not valid JSON"))
  const contract = parseOrInvalid(MetricContract, contractValue, "Metric contract")
  const contractSha256 = metricContractDigest(contract)
  if (contractSha256 !== PrePublicMetricContractSha256)
    fail("invalid", "Metric contract is not the supported Pre-Public contract")
  const allStage = await validateAllStageEvidence(
    candidate,
    governance,
    evidenceDirectory ?? (await generateTrustedCandidateEvidence(candidate, requireTarget)),
  )
  const firstAutomatic = allStage.automaticAttempts[0]
  const secondAutomatic = allStage.automaticAttempts[1]
  if (!firstAutomatic || !secondAutomatic) fail("invalid", "B5 requires exactly two automatic attempts")
  const attempts = await Promise.all([
    validateB5Attempt(firstAutomatic.automatic, candidate.candidateSha, contract, "attempt-01"),
    validateB5Attempt(secondAutomatic.automatic, candidate.candidateSha, contract, "attempt-02"),
  ])
  const deployments = await Promise.all([
    validateDeploymentAttempt(firstAutomatic.automatic, candidate.candidateSha, "attempt-01"),
    validateDeploymentAttempt(secondAutomatic.automatic, candidate.candidateSha, "attempt-02"),
  ])
  if (
    attempts[0].normalizedResultSha256 !== attempts[1].normalizedResultSha256 ||
    deployments[0].normalizedResultSha256 !== deployments[1].normalizedResultSha256 ||
    attempts[0].summary.outputIsolationSha256 === attempts[1].summary.outputIsolationSha256 ||
    attempts[0].environmentSha256 === attempts[1].environmentSha256 ||
    physicalIdentityKeys.some((key) => attempts[0].environmentIdentity[key] === attempts[1].environmentIdentity[key]) ||
    attempts[0].summary.window.finishedAt > attempts[1].summary.window.startedAt
  )
    fail("invalid", "B5 attempts are not reproducible, isolated, or sequential")
  const repeat = (
    item: typeof firstAutomatic,
    attempt: (typeof attempts)[number],
    deployment: (typeof deployments)[number],
    ordinal: 1 | 2,
  ) =>
    RepeatEvidence.parse({
      ...item.repeat,
      runId: `${item.automatic.value.packageId}-${ordinal}-${attempt.summary.outputIsolationSha256.slice(0, 16)}`,
      ordinal,
      environmentSha256: attempt.environmentSha256,
      normalizedResultSha256: sha256(
        canonical({
          automatic: item.repeat.normalizedResultSha256,
          b5: attempt.normalizedResultSha256,
          deployment: deployment.normalizedResultSha256,
        }),
      ),
    })
  const repeats: [z.infer<typeof RepeatEvidence>, z.infer<typeof RepeatEvidence>] = [
    repeat(firstAutomatic, attempts[0], deployments[0], 1),
    repeat(secondAutomatic, attempts[1], deployments[1], 2),
  ]
  if (
    repeats[0].finishedAt > repeats[1].startedAt ||
    new Set(repeats.map((repeat) => repeat.runId)).size !== 2 ||
    new Set(repeats.map((repeat) => repeat.environmentSha256)).size !== 2 ||
    new Set(repeats.map((repeat) => repeat.evidenceSha256)).size !== 2 ||
    new Set(repeats.map((repeat) => repeat.normalizedResultSha256)).size !== 1
  )
    fail("invalid", "B5 trusted repeat identities are copied, overlapping, or non-reproducible")
  const mergedFacts = mergeCandidateFacts([attempts[0].facts, attempts[1].facts], repeats, [
    {
      sha256: sha256(
        canonical({
          localGate: firstAutomatic.repeat.evidenceSha256,
          deployment: deployments[0].evidenceSha256,
          rollback: attempts[0].terminalEvidenceSha256,
        }),
      ),
      deploymentReportSha256: deployments[0].reportSha256,
    },
    {
      sha256: sha256(
        canonical({
          localGate: secondAutomatic.repeat.evidenceSha256,
          deployment: deployments[1].evidenceSha256,
          rollback: attempts[1].terminalEvidenceSha256,
        }),
      ),
      deploymentReportSha256: deployments[1].reportSha256,
    },
  ])
  const reports = await reportsFromFacts(
    mergedFacts,
    sha256(`${JSON.stringify(mergedFacts, null, 2)}\n`),
    contract,
    PrePublicCandidateMetricIds,
    `b5-two-attempts-${candidate.candidateSha}`,
  )
  const metric = reports.metric
  const shadow = reports.shadow
  if (
    metric.results.length !== PrePublicCandidateMetricIds.length ||
    new Set(metric.results.map((result) => result.metricId)).size !== PrePublicCandidateMetricIds.length ||
    !PrePublicCandidateMetricIds.every((metricId) => metric.results.some((result) => result.metricId === metricId))
  )
    fail("invalid", "Metric report does not contain exactly the 17 candidate metrics")
  const status: GateStatus =
    metric.status === "blocked" || shadow.status === "blocked"
      ? "blocked"
      : metric.status !== "pass" || shadow.status !== "pass"
        ? "failed"
        : "pass"
  return {
    candidate,
    governance,
    contract,
    contractSha256,
    evidence: CandidateEvidence.parse({ ...allStage.evidence, repeats }),
    mergedFacts,
    attempts,
    deployments,
    rollbackObservations: [attempts[0].rollbackValues[0], attempts[1].rollbackValues[1]] as const,
    reports: { metric, shadow },
    status,
  }
}

async function emptyDirectory(target: string, label: string) {
  const resolved = path.resolve(target)
  const info = await lstat(resolved).catch(() => null)
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) fail("invalid", `${label} must be a regular directory`)
  if (info && (await readdir(resolved)).length) fail("invalid", `${label} must be absent or empty`)
  await mkdir(resolved, { recursive: true })
  return resolved
}

async function writeJSON(directory: string, name: string, value: unknown) {
  const source = `${JSON.stringify(value, null, 2)}\n`
  const target = path.join(directory, name)
  const handle = await open(target, "wx", 0o600).catch(() => fail("invalid", `Output file already exists: ${target}`))
  try {
    await handle.writeFile(source)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return {
    relativePath: name,
    sha256: sha256(source),
    byteLength: Buffer.byteLength(source),
    mediaType: "application/json",
  }
}

function runnerBindingAt(verifierSha: string) {
  return {
    path: runnerPath,
    sha256: sha256(runnerSourceAt(verifierSha)),
  }
}

async function writeReports(
  directory: string,
  prefix: string,
  reports: {
    metric: z.infer<typeof MetricEvaluationReport>
    shadow: z.infer<typeof ShadowComparisonReport>
  },
) {
  return {
    metric: await writeJSON(directory, `${prefix}metric-report.json`, reports.metric),
    shadow: await writeJSON(directory, `${prefix}shadow-report.json`, reports.shadow),
  }
}

async function bootstrap(request: z.infer<typeof BootstrapRequest>, inputSha256: string, outputDirectory: string) {
  verifyCurrentCandidate(request.candidate)
  const validated = await validateCandidate(request.candidate)
  const factArtifact = await writeJSON(outputDirectory, "candidate-facts.json", validated.mergedFacts)
  const reportBindings = await writeReports(outputDirectory, "", validated.reports)
  if (validated.status !== "pass") stageStatusError(validated.status, "Candidate metric and shadow reports")
  const artifact = BootstrapArtifact.parse({
    schemaVersion: 1,
    kind: "seed-grow-bootstrap-candidate",
    inputSha256,
    candidate: validated.candidate,
    runnerBinding: runnerBindingAt(validated.candidate.verifierSha),
    metricContract: {
      path: "docs/product-design/experience-refactor/metric-contract.v1.json",
      sourceSha256: validated.governance.metricSha256,
      contractSha256: validated.contractSha256,
    },
    candidateEvidence: validated.evidence,
    factArtifact,
    metricReport: reportBindings.metric,
    shadowReport: reportBindings.shadow,
    promotionClaimed: false,
    status: "pass",
    createdAt: Date.now(),
  })
  const bootstrapBinding = await writeJSON(outputDirectory, "bootstrap-candidate.json", artifact)
  return {
    schemaVersion: 1,
    mode: "bootstrap" as const,
    inputSha256,
    candidateSha: validated.candidate.candidateSha,
    bootstrapCandidate: bootstrapBinding,
    factArtifact,
    metricReport: reportBindings.metric,
    shadowReport: reportBindings.shadow,
    promotionClaimed: false,
    status: "pass" as const,
  }
}

async function revalidateBootstrap(reference: z.infer<typeof absoluteFileReference>) {
  const source = await readBoundJSON(reference, "Previous bootstrap artifact")
  const artifact = parseOrInvalid(BootstrapArtifact, source.value, "Previous bootstrap artifact")
  if (!same(artifact.runnerBinding, runnerBindingAt(artifact.candidate.verifierSha)))
    fail("invalid", "Previous bootstrap runner binding mismatch")
  const archived = await validateCandidate(artifact.candidate, artifact.candidateEvidence.evidenceDirectory, false)
  if (archived.status !== "pass") stageStatusError(archived.status, "Previous archived candidate reports")
  if (
    artifact.metricContract.sourceSha256 !== archived.governance.metricSha256 ||
    artifact.metricContract.contractSha256 !== archived.contractSha256 ||
    !same(artifact.candidateEvidence, archived.evidence)
  )
    fail("invalid", "Previous bootstrap evidence no longer revalidates")
  const directory = path.dirname(reference.path)
  const facts = await fileInside(directory, artifact.factArtifact.relativePath, "Previous fact artifact")
  const metric = await fileInside(directory, artifact.metricReport.relativePath, "Previous metric report")
  const shadow = await fileInside(directory, artifact.shadowReport.relativePath, "Previous shadow report")
  if (
    facts.sha256 !== artifact.factArtifact.sha256 ||
    facts.byteLength !== artifact.factArtifact.byteLength ||
    metric.sha256 !== artifact.metricReport.sha256 ||
    metric.byteLength !== artifact.metricReport.byteLength ||
    shadow.sha256 !== artifact.shadowReport.sha256 ||
    shadow.byteLength !== artifact.shadowReport.byteLength
  )
    fail("invalid", "Previous bootstrap report binding mismatch")
  const factValue = await parsedJSON(facts.source, PersistedFactArtifact, "Previous fact artifact")
  const metricValue = await Promise.resolve()
    .then(() => JSON.parse(metric.source) as unknown)
    .catch(() => fail("invalid", "Previous metric report is not valid JSON"))
  const shadowValue = await Promise.resolve()
    .then(() => JSON.parse(shadow.source) as unknown)
    .catch(() => fail("invalid", "Previous shadow report is not valid JSON"))
  if (
    !same(factValue, archived.mergedFacts) ||
    !same(parseOrInvalid(MetricEvaluationReport, metricValue, "Previous metric report"), archived.reports.metric) ||
    !same(parseOrInvalid(ShadowComparisonReport, shadowValue, "Previous shadow report"), archived.reports.shadow)
  )
    fail("invalid", "Previous bootstrap reports differ from persisted-fact re-evaluation")
  const validated = await validateCandidate(artifact.candidate, undefined, false)
  if (validated.status !== "pass") stageStatusError(validated.status, "Previous candidate fresh reports")
  return { artifact, validated, reference }
}

export function validateRollbackPair(
  values: unknown[],
  candidateSha: string,
  repeats: z.infer<typeof RepeatEvidence>[],
  inputSha256: string,
) {
  if (values.length !== 2) fail("blocked", "Both rollback artifacts are required")
  const artifacts = values.map((value, index) =>
    parseOrInvalid(RollbackArtifact, value, `Rollback artifact ${index + 1}`),
  )
  if (
    new Set(artifacts.map((artifact) => artifact.id)).size !== 2 ||
    new Set(artifacts.map((artifact) => artifact.observation.target)).size !== 2 ||
    new Set(artifacts.map((artifact) => artifact.localRepeat.runId)).size !== 2
  )
    fail("invalid", "Rollback artifacts are duplicated")
  artifacts.forEach((artifact) => {
    const repeat = repeats.find(
      (candidate) =>
        candidate.runId === artifact.localRepeat.runId &&
        candidate.evidenceSha256 === artifact.localRepeat.evidenceSha256,
    )
    if (
      artifact.candidateSha !== candidateSha ||
      artifact.inputSha256 !== inputSha256 ||
      !repeat ||
      !same(repeat, artifact.localRepeat)
    )
      fail("invalid", "Rollback artifact candidate, input, or local evidence binding mismatch")
  })
  return artifacts
}

async function promotionChildInput(inputPath: string) {
  if (!path.isAbsolute(inputPath)) fail("invalid", "Promotion child input path must be absolute")
  const input = await regularFile(inputPath, "Promotion child input")
  return {
    value: await parsedJSON(input.source, PromotionChildInput, "Promotion child input"),
    sha256: input.sha256,
  }
}

async function executePromotionChild(inputPath: string) {
  const childInput = await promotionChildInput(inputPath)
  const input = childInput.value
  verifyCurrentCandidate(input.candidates[1].candidate)
  const databasePath = process.env.AGENTCOMPANY_DB
  const homePath = process.env.AGENTCOMPANY_HOME
  if (!databasePath || !homePath || !path.isAbsolute(databasePath) || !path.isAbsolute(homePath))
    fail("invalid", "Promotion child isolation environment is missing")
  if (
    !same(
      input.candidateIds,
      input.candidates.map((candidate) => candidate.id),
    ) ||
    !same(input.candidateIds, input.promotionRequest.candidateIds) ||
    input.transitionRequest.promotionDecisionId !== input.promotionRequest.id ||
    input.rollbacks[0].candidateSha !== input.candidates[1].candidate.candidateSha ||
    input.rollbacks[1].candidateSha !== input.candidates[1].candidate.candidateSha
  )
    fail("invalid", "Promotion child candidate bindings are inconsistent")
  const CompanyRollout = await import("../src/company-rollout/company-rollout")
  const storage = await import("../src/storage")
  for (const [to, id] of [
    ["shadow", "shadow"],
    ["opt_in", "opt-in"],
    ["dogfood_default", "dogfood"],
  ] as const)
    CompanyRollout.transition({
      idempotencyKey: `pre-public-${id}-${input.candidates[1].candidate.candidateSha.slice(0, 12)}`,
      to,
      reason: `Isolated Pre-Public candidate gate enters ${to}`,
      actorId: "seed-grow-pre-public-gate",
    })
  input.candidates.forEach((item, candidateIndex) => {
    CompanyRollout.recordAction({
      kind: "register_candidate",
      idempotencyKey: `register-${candidateIndex + 1}-${item.candidate.candidateSha.slice(0, 16)}`,
      candidate: {
        id: item.id,
        candidateSha: item.candidate.candidateSha,
        targetRef: item.candidate.targetRef,
      },
    })
    item.evidence.repeats.forEach((repeat) =>
      CompanyRollout.recordAction({
        kind: "record_local_repeat",
        idempotencyKey: `record-${candidateIndex + 1}-${repeat.ordinal}-${item.candidate.candidateSha.slice(0, 12)}`,
        repeat: {
          id: `repeat-${candidateIndex + 1}-${repeat.ordinal}-${item.candidate.candidateSha.slice(0, 12)}`,
          candidateId: item.id,
          ...repeat,
          outcome: "completed",
        },
      }),
    )
  })
  input.rollbacks.forEach((rollback, index) => {
    process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = rollback.observation.target === "kill_switch" ? "off" : "active"
    CompanyRollout.recordAction({
      kind: "record_rollback",
      idempotencyKey: `record-${rollback.id}`,
      rollback: {
        id: rollback.id,
        candidateId: input.candidateIds[1],
        target: rollback.observation.target,
        phaseAtAction: rollback.observation.phaseAtAction,
        executionModeAfter: rollback.observation.after.executionMode,
        outcome: rollback.observation.outcome,
        evidenceSha256: input.rollbackEvidenceSha256s[index],
        observedAt: rollback.observation.observedAt,
      },
    })
  })
  const promotion = CompanyRollout.evaluatePrePublicPromotion(input.promotionRequest)
  if (promotion.status !== "pass") stageStatusError(promotion.status, "CompanyRollout promotion")
  const persistedPromotion = CompanyRollout.getPromotionDecision(promotion.id)
  if (!persistedPromotion || !same(promotion, persistedPromotion))
    fail("invalid", "Promotion decision did not survive persisted re-read")
  const transition = CompanyRollout.transition(input.transitionRequest)
  const persistedStatus = CompanyRollout.status()
  const evidence = CompanyRollout.evidence()
  const journal = CompanyRollout.listJournal()
  if (
    persistedStatus.state.phase !== "pre_public_default" ||
    !evidence.promotionDecisions.some((decision) => same(decision, persistedPromotion)) ||
    !journal.items.some(
      (item) =>
        item.kind === "transition" &&
        item.resultRefId === transition.transition.id &&
        item.payloadSha256 === transition.journal.payloadSha256,
    )
  )
    fail("invalid", "Pre-Public transition did not survive persisted re-read")
  const result = PromotionChildResult.parse({
    schemaVersion: 1,
    inputSha256: childInput.sha256,
    promotion,
    persistedPromotion,
    transition,
    persistedStatus,
    persistedEvidenceSha256: CompanyRollout.valueSha256(evidence),
    persistedJournalSha256: CompanyRollout.valueSha256(journal),
    process: {
      pid: process.pid,
      databasePathSha256: sha256(path.resolve(databasePath)),
      homePathSha256: sha256(path.resolve(homePath)),
    },
  })
  verifyCurrentCandidate(input.candidates[1].candidate)
  storage.Database.close()
  return result
}

async function executePromotionVerificationChild(inputPath: string) {
  if (!path.isAbsolute(inputPath)) fail("invalid", "Promotion verification input path must be absolute")
  const source = await regularFile(inputPath, "Promotion verification input")
  const input = await parsedJSON(source.source, PromotionVerificationInput, "Promotion verification input")
  verifyCurrentCandidate(input.verifierCandidate)
  const databasePath = process.env.AGENTCOMPANY_DB
  const homePath = process.env.AGENTCOMPANY_HOME
  if (!databasePath || !homePath || !path.isAbsolute(databasePath) || !path.isAbsolute(homePath))
    fail("invalid", "Promotion verification isolation environment is missing")
  const CompanyRollout = await import("../src/company-rollout/company-rollout")
  const storage = await import("../src/storage")
  const promotion = CompanyRollout.getPromotionDecision(input.expected.promotion.id)
  const persistedStatus = CompanyRollout.status()
  const evidence = CompanyRollout.evidence()
  const journal = CompanyRollout.listJournal()
  if (
    !promotion ||
    !same(promotion, input.expected.persistedPromotion) ||
    !same(persistedStatus, input.expected.persistedStatus) ||
    CompanyRollout.valueSha256(evidence) !== input.expected.persistedEvidenceSha256 ||
    CompanyRollout.valueSha256(journal) !== input.expected.persistedJournalSha256 ||
    persistedStatus.state.phase !== "pre_public_default" ||
    !journal.items.some(
      (item) =>
        item.kind === "transition" &&
        item.resultRefId === input.expected.transition.transition.id &&
        item.payloadSha256 === input.expected.transition.journal.payloadSha256,
    ) ||
    sha256(path.resolve(databasePath)) !== input.expected.process.databasePathSha256 ||
    sha256(path.resolve(homePath)) !== input.expected.process.homePathSha256
  )
    fail("invalid", "Promotion state did not survive an isolated process restart")
  const result = PromotionVerificationResult.parse({
    schemaVersion: 1,
    inputSha256: source.sha256,
    verified: true,
    verifierPid: process.pid,
    databasePathSha256: sha256(path.resolve(databasePath)),
    homePathSha256: sha256(path.resolve(homePath)),
  })
  verifyCurrentCandidate(input.verifierCandidate)
  storage.Database.close()
  return result
}

async function runPromotionProcess(
  mode: "--promotion-child" | "--promotion-verify-child",
  inputPath: string,
  databasePath: string,
  homePath: string,
  candidateWorktree: string,
) {
  const child = Bun.spawn([process.execPath, path.join(candidateWorktree, runnerPath), mode, inputPath], {
    cwd: candidateWorktree,
    env: isolatedChildEnvironment({
      AGENTCOMPANY_DB: databasePath,
      AGENTCOMPANY_HOME: homePath,
      AGENTCOMPANY_SEED_GROW_ORCHESTRATION: "active",
      AGENTCOMPANY_GATE_CANDIDATE_EXECUTION: "1",
      HOME: homePath,
      USERPROFILE: homePath,
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), 120_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timeout)
  if (exitCode !== 0) fail("invalid", `Promotion child failed: ${stderr.trim().slice(0, 4_000)}`)
  return Promise.resolve()
    .then(() => JSON.parse(stdout) as unknown)
    .catch(() => fail("invalid", "Promotion child output is not valid JSON"))
}

function databaseJSON(value: unknown, label: string) {
  if (typeof value !== "string") fail("invalid", `${label} is not persisted JSON`)
  return Promise.resolve()
    .then(() => JSON.parse(value) as unknown)
    .catch(() => fail("invalid", `${label} is not valid persisted JSON`))
}

async function verifyPromotionDatabase(
  databasePath: string,
  input: z.infer<typeof PromotionChildInput>,
  child: z.infer<typeof PromotionChildResult>,
) {
  const database = new SQLiteDatabase(databasePath, { create: false })
  try {
    database.exec("PRAGMA foreign_keys = ON")
    const checkpoint = database.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as Record<string, unknown> | null
    const integrity = database.query("PRAGMA integrity_check").get() as Record<string, unknown> | null
    const foreignKeys = database.query("PRAGMA foreign_key_check").all()
    const state = database.query("SELECT * FROM company_rollout_state WHERE id = 'seed_and_grow'").get() as Record<
      string,
      unknown
    > | null
    const promotions = database.query("SELECT * FROM company_rollout_promotion_decision").all() as Record<
      string,
      unknown
    >[]
    const candidates = database.query("SELECT * FROM company_rollout_candidate ORDER BY id").all() as Record<
      string,
      unknown
    >[]
    const repeats = database.query("SELECT * FROM company_rollout_local_repeat ORDER BY id").all() as Record<
      string,
      unknown
    >[]
    const rollbacks = database.query("SELECT * FROM company_rollout_rollback ORDER BY id").all() as Record<
      string,
      unknown
    >[]
    const journals = database.query("SELECT * FROM company_rollout_journal ORDER BY created_at, id").all() as Record<
      string,
      unknown
    >[]
    if (
      checkpoint?.busy !== 0 ||
      !integrity ||
      !Object.values(integrity).includes("ok") ||
      foreignKeys.length ||
      !state ||
      promotions.length !== 1 ||
      candidates.length !== 2 ||
      repeats.length !== 4 ||
      rollbacks.length !== 2 ||
      journals.length !== 12
    )
      fail("invalid", "Pinned SQLite verification found incomplete or corrupt promotion persistence")
    if (
      state.phase !== "pre_public_default" ||
      state.version !== child.persistedStatus.state.version ||
      state.last_transition_id !== child.transition.transition.id ||
      state.updated_at !== child.persistedStatus.state.updatedAt
    )
      fail("invalid", "Pinned SQLite verification found an inconsistent rollout state")
    const promotion = promotions[0]
    if (
      promotion.id !== input.promotionRequest.id ||
      promotion.target_phase !== "pre_public_default" ||
      promotion.status !== "pass" ||
      promotion.metric_contract_sha256 !== input.promotionRequest.metricContractSha256 ||
      promotion.input_sha256 !== sha256(canonical(input.promotionRequest)) ||
      promotion.output_sha256 !== sha256(canonical(child.promotion)) ||
      !same(await databaseJSON(promotion.input_json, "Promotion input"), input.promotionRequest) ||
      !same(await databaseJSON(promotion.candidate_ids_json, "Promotion candidate IDs"), input.candidateIds) ||
      !same(
        await databaseJSON(promotion.candidate_shas_json, "Promotion candidate SHAs"),
        input.candidates.map((candidate) => candidate.candidate.candidateSha),
      ) ||
      !same(await databaseJSON(promotion.repeat_ids_json, "Promotion repeat IDs"), child.promotion.repeatIds) ||
      !same(await databaseJSON(promotion.rollback_ids_json, "Promotion rollback IDs"), child.promotion.rollbackIds) ||
      !same(
        await databaseJSON(promotion.metric_report_sha256s_json, "Promotion metric report digests"),
        child.promotion.metricReportSha256s,
      ) ||
      !same(
        await databaseJSON(promotion.shadow_report_sha256s_json, "Promotion shadow report digests"),
        child.promotion.shadowReportSha256s,
      ) ||
      !same(await databaseJSON(promotion.ancestry_json, "Promotion ancestry"), input.promotionRequest.ancestry) ||
      !same(
        await databaseJSON(promotion.derived_metric_result_json, "Promotion derived metric result"),
        child.promotion.derivedMetricResult,
      ) ||
      !same(await databaseJSON(promotion.reasons_json, "Promotion reasons"), child.promotion.reasons)
    )
      fail("invalid", "Pinned SQLite verification found an inconsistent promotion decision")
    const expectedCandidates = input.candidates
      .map((candidate) => ({
        id: candidate.id,
        candidate_sha: candidate.candidate.candidateSha,
        target_ref: candidate.candidate.targetRef,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
    if (
      !same(
        candidates.map((candidate) => ({
          id: candidate.id,
          candidate_sha: candidate.candidate_sha,
          target_ref: candidate.target_ref,
        })),
        expectedCandidates,
      )
    )
      fail("invalid", "Pinned SQLite verification found inconsistent candidate rows")
    const expectedRepeats = input.candidates
      .flatMap((candidate, candidateIndex) =>
        candidate.evidence.repeats.map((repeat) => ({
          id: `repeat-${candidateIndex + 1}-${repeat.ordinal}-${candidate.candidate.candidateSha.slice(0, 12)}`,
          candidate_id: candidate.id,
          run_id: repeat.runId,
          ordinal: repeat.ordinal,
          outcome: "completed",
          environment_sha256: repeat.environmentSha256,
          evidence_sha256: repeat.evidenceSha256,
          normalized_result_sha256: repeat.normalizedResultSha256,
          started_at: repeat.startedAt,
          finished_at: repeat.finishedAt,
        })),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
    if (
      !same(
        repeats.map((repeat) => ({
          id: repeat.id,
          candidate_id: repeat.candidate_id,
          run_id: repeat.run_id,
          ordinal: repeat.ordinal,
          outcome: repeat.outcome,
          environment_sha256: repeat.environment_sha256,
          evidence_sha256: repeat.evidence_sha256,
          normalized_result_sha256: repeat.normalized_result_sha256,
          started_at: repeat.started_at,
          finished_at: repeat.finished_at,
        })),
        expectedRepeats,
      )
    )
      fail("invalid", "Pinned SQLite verification found inconsistent repeat rows")
    const expectedRollbacks = input.rollbacks
      .map((rollback, index) => ({
        id: rollback.id,
        candidate_id: input.candidateIds[1],
        target: rollback.observation.target,
        phase_at_action: rollback.observation.phaseAtAction,
        execution_mode_after: rollback.observation.after.executionMode,
        outcome: rollback.observation.outcome,
        evidence_sha256: input.rollbackEvidenceSha256s[index],
        observed_at: rollback.observation.observedAt,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
    if (
      !same(
        rollbacks.map((rollback) => ({
          id: rollback.id,
          candidate_id: rollback.candidate_id,
          target: rollback.target,
          phase_at_action: rollback.phase_at_action,
          execution_mode_after: rollback.execution_mode_after,
          outcome: rollback.outcome,
          evidence_sha256: rollback.evidence_sha256,
          observed_at: rollback.observed_at,
        })),
        expectedRollbacks,
      )
    )
      fail("invalid", "Pinned SQLite verification found inconsistent rollback rows")
    const journalValues = await Promise.all(
      journals.map(async (journal) => {
        const payload = await databaseJSON(journal.payload_json, "Rollout journal payload")
        if (
          journal.payload_sha256 !== sha256(canonical(payload)) ||
          typeof journal.result_json !== "string" ||
          !["transition", "action"].includes(String(journal.kind))
        )
          fail("invalid", "Pinned SQLite verification found an invalid rollout journal")
        return { journal, payload, result: await databaseJSON(journal.result_json, "Rollout journal result") }
      }),
    )
    const transitionJournal = journalValues.filter(
      ({ journal }) =>
        journal.kind === "transition" &&
        journal.idempotency_key === input.transitionRequest.idempotencyKey &&
        journal.result_ref_id === child.transition.transition.id,
    )
    if (
      transitionJournal.length !== 1 ||
      !same(transitionJournal[0].payload, input.transitionRequest) ||
      !same(transitionJournal[0].result, child.transition) ||
      journalValues.filter(({ journal }) => journal.kind === "transition").length !== 4 ||
      journalValues.filter(({ journal }) => journal.kind === "action").length !== 8
    )
      fail("invalid", "Pinned SQLite verification found an inconsistent transition journal")
    return sha256(
      canonical({
        checkpoint,
        integrity,
        state,
        promotion,
        candidates,
        repeats,
        rollbacks,
        journals,
      }),
    )
  } finally {
    database.close()
  }
}

async function isolatedPromotion(
  request: z.infer<typeof PromoteRequest>,
  inputSha256: string,
  outputDirectory: string,
  previous: Awaited<ReturnType<typeof revalidateBootstrap>>,
  current: Awaited<ReturnType<typeof validateCandidate>>,
  factBinding: Awaited<ReturnType<typeof writeJSON>>,
  reportBindings: Awaited<ReturnType<typeof writeReports>>,
  ancestry: ReturnType<typeof verifyDirectParent>,
) {
  const identities = [...previous.validated.attempts, ...current.attempts].map((attempt) => attempt.environmentIdentity)
  if (
    physicalIdentityKeys.some((key) => new Set(identities.map((identity) => identity[key])).size !== identities.length)
  )
    fail("invalid", "The four candidate attempts reuse a physical isolation path")
  const databaseDirectory = await emptyDirectory(request.databaseDirectory, "Promotion database directory")
  const databasePath = path.join(databaseDirectory, "company-rollout.db")
  const homePath = path.join(databaseDirectory, "home")
  const candidateIds: [string, string] = [
    `candidate-01-${previous.artifact.candidate.candidateSha.slice(0, 16)}`,
    `candidate-02-${current.candidate.candidateSha.slice(0, 16)}`,
  ]
  const databasePathSha256 = sha256(path.resolve(databasePath))
  const rollbackValues = [
    bindRollbackObservation(current.rollbackObservations[0], current.evidence.repeats[0], inputSha256),
    bindRollbackObservation(current.rollbackObservations[1], current.evidence.repeats[1], inputSha256),
  ]
  const rollbacks = validateRollbackPair(
    rollbackValues,
    current.candidate.candidateSha,
    current.evidence.repeats,
    inputSha256,
  )
  const rollbackBindings = [
    await writeJSON(outputDirectory, "rollback-kill-switch.json", rollbacks[0]),
    await writeJSON(outputDirectory, "rollback-legacy-fallback.json", rollbacks[1]),
  ] as const
  if (rollbackBindings[0].sha256 === rollbackBindings[1].sha256)
    fail("invalid", "Rollback artifacts have the same digest")
  const promotionId = `promotion-${current.candidate.candidateSha.slice(0, 16)}`
  const childInput = PromotionChildInput.parse({
    schemaVersion: 1,
    candidateIds,
    candidates: [
      {
        id: candidateIds[0],
        candidate: previous.artifact.candidate,
        evidence: previous.validated.evidence,
      },
      {
        id: candidateIds[1],
        candidate: current.candidate,
        evidence: current.evidence,
      },
    ],
    rollbacks,
    rollbackEvidenceSha256s: rollbackBindings.map((binding) => binding.sha256),
    promotionRequest: {
      id: promotionId,
      candidateIds,
      metricContract: current.contract,
      metricContractSha256: current.contractSha256,
      metricReports: [previous.validated.reports.metric, current.reports.metric],
      shadowReports: [previous.validated.reports.shadow, current.reports.shadow],
      ancestry: {
        ...ancestry,
        targetRef: current.candidate.targetRef,
      },
    },
    transitionRequest: {
      idempotencyKey: `pre-public-transition-${current.candidate.candidateSha.slice(0, 16)}`,
      to: "pre_public_default",
      reason: "Two exact-SHA candidates passed all automatic Pre-Public gates",
      actorId: "seed-grow-pre-public-gate",
      promotionDecisionId: promotionId,
    },
  })
  const promotionInput = await writeJSON(outputDirectory, "promotion-child-input.json", childInput)
  const processes = await (async () => {
    const execution = await prepareCandidateWorktree(current.candidate)
    try {
      const child = parseOrInvalid(
        PromotionChildResult,
        await runPromotionProcess(
          "--promotion-child",
          path.join(outputDirectory, promotionInput.relativePath),
          databasePath,
          homePath,
          execution.worktree,
        ),
        "Promotion child result",
      )
      if (
        child.process.pid === process.pid ||
        child.inputSha256 !== promotionInput.sha256 ||
        child.promotion.id !== childInput.promotionRequest.id ||
        !same(child.promotion.candidateIds, candidateIds) ||
        !same(
          child.promotion.candidateShas,
          childInput.candidates.map((candidate) => candidate.candidate.candidateSha),
        ) ||
        child.promotion.metricContractSha256 !== current.contractSha256 ||
        !same(
          child.promotion.metricReportSha256s,
          childInput.promotionRequest.metricReports.map((report) => sha256(canonical(report))),
        ) ||
        !same(
          child.promotion.shadowReportSha256s,
          childInput.promotionRequest.shadowReports.map((report) => sha256(canonical(report))),
        ) ||
        !same(child.promotion.ancestry, childInput.promotionRequest.ancestry) ||
        child.promotion.inputSha256 !== sha256(canonical(childInput.promotionRequest)) ||
        child.promotion.status !== "pass" ||
        !same(child.promotion, child.persistedPromotion) ||
        child.transition.transition.promotionDecisionId !== childInput.transitionRequest.promotionDecisionId ||
        child.transition.transition.to !== childInput.transitionRequest.to ||
        child.process.databasePathSha256 !== databasePathSha256 ||
        child.process.homePathSha256 !== sha256(path.resolve(homePath))
      )
        fail("invalid", "Promotion child did not use the isolated candidate database process")
      const verificationInput = await writeJSON(outputDirectory, "promotion-verification-input.json", {
        schemaVersion: 1,
        verifierCandidate: current.candidate,
        expected: child,
      })
      const verification = parseOrInvalid(
        PromotionVerificationResult,
        await runPromotionProcess(
          "--promotion-verify-child",
          path.join(outputDirectory, verificationInput.relativePath),
          databasePath,
          homePath,
          execution.worktree,
        ),
        "Promotion verification result",
      )
      if (
        verification.verifierPid === process.pid ||
        verification.verifierPid === child.process.pid ||
        verification.inputSha256 !== verificationInput.sha256 ||
        verification.databasePathSha256 !== databasePathSha256 ||
        verification.homePathSha256 !== child.process.homePathSha256
      )
        fail("invalid", "Promotion restart verification did not use a distinct candidate process")
      return { child, verification, verificationInput }
    } finally {
      await removeCandidateWorktree(execution)
    }
  })()
  const child = processes.child
  const verification = processes.verification
  const verificationInput = processes.verificationInput
  const databaseAttestationSha256 = await verifyPromotionDatabase(databasePath, childInput, child)
  const database = await regularFile(databasePath, "Isolated promotion database")
  const result = {
    schemaVersion: 1,
    kind: "seed-grow-pre-public-promotion",
    inputSha256,
    previousBootstrap: request.previousBootstrap,
    candidateShas: [previous.artifact.candidate.candidateSha, current.candidate.candidateSha],
    candidates: {
      previous: {
        input: previous.artifact.candidate,
        evidence: previous.validated.evidence,
      },
      current: {
        input: current.candidate,
        evidence: current.evidence,
      },
    },
    ancestry,
    metricContract: {
      path: "docs/product-design/experience-refactor/metric-contract.v1.json",
      sourceSha256: current.governance.metricSha256,
      contractSha256: current.contractSha256,
    },
    reports: {
      previous: {
        facts: previous.artifact.factArtifact,
        metric: previous.artifact.metricReport,
        shadow: previous.artifact.shadowReport,
      },
      current: {
        facts: factBinding,
        metric: reportBindings.metric,
        shadow: reportBindings.shadow,
      },
    },
    rollbacks: rollbackBindings,
    promotionInput,
    verificationInput,
    promotion: child.promotion,
    persistedPromotion: child.persistedPromotion,
    transition: child.transition,
    persistedState: child.persistedStatus.state,
    persistedEvidenceSha256: child.persistedEvidenceSha256,
    persistedJournalSha256: child.persistedJournalSha256,
    database: {
      pathSha256: databasePathSha256,
      sha256: database.sha256,
      byteLength: database.byteLength,
    },
    isolation: {
      productionDatabaseInherited: false,
      productionProcessUsed: false,
      networkPortsUsed: [],
      writerProcessSha256: sha256(String(child.process.pid)),
      verifierProcessSha256: sha256(String(verification.verifierPid)),
      databaseAttestationSha256,
      processRestartVerified: true,
    },
    status: "pass",
    createdAt: Date.now(),
  }
  return {
    ...result,
    promotionResult: await writeJSON(outputDirectory, "promotion-result.json", result),
  }
}

async function promote(request: z.infer<typeof PromoteRequest>, inputSha256: string, outputDirectory: string) {
  verifyCurrentCandidate(request.current)
  const previous = await revalidateBootstrap(request.previousBootstrap)
  if (previous.artifact.candidate.targetRef !== request.current.targetRef)
    fail("invalid", "Previous and current candidates use different target refs")
  if (previous.artifact.candidate.verifierSha !== request.current.verifierSha)
    fail("invalid", "Previous and current candidates use different pinned verifiers")
  const ancestry = verifyDirectParent(previous.artifact.candidate.candidateSha, request.current.candidateSha)
  const current = await validateCandidate(request.current)
  const factBinding = await writeJSON(outputDirectory, "current-candidate-facts.json", current.mergedFacts)
  const reportBindings = await writeReports(outputDirectory, "current-", current.reports)
  if (current.status !== "pass") stageStatusError(current.status, "Current candidate reports")
  if (!same(previous.validated.contract, current.contract))
    fail("invalid", "Previous and current candidates use different metric contracts")
  return isolatedPromotion(
    request,
    inputSha256,
    outputDirectory,
    previous,
    current,
    factBinding,
    reportBindings,
    ancestry,
  )
}

function requestErrorStatus(error: z.ZodError) {
  return error.issues.some((issue) => issue.code === "invalid_type" && "input" in issue && issue.input === undefined)
    ? "blocked"
    : "invalid"
}

async function execute(requestPath: string) {
  if (!path.isAbsolute(requestPath)) fail("invalid", "Request path must be absolute")
  const input = await regularFile(requestPath, "Pre-Public gate request")
  const raw = await Promise.resolve()
    .then(() => JSON.parse(input.source) as unknown)
    .catch(() => fail("invalid", "Pre-Public gate request is not valid JSON"))
  const parsed = Request.safeParse(raw)
  if (!parsed.success)
    fail(requestErrorStatus(parsed.error), `Pre-Public gate request is malformed: ${z.prettifyError(parsed.error)}`)
  verifyCurrentCandidate(parsed.data.mode === "bootstrap" ? parsed.data.candidate : parsed.data.current)
  const outputDirectory = await emptyDirectory(parsed.data.outputDirectory, "Gate output directory")
  const candidate = parsed.data.mode === "bootstrap" ? parsed.data.candidate : parsed.data.current
  const operation = await (
    parsed.data.mode === "bootstrap"
      ? bootstrap(parsed.data, input.sha256, outputDirectory)
      : promote(parsed.data, input.sha256, outputDirectory)
  ).catch((error) => ({
    schemaVersion: 1,
    kind: "seed-grow-pre-public-gate-decision",
    mode: parsed.data.mode,
    inputSha256: input.sha256,
    status: error instanceof PrePublicGateError ? error.status : ("invalid" as const),
    reasons: [redacted(error)],
  }))
  const result = await Promise.resolve()
    .then(() => {
      verifyCurrentCandidate(candidate)
      return operation
    })
    .catch((error) => ({
      schemaVersion: 1,
      kind: "seed-grow-pre-public-gate-decision",
      mode: parsed.data.mode,
      inputSha256: input.sha256,
      status: error instanceof PrePublicGateError ? error.status : ("invalid" as const),
      reasons: [redacted(error)],
    }))
  const decision = await writeJSON(outputDirectory, "decision.json", result)
  return { ...result, decision }
}

function redacted(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replaceAll(root, "<repo>")
    .replaceAll(process.env.HOME ?? "\u0000", "<home>")
    .slice(0, 8_000)
}

async function main() {
  if (Bun.argv[2] === "--promotion-child" || Bun.argv[2] === "--promotion-verify-child") {
    const inputPath = Bun.argv[3]
    if (!inputPath) throw new Error("Promotion child input path is required")
    const childResult = await (Bun.argv[2] === "--promotion-child"
      ? executePromotionChild(inputPath)
      : executePromotionVerificationChild(inputPath))
    process.stdout.write(`${JSON.stringify(childResult)}\n`)
    return
  }
  const requestPath = Bun.argv[2]
  const result = requestPath
    ? await execute(requestPath).catch((error) => {
        const status = error instanceof PrePublicGateError ? error.status : ("invalid" as const)
        return {
          schemaVersion: 1,
          kind: "seed-grow-pre-public-gate-decision",
          status,
          reasons: [redacted(error)],
        }
      })
    : {
        schemaVersion: 1,
        kind: "seed-grow-pre-public-gate-decision",
        status: "blocked" as const,
        reasons: ["Usage: bun script/seed-grow-pre-public-gate.ts /absolute/request.json"],
      }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode =
    result.status === "pass" ? 0 : result.status === "failed" ? 1 : result.status === "blocked" ? 2 : 64
}

if (import.meta.main)
  await main().catch((error) => {
    process.stderr.write(`${redacted(error)}\n`)
    process.exitCode = 64
  })
