import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const contractPath = "docs/product-design/founder-os/w0-gate-contract.v1.json"
const runnerPath = "script/founder-os-boundary.ts"
const requiredWorkerPaths = [
  "packages/control-plane/src/agent-run/agent-run.ts",
  "packages/control-plane/src/company-project/execution.ts",
  "packages/control-plane/src/company-project/work-facts.ts",
]
const requiredNegativeCases = [
  {
    id: "founder-runtime-import",
    sourceKind: "founder",
    specifier: "@/runtime",
    expectedRule: "founder_twin_dependency",
  },
  {
    id: "founder-tool-import",
    sourceKind: "founder",
    specifier: "@/tool",
    expectedRule: "founder_twin_dependency",
  },
  {
    id: "founder-recruitment-import",
    sourceKind: "founder",
    specifier: "@/company-recruitment",
    expectedRule: "founder_twin_dependency",
  },
  {
    id: "founder-graph-mutation-import",
    sourceKind: "founder",
    specifier: "@/project-orchestrator/graph-mutation",
    expectedRule: "founder_twin_dependency",
  },
  {
    id: "worker-graph-supervisor-import",
    sourceKind: "worker",
    specifier: "@/project-orchestrator/graph-supervisor",
    expectedRule: "worker_graph_supervisor",
  },
] as const

type BoundaryContract = {
  boundary: {
    sourceRoots: string[]
    sourceExtensions: string[]
    founderTwinForbiddenSpecifierPrefixes: string[]
    founderTwinForbiddenPathPrefixes: string[]
    graphMutationSpecifierFragments: string[]
    governedWorkerPaths: string[]
    governedWorkerMinCount: number
    sharedContractPath: string
    sharedContractForbiddenSpecifierPrefixes: string[]
    negativeCases: {
      id: string
      sourceKind: "founder" | "worker"
      specifier: string
      expectedRule: "founder_twin_dependency" | "worker_graph_supervisor"
    }[]
  }
}

type Violation = {
  rule:
    | "founder_twin_dependency"
    | "worker_graph_supervisor"
    | "worker_inventory"
    | "shared_contract_dependency"
  sourcePath: string
  specifier: string
  resolvedPath: string | null
}

export type BoundaryReport = {
  schemaVersion: number
  reportVersion: string
  buildSha: string
  buildTreeSha: string
  contractBinding: {
    path: string
    sha256: string
  }
  runnerBinding: {
    path: string
    sha256: string
  }
  scanned: {
    founderFiles: string[]
    workerFiles: string[]
    sharedContractFiles: string[]
  }
  violations: Violation[]
  status: "pass" | "failed"
}

export type BoundaryNegativeReport = {
  schemaVersion: number
  reportVersion: string
  buildSha: string
  buildTreeSha: string
  contractBinding: {
    path: string
    sha256: string
  }
  runnerBinding: {
    path: string
    sha256: string
  }
  cases: {
    id: string
    sourceKind: "founder" | "worker"
    specifier: string
    expectedRule: "founder_twin_dependency" | "worker_graph_supervisor"
    actualRules: Violation["rule"][]
    status: "pass" | "failed"
  }[]
  status: "pass" | "failed"
}

