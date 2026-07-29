import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const contractPath = "docs/product-design/founder-os/w0-gate-contract.v1.json"
const runnerPath = "script/founder-os-boundary.ts"

type BoundaryContract = {
  boundary: {
    sourceRoots: string[]
    sourceExtensions: string[]
    founderTwinForbiddenSpecifierPrefixes: string[]
    founderTwinForbiddenPathPrefixes: string[]
    graphMutationSpecifierFragments: string[]
    workerPathFragments: string[]
    sharedContractPath: string
    sharedContractForbiddenSpecifierPrefixes: string[]
  }
}

type Violation = {
  rule: "founder_twin_dependency" | "worker_graph_supervisor" | "shared_contract_dependency"
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
  const workerFiles = files.filter(
    (file) =>
      file.startsWith("packages/control-plane/src/") &&
      contract.boundary.sourceExtensions.some((extension) => file.endsWith(extension)) &&
      contract.boundary.workerPathFragments.some((fragment) => file.includes(fragment)),
  )
  const sharedFiles = files.includes(contract.boundary.sharedContractPath)
    ? [contract.boundary.sharedContractPath]
    : []
  const violations: Violation[] = []
  for (const file of founderFiles) {
    for (const specifier of importSpecifiers(readAtRef(ref, file))) {
      const resolvedPath = resolvedImport(file, specifier)
      if (
        contract.boundary.founderTwinForbiddenSpecifierPrefixes.some(
          (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
        ) ||
        contract.boundary.founderTwinForbiddenPathPrefixes.some((prefix) =>
          matchesPathPrefix(resolvedPath, prefix),
        ) ||
        contract.boundary.graphMutationSpecifierFragments.some((fragment) =>
          specifier.toLowerCase().includes(fragment),
        )
      ) {
        violations.push({
          rule: "founder_twin_dependency",
          sourcePath: file,
          specifier,
          resolvedPath,
        })
      }
    }
  }
  for (const file of workerFiles) {
    for (const specifier of importSpecifiers(readAtRef(ref, file))) {
      if (
        contract.boundary.graphMutationSpecifierFragments.some((fragment) =>
          specifier.toLowerCase().includes(fragment),
        )
      ) {
        violations.push({
          rule: "worker_graph_supervisor",
          sourcePath: file,
          specifier,
          resolvedPath: resolvedImport(file, specifier),
        })
      }
    }
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

function parseArguments(args: string[]) {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key || !["--ref", "--out"].includes(key)) throw new Error(`Unknown argument: ${key ?? ""}`)
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`)
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`)
    values.set(key, value)
  }
  if (!values.has("--ref") || !values.has("--out")) {
    throw new Error("Required arguments: --ref <full-sha> --out <boundary-report.json>")
  }
  return {
    buildSha: values.get("--ref")!,
    outputPath: path.resolve(values.get("--out")!),
  }
}

if (import.meta.main) {
  await Promise.resolve()
    .then(async () => {
      const options = parseArguments(Bun.argv.slice(2))
      const report = await evaluateFounderOSBoundary(options.buildSha)
      await Bun.write(options.outputPath, `${JSON.stringify(report, null, 2)}\n`)
      console.log(JSON.stringify(report, null, 2))
      process.exitCode = report.status === "pass" ? 0 : 1
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 64
    })
}
