import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const contractDirectory = path.join(root, "docs/product-design/experience-refactor")

function runGit(args: string[], allowedExitCodes = [0]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!allowedExitCodes.includes(result.exitCode)) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} exited ${result.exitCode}`)
  }
  return result.stdout.toString()
}

function readAt(ref: string, file: string) {
  return runGit(["show", `${ref}:${file}`])
}

function existsAt(ref: string, file: string) {
  return (
    Bun.spawnSync(["git", "cat-file", "-e", `${ref}:${file}`], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0
  )
}

function scanAt(ref: string, pattern: string, files: string[]) {
  return runGit(["grep", "-n", "-I", "-E", pattern, ref, "--", ...files], [0, 1])
    .split("\n")
    .filter(Boolean)
}

function digest(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function evidence(lines: string[]) {
  return {
    count: lines.length,
    samples: lines.slice(0, 8),
  }
}

export async function collectBaseline(ref = "HEAD", contractRef = "HEAD") {
  const commitSha = runGit(["rev-parse", `${ref}^{commit}`]).trim()
  const contractCommitSha = runGit(["rev-parse", `${contractRef}^{commit}`]).trim()
  const moduleSource = readAt(commitSha, "packages/app/modules/agent-company/module.ts")
  const appPackageSource = readAt(commitSha, "packages/app/package.json")
  const navigationLabels = [...moduleSource.matchAll(/label:\s*["']([^"']+)["']/g)].map((match) => match[1])
  const desiredNavigation = ["Inbox", "Work", "Team", "Library", "Settings"]
  const appTestCommand = appPackageSource
    ? (JSON.parse(appPackageSource) as { scripts?: Record<string, string> }).scripts?.test
    : undefined
  const benchmarkSource = readAt(
    contractCommitSha,
    "docs/product-design/experience-refactor/benchmark-scenarios.v1.json",
  )
  const metricContract = JSON.parse(readAt(
    contractCommitSha,
    "docs/product-design/experience-refactor/metric-contract.v1.json",
  )) as {
    metrics: Array<{ id: string; collectionMode: string }>
  }
  const benchmark = JSON.parse(benchmarkSource) as {
    humanResearchItems: Array<{
      id: string
      status: string
      completionStatus: string
      automationSubstituteAllowed: boolean
    }>
  }
  const appPaths = [
    "packages/app/app",
    "packages/app/modules/agent-company",
    "packages/app/nuxt.config.ts",
    "packages/app/shared",
  ]

  return {
    schemaVersion: 1,
    id: "agent-company-current-head-baseline",
    baselineKind: "committed_source_and_measurement_readiness",
    refRequested: ref,
    commitSha,
    contractCommitSha,
    commitTime: runGit(["show", "-s", "--format=%cI", commitSha]).trim(),
    subjectTree: "subject evidence comes from commitSha; governance contracts come from contractCommitSha; worktree changes are excluded",
    collector: "script/experience-baseline.ts",
    scenarioContract: {
      commitSha: contractCommitSha,
      path: "docs/product-design/experience-refactor/benchmark-scenarios.v1.json",
      sha256: digest(benchmarkSource),
    },
    metricContract: {
      commitSha: contractCommitSha,
      path: "docs/product-design/experience-refactor/metric-contract.v1.json",
      sha256: digest(readAt(contractCommitSha, "docs/product-design/experience-refactor/metric-contract.v1.json")),
    },
    staticEvidence: {
      canonicalPlanTracked: existsAt(commitSha, "docs/product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md"),
      primaryNavigation: {
        observedLabels: navigationLabels,
        requiredLabels: desiredNavigation,
        requiredLabelCount: navigationLabels.filter((label) => desiredNavigation.includes(label)).length,
      },
      domNavigationInjection: evidence(
        scanAt(commitSha, "MutationObserver|CompanyModuleLauncher|company-module-launcher", appPaths),
      ),
      productionFixtureFallback: evidence(
        scanAt(commitSha, "const fixture|return fixture|Demo fallback|deterministic module data", appPaths),
      ),
      legacyProductSignatures: evidence(
        scanAt(
          commitSha,
          "A durable AI assistant|Built with Eve|V account|Slack|iMessage|Linear|Source protection",
          appPaths,
        ),
      ),
      rawUserStateSignatures: evidence(
        scanAt(commitSha, "projecting|bidding|raw status|dependency ID|Provider ID", appPaths),
      ),
      webuiTestCommand: appTestCommand ?? null,
      webuiTestGateRegistered: Boolean(
        appTestCommand && !/No standalone WebUI tests are registered|^echo\b/i.test(appTestCommand),
      ),
    },
    metricEvidence: metricContract.metrics.map((metric) => ({
      metricId: metric.id,
      value: null,
      status: metric.collectionMode === "human_research" ? "not_scheduled" : "not_collectable",
      reason:
        metric.collectionMode === "human_research"
          ? "No eligible human study is recorded for this committed build."
          : "The committed build has no complete benchmark event envelope and runner for this metric.",
    })),
    humanResearch: benchmark.humanResearchItems.map((item) => ({
      id: item.id,
      status: item.status,
      completionStatus: item.completionStatus,
      automationSubstituteAllowed: item.automationSubstituteAllowed,
      result: null,
      rule: "Do not infer a result from source code, fixtures, or agent judgment.",
    })),
  }
}

function argument(name: string) {
  const index = Bun.argv.indexOf(name)
  return index >= 0 ? Bun.argv[index + 1] : undefined
}

async function requestedRefs() {
  if (!Bun.argv.includes("--recorded-head")) {
    return {
      ref: argument("--ref") ?? "HEAD",
      contractRef: argument("--contract-ref") ?? "HEAD",
    }
  }
  const recorded = (
    (await Bun.file(path.join(contractDirectory, "baselines/current-head.v1.json")).json()) as {
      commitSha: string
      contractCommitSha: string
    }
  )
  return {
    ref: recorded.commitSha,
    contractRef: recorded.contractCommitSha,
  }
}

if (import.meta.main) {
  const requested = await requestedRefs()
  console.log(JSON.stringify(await collectBaseline(requested.ref, requested.contractRef), null, 2))
}