function sha256(value: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function runGit(args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`)
  }
  return result.stdout.toString()
}

function exactCommit(value: string) {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("--ref must be a full lowercase commit SHA")
  if (runGit(["rev-parse", `${value}^{commit}`]).trim() !== value) {
    throw new Error("--ref must identify the exact commit")
  }
  return value
}

function readAtRef(ref: string, file: string) {
  return runGit(["show", `${ref}:${file}`])
}

function importSpecifiers(source: string) {
  return [
    ...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^;"'\n]*?\s+from\s+)?["']([^"']+)["']/g),
    ...source.matchAll(/(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].flatMap((match) => (match[1] ? [match[1]] : []))
}

function resolvedImport(sourcePath: string, specifier: string) {
  if (specifier.startsWith("@/")) {
    return path.posix.join("packages/control-plane/src", specifier.slice(2))
  }
  if (!specifier.startsWith(".")) return null
  return path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier))
}

function matchesPathPrefix(resolvedPath: string | null, prefix: string) {
  if (!resolvedPath) return false
  if (prefix.endsWith("/")) return resolvedPath.startsWith(prefix)
  return (
    resolvedPath === prefix ||
    resolvedPath === prefix.replace(/\.[cm]?[jt]sx?$/, "") ||
    resolvedPath.startsWith(`${prefix.replace(/\.[cm]?[jt]sx?$/, "")}.`)
  )
}

function sourceBinding(path: string, source: string) {
  return { path, sha256: sha256(source) }
}

function classifySpecifier(
  contract: BoundaryContract,
  sourceKind: "founder" | "worker",
  sourcePath: string,
  specifier: string,
) {
  const resolvedPath = resolvedImport(sourcePath, specifier)
  if (
    sourceKind === "founder" &&
    (contract.boundary.founderTwinForbiddenSpecifierPrefixes.some(
      (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
    ) ||
      contract.boundary.founderTwinForbiddenPathPrefixes.some((prefix) =>
        matchesPathPrefix(resolvedPath, prefix),
      ) ||
      contract.boundary.graphMutationSpecifierFragments.some((fragment) =>
        specifier.toLowerCase().includes(fragment),
      ))
  ) {
    return [
      {
        rule: "founder_twin_dependency" as const,
        sourcePath,
        specifier,
        resolvedPath,
      },
    ]
  }
  if (
    sourceKind === "worker" &&
    contract.boundary.graphMutationSpecifierFragments.some((fragment) =>
      specifier.toLowerCase().includes(fragment),
    )
  ) {
    return [
      {
        rule: "worker_graph_supervisor" as const,
        sourcePath,
        specifier,
        resolvedPath,
      },
    ]
  }
  return []
}

export function normalizedFounderOSBoundaryReport(report: BoundaryReport) {
  return {
    schemaVersion: report.schemaVersion,
    reportVersion: report.reportVersion,
    buildSha: report.buildSha,
    buildTreeSha: report.buildTreeSha,
    contractBinding: report.contractBinding,
    runnerBinding: report.runnerBinding,
    scanned: report.scanned,
    violations: report.violations,
    status: report.status,
  }
}

export function normalizedFounderOSBoundaryNegativeReport(report: BoundaryNegativeReport) {
  return {
    schemaVersion: report.schemaVersion,
    reportVersion: report.reportVersion,
    buildSha: report.buildSha,
    buildTreeSha: report.buildTreeSha,
    contractBinding: report.contractBinding,
    runnerBinding: report.runnerBinding,
    cases: report.cases,
    status: report.status,
  }
}

export async function evaluateFounderOSBoundary(buildSha: string) {
  const ref = exactCommit(buildSha)
  const contractSource = readAtRef(ref, contractPath)
  const runnerSource = readAtRef(ref, runnerPath)
  const contract = JSON.parse(contractSource) as BoundaryContract
  const files = runGit(["ls-tree", "-r", "--name-only", ref])
    .split("\n")
    .filter(Boolean)
  const founderFiles = files.filter(
    (file) =>
      contract.boundary.sourceRoots.some((sourceRoot) => file.startsWith(sourceRoot)) &&
      contract.boundary.sourceExtensions.some((extension) => file.endsWith(extension)),
  )
  const workerFiles = contract.boundary.governedWorkerPaths.filter((file) => files.includes(file))
  const sharedFiles = files.includes(contract.boundary.sharedContractPath)
    ? [contract.boundary.sharedContractPath]
    : []
  const violations: Violation[] = []
  for (const file of founderFiles) {
    for (const specifier of importSpecifiers(readAtRef(ref, file))) {
      violations.push(...classifySpecifier(contract, "founder", file, specifier))
    }
  }
  for (const file of workerFiles) {
    for (const specifier of importSpecifiers(readAtRef(ref, file))) {
      violations.push(...classifySpecifier(contract, "worker", file, specifier))
    }
  }
  for (const file of contract.boundary.governedWorkerPaths.filter((file) => !files.includes(file))) {
    violations.push({
      rule: "worker_inventory",
      sourcePath: file,
      specifier: "missing",
      resolvedPath: null,
    })
  }
  if (
    JSON.stringify(contract.boundary.governedWorkerPaths) !==
      JSON.stringify(requiredWorkerPaths) ||
    contract.boundary.governedWorkerMinCount !== requiredWorkerPaths.length ||
    contract.boundary.governedWorkerMinCount <= 0 ||
    contract.boundary.governedWorkerPaths.length < contract.boundary.governedWorkerMinCount ||
    workerFiles.length < contract.boundary.governedWorkerMinCount
  ) {
    violations.push({
      rule: "worker_inventory",
      sourcePath: "boundary.governedWorkerPaths",
      specifier: `minimum:${contract.boundary.governedWorkerMinCount};actual:${workerFiles.length}`,
      resolvedPath: null,
    })
  }
  for (const file of sharedFiles) {
    for (const specifier of importSpecifiers(readAtRef(ref, file))) {
      if (
        contract.boundary.sharedContractForbiddenSpecifierPrefixes.some(
          (prefix) => specifier === prefix || specifier.startsWith(prefix),
        )
      ) {
        violations.push({
          rule: "shared_contract_dependency",
          sourcePath: file,
          specifier,
          resolvedPath: resolvedImport(file, specifier),
        })
      }
    }
  }
  if (!sharedFiles.length) {
    violations.push({
      rule: "shared_contract_dependency",
      sourcePath: contract.boundary.sharedContractPath,
      specifier: "missing",
      resolvedPath: null,
    })
  }
  const report = {
    schemaVersion: 1,
    reportVersion: "1.0.0",
    buildSha: ref,
    buildTreeSha: runGit(["rev-parse", `${ref}^{tree}`]).trim(),
    contractBinding: sourceBinding(contractPath, contractSource),
    runnerBinding: sourceBinding(runnerPath, runnerSource),
    scanned: {
      founderFiles: founderFiles.sort(),
      workerFiles: workerFiles.sort(),
      sharedContractFiles: sharedFiles,
    },
    violations: violations.sort((left, right) =>
      `${left.rule}:${left.sourcePath}:${left.specifier}`.localeCompare(
        `${right.rule}:${right.sourcePath}:${right.specifier}`,
      ),
    ),
    status: violations.length ? ("failed" as const) : ("pass" as const),
  }
  return {
    ...report,
    normalizedDigest: sha256(JSON.stringify(normalizedFounderOSBoundaryReport(report))),
  }
}

export async function evaluateFounderOSBoundaryNegative(buildSha: string) {
  const ref = exactCommit(buildSha)
  const contractSource = readAtRef(ref, contractPath)
  const runnerSource = readAtRef(ref, runnerPath)
  const contract = JSON.parse(contractSource) as BoundaryContract
  const inventoryMatches =
    JSON.stringify(contract.boundary.negativeCases) === JSON.stringify(requiredNegativeCases)
  const cases = contract.boundary.negativeCases.map((item) => {
    const actualRules = classifySpecifier(
      contract,
      item.sourceKind,
      item.sourceKind === "founder"
        ? "packages/control-plane/src/founder-os/__negative_injection__.ts"
        : contract.boundary.governedWorkerPaths[0] ?? "packages/control-plane/src/__worker__.ts",
      item.specifier,
    ).map((violation) => violation.rule)
    return {
      ...item,
      actualRules,
      status: actualRules.includes(item.expectedRule) ? ("pass" as const) : ("failed" as const),
    }
  })
  const report = {
    schemaVersion: 1,
    reportVersion: "1.0.0",
    buildSha: ref,
    buildTreeSha: runGit(["rev-parse", `${ref}^{tree}`]).trim(),
    contractBinding: sourceBinding(contractPath, contractSource),
    runnerBinding: sourceBinding(runnerPath, runnerSource),
    cases,
    status:
      inventoryMatches && cases.every((item) => item.status === "pass")
        ? ("pass" as const)
        : ("failed" as const),
  }
  return {
    ...report,
    normalizedDigest: sha256(JSON.stringify(normalizedFounderOSBoundaryNegativeReport(report))),
  }
}

function parseArguments(args: string[]) {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key || !["--ref", "--check", "--out"].includes(key)) {
      throw new Error(`Unknown argument: ${key ?? ""}`)
    }
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`)
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`)
    values.set(key, value)
  }
  if (!values.has("--ref") || !values.has("--check") || !values.has("--out")) {
    throw new Error(
      "Required arguments: --ref <full-sha> --check <production|negative> --out <boundary-report.json>",
    )
  }
  const check = values.get("--check")
  if (check !== "production" && check !== "negative") throw new Error("Invalid --check")
  return {
    buildSha: values.get("--ref")!,
    check,
    outputPath: path.resolve(values.get("--out")!),
  }
}

if (import.meta.main) {
  await Promise.resolve()
    .then(async () => {
      const options = parseArguments(Bun.argv.slice(2))
      const report =
        options.check === "production"
          ? await evaluateFounderOSBoundary(options.buildSha)
          : await evaluateFounderOSBoundaryNegative(options.buildSha)
      await Bun.write(options.outputPath, `${JSON.stringify(report, null, 2)}\n`)
      console.log(JSON.stringify(report, null, 2))
      process.exitCode = report.status === "pass" ? 0 : 1
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 64
    })
}
