import { createHash } from "node:crypto"
import path from "node:path"
import z from "zod"

const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const CommitSha = z.string().regex(/^[a-f0-9]{40}$/)
const Scenario = z.enum(["S19", "S20", "S27"])
const Boundary = z.enum(["before_transaction", "after_mutation_write", "after_commit"])
const BoundaryMarker = z
  .object({
    kind: z.literal("b5-s20-boundary"),
    boundary: Boundary,
    pid: z.number().int().positive(),
  })
  .strict()
const FileBinding = z
  .object({
    path: z.string().refine((value) => path.isAbsolute(value)),
    sha256: Digest,
  })
  .strict()

export const B5CandidateRecoveryInput = z
  .object({
    candidateSha: CommitSha,
    scenarioId: Scenario,
    snapshotDigest: Digest,
    runId: z.string().trim().min(1),
    outputDirectory: z.string().refine((value) => path.isAbsolute(value)),
  })
  .strict()
export type B5CandidateRecoveryInput = z.infer<typeof B5CandidateRecoveryInput>

export const B5CandidateRecoveryChildRequest = B5CandidateRecoveryInput.extend({
  mode: z.enum(["crash", "prepare", "recover"]),
  key: z.string().regex(/^[a-f0-9]{16}$/),
  boundary: Boundary.optional(),
}).strict()
export type B5CandidateRecoveryChildRequest = z.infer<typeof B5CandidateRecoveryChildRequest>

const BoundaryResult = z
  .object({
    boundary: Boundary,
    projectId: z.string().min(1),
    receiptId: z.string().min(1),
    mutationId: z.string().min(1),
    beforeRevision: z.number().int().nonnegative(),
    afterRevision: z.number().int().nonnegative(),
    atomicState: z.enum(["old", "new"]),
    replayed: z.boolean(),
    duplicateSideEffects: z.number().int().nonnegative(),
    crashedPid: z.number().int().positive(),
    recoveryPid: z.number().int().positive(),
    signal: z.literal("SIGKILL"),
    markerVerified: z.literal(true),
    beforeDatabaseSha256: Digest,
    afterDatabaseSha256: Digest,
    beforeBusinessSha256: Digest,
    afterBusinessSha256: Digest,
  })
  .strict()

export const B5CandidateRecoveryResult = z
  .object({
    schemaVersion: z.literal(1),
    scenarioId: Scenario,
    candidateSha: CommitSha,
    snapshotDigest: Digest,
    runId: z.string().min(1),
    projectId: z.string().min(1),
    entityIds: z
      .object({
        projectIds: z.array(z.string().min(1)).min(1),
        workItemIds: z.array(z.string().min(1)).min(1),
        receiptIds: z.array(z.string().min(1)),
        mutationIds: z.array(z.string().min(1)),
      })
      .strict(),
    lostAt: z.number().int().nonnegative(),
    recoveredAt: z.number().int().nonnegative(),
    beforeDatabaseSha256: Digest,
    afterDatabaseSha256: Digest,
    beforeBusinessSha256: Digest,
    afterBusinessSha256: Digest,
    duplicateSideEffects: z.number().int().nonnegative(),
    exactlyOnce: z.boolean(),
    process: z
      .object({
        crashedPid: z.number().int().positive(),
        recoveryPid: z.number().int().positive(),
        signal: z.literal("SIGKILL"),
      })
      .strict()
      .optional(),
    receiptRecovery: z
      .object({
        beforeStatus: z.literal("pending"),
        afterStatus: z.literal("processed"),
        firstRecoverProcessedCount: z.literal(1),
        secondRecoverProcessedCount: z.literal(0),
      })
      .strict()
      .optional(),
    boundaries: z.array(BoundaryResult),
    startup: z
      .object({
        recoveryStartedAt: z.number().int().nonnegative(),
        reconciledAt: z.number().int().nonnegative(),
        dispatchProbedAt: z.number().int().nonnegative(),
        dispatchAfterReconcile: z.boolean(),
        phases: z.tuple([
          z.literal("company_project"),
          z.literal("receipt_graph"),
          z.literal("project_orchestrator"),
          z.literal("projection"),
        ]),
        projectionWatermarkBefore: z.string(),
        projectionWatermarkAfter: z.string(),
        projectionConverged: z.boolean(),
      })
      .strict()
      .optional(),
    report: FileBinding,
  })
  .strict()
