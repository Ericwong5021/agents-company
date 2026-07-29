import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const contractPath = "docs/product-design/founder-os/w0-gate-contract.v1.json"
const runnerPath = "script/founder-os-contract.ts"

export type FounderOSContractCheck =
  | "governed-files"
  | "flag-defaults"
  | "flag-invalid-values"
  | "contract-roundtrip"
  | "correction-append-only"
  | "typed-action-unknown-reject"
  | "sdk-consistency"

type GateContract = {
  taskIds: string[]
  governedPaths: string[]
  commandRegistry: {
    id: string
    runner: string
    check: string
    reportPath: string
  }[]
  taskEvidence: Record<string, string[]>
}

export type ContractCheckReport = {
  schemaVersion: number
  reportVersion: string
  checkId: FounderOSContractCheck
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
  assertions: {
    id: string
    status: "pass" | "failed"
    detail: string
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
  if (runGit(["rev-parse", "HEAD"]).trim() !== value) {
    throw new Error("Contract checks must run from the exact candidate worktree")
  }
  return value
}

function readAtRef(ref: string, file: string) {
  return runGit(["show", `${ref}:${file}`])
}

function existsAtRef(ref: string, file: string) {
  const result = Bun.spawnSync(["git", "cat-file", "-e", `${ref}:${file}`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  return result.exitCode === 0
}

function assertion(id: string, passed: boolean, detail: string) {
  return { id, status: passed ? ("pass" as const) : ("failed" as const), detail }
}

function childEnvironment(overrides: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

function runFlagProbe(overrides: Record<string, string | undefined>) {
  const source = `
    const { Flag } = await import("./packages/control-plane/src/flag/flag.ts")
    console.log(JSON.stringify({
      founderTwinMode: Flag.AGENTCOMPANY_FOUNDER_TWIN_MODE,
      companyCommonsMode: Flag.AGENTCOMPANY_COMPANY_COMMONS_MODE,
    }))
  `
  const result = Bun.spawnSync(["bun", "--eval", source], {
    cwd: root,
    env: childEnvironment(overrides),
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
  }
}

async function governedFiles(ref: string, contract: GateContract) {
  const commandIds = contract.commandRegistry.map((command) => command.id)
  const taskIds = Object.keys(contract.taskEvidence)
  return [
    assertion(
      "task-evidence-exact-task-set",
      JSON.stringify([...taskIds].sort()) === JSON.stringify([...contract.taskIds].sort()),
      `${taskIds.length}/${contract.taskIds.length} tasks mapped`,
    ),
    assertion(
      "task-evidence-nonempty",
      contract.taskIds.every((taskId) => (contract.taskEvidence[taskId]?.length ?? 0) > 0),
      "Every required task has explicit command evidence",
    ),
    assertion(
      "task-evidence-known-commands",
      Object.values(contract.taskEvidence)
        .flat()
        .every((commandId) => commandIds.includes(commandId)),
      "Every task evidence reference resolves to the command registry",
    ),
    assertion(
      "command-registry-unique",
      new Set(commandIds).size === commandIds.length,
      `${commandIds.length} command IDs`,
    ),
    assertion(
      "command-registry-fully-bound",
      commandIds.every((commandId) =>
        Object.values(contract.taskEvidence).some((evidence) => evidence.includes(commandId)),
      ),
      "Every command is required by at least one task",
    ),
    assertion(
      "governed-paths-present",
      contract.governedPaths.every((file) => existsAtRef(ref, file)),
      `${contract.governedPaths.filter((file) => existsAtRef(ref, file)).length}/${contract.governedPaths.length} governed paths present`,
    ),
  ]
}

async function flagDefaults() {
  const probe = runFlagProbe({
    AGENTCOMPANY_FOUNDER_TWIN_MODE: undefined,
    AGENTCOMPANY_COMPANY_COMMONS_MODE: undefined,
  })
  return [
    assertion("flag-default-probe-exit", probe.exitCode === 0, `exit:${probe.exitCode}`),
    assertion(
      "founder-twin-default-off",
      probe.stdout === '{"founderTwinMode":"off","companyCommonsMode":"off"}',
      probe.stdout || "no output",
    ),
    assertion(
      "company-commons-default-off",
      probe.stdout === '{"founderTwinMode":"off","companyCommonsMode":"off"}',
      probe.stdout || "no output",
    ),
  ]
}

async function flagInvalidValues() {
  const founder = runFlagProbe({
    AGENTCOMPANY_FOUNDER_TWIN_MODE: "__invalid__",
    AGENTCOMPANY_COMPANY_COMMONS_MODE: undefined,
  })
  const commons = runFlagProbe({
    AGENTCOMPANY_FOUNDER_TWIN_MODE: undefined,
    AGENTCOMPANY_COMPANY_COMMONS_MODE: "__invalid__",
  })
  return [
    assertion(
      "founder-twin-invalid-rejected",
      founder.exitCode !== 0,
      `exit:${founder.exitCode}`,
    ),
    assertion(
      "company-commons-invalid-rejected",
      commons.exitCode !== 0,
      `exit:${commons.exitCode}`,
    ),
  ]
}

async function contractRoundtrip() {
  const shared = await import(path.join(root, "packages/shared/src/founder-os.ts"))
  const controlPlane = await import(path.join(root, "packages/control-plane/src/founder-os/schema.ts"))
  const values = [
    {
      schemaVersion: 1,
      decisionId: "decision-roundtrip",
      recommendation: "Use the governed path.",
      alternatives: ["Keep the current path."],
      authorityClass: "yellow",
      confidence: 0.8,
      principlesApplied: [{ assetId: "principle-1", version: 1 }],
      evidenceRefs: [{ kind: "artifact", id: "artifact-1", version: 1 }],
      requestedAction: {
        schemaVersion: 1,
        type: "project.goal.propose",
        idempotencyKey: "action-roundtrip",
        payload: { goal: "Propose a bounded goal." },
      },
    },
    {
      schemaVersion: 1,
      correctionId: "correction-roundtrip",
      decisionId: "decision-roundtrip",
      originalRecommendation: "Original",
      humanDecision: "Corrected",
      correctionReason: "Founder correction",
      proposedAssetUpdates: ["Draft a principle update"],
      createdAt: "2026-07-30T00:00:00.000Z",
    },
  ] as const
  const schemas = [
    [shared.DecisionIntent, controlPlane.DecisionIntent],
    [shared.FounderCorrection, controlPlane.FounderCorrection],
  ] as const
  const results = schemas.map((pair, index) => {
    const encoded = JSON.stringify(pair[0].parse(values[index]))
    return encoded === JSON.stringify(pair[1].parse(JSON.parse(encoded)))
  })
  return [
    assertion("decision-intent-shared-control-plane-roundtrip", results[0] === true, "schemaVersion:1"),
    assertion("founder-correction-shared-control-plane-roundtrip", results[1] === true, "schemaVersion:1"),
    assertion(
      "control-plane-schema-reexports-shared",
      shared.DecisionIntent === controlPlane.DecisionIntent &&
        shared.FounderCorrection === controlPlane.FounderCorrection &&
        shared.FounderRequestedAction === controlPlane.FounderRequestedAction,
      "Shared schemas are the Control Plane runtime contract",
    ),
  ]
}

async function correctionAppendOnly(ref: string) {
  const authority = readAtRef(ref, "packages/control-plane/src/founder-os/authority.ts")
  const sql = readAtRef(ref, "packages/control-plane/src/founder-os/decision-ledger.sql.ts")
  const sdk = readAtRef(ref, "packages/sdk/js/src/v2/founder-os.ts")
  const correctionClient = sdk.slice(
    sdk.indexOf("correct(input: FounderCorrectionAppendInput)"),
    sdk.indexOf("correct(input: FounderCorrectionAppendInput)") + 500,
  )
  const migrations = runGit(["ls-tree", "-r", "--name-only", ref])
    .split("\n")
    .filter((file) => file.includes("migration/") && file.endsWith("migration.sql"))
  const migrationDefinesCorrection = migrations.some((file) =>
    readAtRef(ref, file).includes("founder_decision_correction"),
  )
  return [
    assertion(
      "correction-table-defined",
      sql.includes('sqliteTable(\n  "founder_decision_correction"'),
      "FounderCorrection has a dedicated append table",
    ),
    assertion(
      "correction-idempotency-unique",
      sql.includes("founder_decision_correction_idempotency_idx") &&
        sql.includes("uniqueIndex"),
      "Company and idempotency key are unique",
    ),
    assertion(
      "correction-migration-present",
      migrationDefinesCorrection,
      "A committed migration creates the correction table",
    ),
    assertion(
      "correction-service-insert-only",
      authority.includes("db.insert(FounderCorrectionTable)") &&
        !authority.includes("db.update(FounderCorrectionTable)") &&
        !authority.includes("db.delete(FounderCorrectionTable)"),
      "Correction service exposes no update or delete write",
    ),
    assertion(
      "correction-sdk-append-only",
      correctionClient.includes(
        'request<FounderCorrectionRecord>("/company/founder-os/corrections", json(input))',
      ) &&
        !correctionClient.includes('method: "PUT"') &&
        !correctionClient.includes('method: "PATCH"') &&
        !correctionClient.includes('method: "DELETE"'),
      "SDK exposes correction append only",
    ),
  ]
}

async function typedActionUnknownReject() {
  const shared = await import(path.join(root, "packages/shared/src/founder-os.ts"))
  const base = {
    schemaVersion: 1,
    idempotencyKey: "unknown-action",
    payload: {},
  }
  const unknown = shared.FounderRequestedAction.safeParse({
    ...base,
    type: "unknown.action",
  })
  const untypedPayload = shared.DecisionIntent.safeParse({
    schemaVersion: 1,
    decisionId: "unknown-action-decision",
    recommendation: "Reject unknown action",
    alternatives: [],
    authorityClass: "red",
    confidence: 1,
    principlesApplied: [],
    evidenceRefs: [],
    requestedAction: { ...base, type: "project.goal.propose", payload: { arbitrary: true } },
  })
  return [
    assertion("unknown-action-rejected", !unknown.success, "Discriminated union is closed"),
    assertion(
      "unknown-action-payload-rejected",
      !untypedPayload.success,
      "Typed action payload is strict",
    ),
  ]
}

async function sdkConsistency(ref: string) {
  const shared = await import(path.join(root, "packages/shared/src/founder-os.ts"))
  const sdk = readAtRef(ref, "packages/sdk/js/src/v2/founder-os.ts")
  const controlPlane = readAtRef(ref, "packages/control-plane/src/founder-os/schema.ts").trim()
  const actionContracts = sdk.slice(0, sdk.indexOf("export const FounderRequestedActionPolicy"))
  const sdkActions = [...actionContracts.matchAll(/type:\s*"([^"]+)"/g)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  )
  const sharedActions = shared.FounderRequestedAction.options.map((option) => option.shape.type.value)
  const modeValues = [
    ...shared.FounderTwinMode.options,
    ...shared.CompanyCommonsMode.options,
  ] as string[]
  return [
    assertion(
      "sdk-requested-action-union",
      JSON.stringify([...new Set(sdkActions)].sort()) === JSON.stringify([...sharedActions].sort()),
      `${sdkActions.length}/${sharedActions.length} action types`,
    ),
    assertion(
      "sdk-action-policy-complete",
      sharedActions.every((action: string) => sdk.includes(`"${action}": {`)),
      "SDK policy contains every Shared action",
    ),
    assertion(
      "sdk-mode-unions-complete",
      modeValues.every((value) => sdk.includes(`"${value}"`)),
      `${modeValues.length} mode literals`,
    ),
    assertion(
      "sdk-decision-intent-typed-action",
      sdk.includes("requestedAction?: FounderRequestedAction"),
      "DecisionIntent uses the closed action union",
    ),
    assertion(
      "control-plane-shared-contract",
      controlPlane === 'export * from "@agents-company/shared/founder-os"',
      "Control Plane reexports the Shared contract",
    ),
  ]
}

export function normalizedFounderOSContractCheckReport(report: ContractCheckReport) {
  return {
    schemaVersion: report.schemaVersion,
    reportVersion: report.reportVersion,
    checkId: report.checkId,
    buildSha: report.buildSha,
    buildTreeSha: report.buildTreeSha,
    contractBinding: report.contractBinding,
    runnerBinding: report.runnerBinding,
    assertions: report.assertions,
    status: report.status,
  }
}

export async function evaluateFounderOSContractCheck(
  buildSha: string,
  check: FounderOSContractCheck,
) {
  const ref = exactCommit(buildSha)
  const contractSource = readAtRef(ref, contractPath)
  const runnerSource = readAtRef(ref, runnerPath)
  const contract = JSON.parse(contractSource) as GateContract
  const assertions =
    check === "governed-files"
      ? await governedFiles(ref, contract)
      : check === "flag-defaults"
        ? await flagDefaults()
        : check === "flag-invalid-values"
          ? await flagInvalidValues()
          : check === "contract-roundtrip"
            ? await contractRoundtrip()
            : check === "correction-append-only"
              ? await correctionAppendOnly(ref)
              : check === "typed-action-unknown-reject"
                ? await typedActionUnknownReject()
                : await sdkConsistency(ref)
  const report = {
    schemaVersion: 1,
    reportVersion: "1.0.0",
    checkId: check,
    buildSha: ref,
    buildTreeSha: runGit(["rev-parse", `${ref}^{tree}`]).trim(),
    contractBinding: { path: contractPath, sha256: sha256(contractSource) },
    runnerBinding: { path: runnerPath, sha256: sha256(runnerSource) },
    assertions,
    status: assertions.every((item) => item.status === "pass")
      ? ("pass" as const)
      : ("failed" as const),
  }
  return {
    ...report,
    normalizedDigest: sha256(JSON.stringify(normalizedFounderOSContractCheckReport(report))),
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
      "Required arguments: --ref <full-sha> --check <check-id> --out <check-report.json>",
    )
  }
  const check = values.get("--check") as FounderOSContractCheck
  if (
    ![
      "governed-files",
      "flag-defaults",
      "flag-invalid-values",
      "contract-roundtrip",
      "correction-append-only",
      "typed-action-unknown-reject",
      "sdk-consistency",
    ].includes(check)
  ) {
    throw new Error("Invalid --check")
  }
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
      const report = await evaluateFounderOSContractCheck(options.buildSha, options.check)
      await Bun.write(options.outputPath, `${JSON.stringify(report, null, 2)}\n`)
      console.log(JSON.stringify(report, null, 2))
      process.exitCode = report.status === "pass" ? 0 : 1
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 64
    })
}