export type B5CandidateRecoveryResult = z.infer<typeof B5CandidateRecoveryResult>

const ChildOutput = z
  .object({
    projectId: z.string().min(1),
    workItemIds: z.array(z.string().min(1)).min(1),
    receiptIds: z.array(z.string().min(1)),
    mutationIds: z.array(z.string().min(1)),
    databaseSha256: Digest,
    businessSha256: Digest,
    duplicateSideEffects: z.number().int().nonnegative().default(0),
    exactlyOnce: z.boolean().default(false),
    pid: z.number().int().positive(),
    receiptStatus: z.enum(["pending", "processing", "processed"]).optional(),
    firstRecoverProcessedCount: z.number().int().nonnegative().optional(),
    secondRecoverProcessedCount: z.number().int().nonnegative().optional(),
    recoveredAt: z.number().int().nonnegative().optional(),
    beforeRevision: z.number().int().nonnegative().optional(),
    afterRevision: z.number().int().nonnegative().optional(),
    atomicState: z.enum(["old", "new"]).optional(),
    replayed: z.boolean().optional(),
    startup: z
      .object({
        recoveryStartedAt: z.number().int().nonnegative(),
        reconciledAt: z.number().int().nonnegative(),
        dispatchProbedAt: z.number().int().nonnegative(),
        dispatchAfterReconcile: z.boolean(),
        phases: z.tuple([
          z.literal("company_project"),
          z.literal("receipt_graph"),
          z.literal("project_orchestrator"),
          z.literal("projection"),
        ]),
        projectionWatermarkBefore: z.string(),
        projectionWatermarkAfter: z.string(),
        projectionConverged: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()

const packageRoot = path.resolve(import.meta.dir, "../..")
const childScript = path.join(packageRoot, "script/b5-candidate-recovery-child.ts")
const childTimeoutMs = 20_000

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function childRequest(
  input: B5CandidateRecoveryInput,
  mode: B5CandidateRecoveryChildRequest["mode"],
  boundary?: z.infer<typeof Boundary>,
) {
  return B5CandidateRecoveryChildRequest.parse({
    ...input,
    mode,
    boundary,
    key: sha256(
      `${input.candidateSha}:${input.snapshotDigest}:${input.runId}:${input.scenarioId}:${boundary ?? ""}`,
    ).slice(0, 16),
  })
}

function spawn(input: B5CandidateRecoveryChildRequest) {
  const database = process.env.AGENTCOMPANY_DB
  const home = process.env.AGENTCOMPANY_HOME
  if (!database || !home) throw new Error("B5 recovery requires AGENTCOMPANY_DB and AGENTCOMPANY_HOME")
  return Bun.spawn({
    cmd: [process.execPath, childScript, Buffer.from(JSON.stringify(input)).toString("base64url")],
    cwd: packageRoot,
    env: {
      ...process.env,
      AGENTCOMPANY_DB: database,
      AGENTCOMPANY_HOME: home,
      AGENTCOMPANY_SEED_GROW_ORCHESTRATION: "active",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

function childDeadline(child: ReturnType<typeof spawn>) {
  const timeout = setTimeout(() => child.kill("SIGKILL"), childTimeoutMs)
  timeout.unref()
  return timeout
}

async function lineFrom(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let value = ""
  while (true) {
    const next = await reader.read()
    value += decoder.decode(next.value, { stream: !next.done })
    const line = value.split(/\r?\n/).find((entry) => entry.startsWith("{"))
    if (line) {
      reader.releaseLock()
      return ChildOutput.parse(JSON.parse(line))
    }
    if (next.done) throw new Error(`B5 recovery child returned no JSON: ${value}`)
  }
}

async function run(input: B5CandidateRecoveryChildRequest) {
  const child = spawn(input)
  const timeout = childDeadline(child)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timeout)
  if (exitCode !== 0) throw new Error(stderr || stdout || `B5 recovery child exited ${exitCode}`)
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .findLast((entry) => entry.startsWith("{"))
  if (!line) throw new Error(`B5 recovery child returned no JSON: ${stdout}`)
  return ChildOutput.parse(JSON.parse(line))
}

async function crashAfterHandshake(input: B5CandidateRecoveryChildRequest) {
  const child = spawn(input)
  const timeout = childDeadline(child)
  const ready = await lineFrom(child.stdout)
  const lostAt = Date.now()
  child.kill(9)
  const exitCode = await child.exited
  clearTimeout(timeout)
  if (exitCode === 0) throw new Error("B5 recovery child did not terminate at the crash boundary")
  return { ready, lostAt }
}

async function crashAtBoundary(input: B5CandidateRecoveryChildRequest) {
  if (!input.boundary) throw new Error("B5 mutation crash requires a boundary")
  const child = spawn(input)
  const timeout = childDeadline(child)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timeout)
  if (exitCode === 0) throw new Error(`B5 mutation child did not terminate at ${input.boundary}: ${stderr || stdout}`)
  const markers = stdout
    .trim()
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.startsWith("{")) return []
      const parsed = BoundaryMarker.safeParse(JSON.parse(line))
      return parsed.success ? [parsed.data] : []
    })
  if (markers.length !== 1 || markers[0]!.boundary !== input.boundary || markers[0]!.pid !== child.pid)
    throw new Error(`B5 mutation child did not prove boundary ${input.boundary}: ${stderr || stdout}`)
  return { lostAt: Date.now(), crashedPid: markers[0]!.pid }
}

async function writeReport(input: B5CandidateRecoveryInput, value: Omit<B5CandidateRecoveryResult, "report">) {
  await Bun.$`mkdir -p ${input.outputDirectory}`.quiet()
  const target = path.join(
    input.outputDirectory,
    `${input.scenarioId.toLowerCase()}-${sha256(input.runId).slice(0, 12)}.json`,
  )
  const content = `${JSON.stringify(value, null, 2)}\n`
  await Bun.write(target, content)
  return FileBinding.parse({ path: target, sha256: sha256(content) })
}

export async function produceB5CandidateRecovery(raw: B5CandidateRecoveryInput): Promise<B5CandidateRecoveryResult> {
  const input = B5CandidateRecoveryInput.parse(raw)
  if (input.scenarioId === "S19" || input.scenarioId === "S27") {
    const crashed = await crashAfterHandshake(childRequest(input, "crash"))
    const recovered = await run(childRequest(input, "recover"))
    if (!recovered.recoveredAt || recovered.recoveredAt <= crashed.lostAt)
      throw new Error(`${input.scenarioId} recovery did not occur after the process loss`)
    const value = {
      schemaVersion: 1 as const,
      scenarioId: input.scenarioId,
      candidateSha: input.candidateSha,
      snapshotDigest: input.snapshotDigest,
      runId: input.runId,
      projectId: recovered.projectId,
      entityIds: {
        projectIds: [recovered.projectId],
        workItemIds: recovered.workItemIds,
        receiptIds: recovered.receiptIds,
        mutationIds: recovered.mutationIds,
      },
      lostAt: crashed.lostAt,
      recoveredAt: recovered.recoveredAt,
      beforeDatabaseSha256: crashed.ready.databaseSha256,
      afterDatabaseSha256: recovered.databaseSha256,
      beforeBusinessSha256: crashed.ready.businessSha256,
      afterBusinessSha256: recovered.businessSha256,
      duplicateSideEffects: recovered.duplicateSideEffects,
      exactlyOnce: recovered.exactlyOnce,
      process: {
        crashedPid: crashed.ready.pid,
        recoveryPid: recovered.pid,
        signal: "SIGKILL" as const,
      },
      receiptRecovery:
        input.scenarioId === "S19" &&
        crashed.ready.receiptStatus === "pending" &&
        recovered.receiptStatus === "processed" &&
        recovered.firstRecoverProcessedCount === 1 &&
        recovered.secondRecoverProcessedCount === 0
          ? {
              beforeStatus: "pending" as const,
              afterStatus: "processed" as const,
              firstRecoverProcessedCount: 1 as const,
              secondRecoverProcessedCount: 0 as const,
            }
          : undefined,
      boundaries: [],
      startup: recovered.startup,
    }
    return B5CandidateRecoveryResult.parse({ ...value, report: await writeReport(input, value) })
  }

  const boundaries = Boundary.options
  const results = []
  for (const boundary of boundaries) {
    const request = childRequest(input, "prepare", boundary)
    const prepared = await run(request)
    const crashed = await crashAtBoundary({ ...request, mode: "crash" })
    const recovered = await run({ ...request, mode: "recover" })
    if (
      recovered.beforeRevision === undefined ||
      recovered.afterRevision === undefined ||
      !recovered.atomicState ||
      recovered.replayed === undefined ||
      !recovered.recoveredAt ||
      recovered.recoveredAt <= crashed.lostAt
    )
      throw new Error(`S20 ${boundary} recovery report is incomplete`)
    results.push({
      boundary,
      projectId: recovered.projectId,
      receiptId: recovered.receiptIds[0]!,
      mutationId: recovered.mutationIds[0]!,
      beforeRevision: recovered.beforeRevision,
      afterRevision: recovered.afterRevision,
      atomicState: recovered.atomicState,
      replayed: recovered.replayed,
      duplicateSideEffects: recovered.duplicateSideEffects,
      crashedPid: crashed.crashedPid,
      recoveryPid: recovered.pid,
      signal: "SIGKILL" as const,
      markerVerified: true as const,
      beforeDatabaseSha256: prepared.databaseSha256,
      afterDatabaseSha256: recovered.databaseSha256,
      beforeBusinessSha256: prepared.businessSha256,
      afterBusinessSha256: recovered.businessSha256,
      lostAt: crashed.lostAt,
      recoveredAt: recovered.recoveredAt,
      workItemIds: recovered.workItemIds,
    })
  }
  const primary = results.find((item) => item.boundary === "after_commit")!
  const value = {
    schemaVersion: 1 as const,
    scenarioId: input.scenarioId,
    candidateSha: input.candidateSha,
    snapshotDigest: input.snapshotDigest,
    runId: input.runId,
    projectId: primary.projectId,
    entityIds: {
      projectIds: results.map((item) => item.projectId),
      workItemIds: results.flatMap((item) => item.workItemIds),
      receiptIds: results.map((item) => item.receiptId),
      mutationIds: results.map((item) => item.mutationId),
    },
    lostAt: Math.min(...results.map((item) => item.lostAt)),
    recoveredAt: Math.max(...results.map((item) => item.recoveredAt)),
    beforeDatabaseSha256: sha256(results.map((item) => item.beforeDatabaseSha256).join(":")),
    afterDatabaseSha256: sha256(results.map((item) => item.afterDatabaseSha256).join(":")),
    beforeBusinessSha256: sha256(results.map((item) => item.beforeBusinessSha256).join(":")),
    afterBusinessSha256: sha256(results.map((item) => item.afterBusinessSha256).join(":")),
    duplicateSideEffects: results.reduce((total, item) => total + item.duplicateSideEffects, 0),
    exactlyOnce: results.every(
      (item) => item.afterRevision === item.beforeRevision + 1 && item.duplicateSideEffects === 0,
    ),
    boundaries: results.map(
      ({ lostAt: _lostAt, recoveredAt: _recoveredAt, workItemIds: _workItemIds, ...item }) => item,
    ),
  }
  return B5CandidateRecoveryResult.parse({ ...value, report: await writeReport(input, value) })
}
