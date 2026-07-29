import { createHash } from "node:crypto"
import { lstat, mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { MetricContract, PrePublicBlockingMetricIds } from "@agents-company/shared/seed-grow-metrics"
import { Effect } from "effect"
import z from "zod"
import {
  PersistedFactArtifactReference,
  makePersistedFactArtifactAdapter,
} from "../src/metrics/persisted-fact-artifact"
import { Service, makeLayer } from "../src/metrics/seed-grow-reporter"

const Input = z
  .object({
    metricContractPath: z.string().refine((value) => path.isAbsolute(value)),
    artifactReference: PersistedFactArtifactReference,
    candidateSha: z.string().regex(/^[a-f0-9]{40}$/),
    comparisonId: z.string().trim().min(1).max(500),
    scenarioIds: z.array(z.string().trim().min(1).max(500)).min(1).max(500),
    outputDirectory: z.string().refine((value) => path.isAbsolute(value)),
  })
  .strict()

async function regularJSON(target: string, label: string) {
  const info = await lstat(target)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${target}`)
  return JSON.parse(await Bun.file(target).text()) as unknown
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

async function writeReport(directory: string, name: string, value: unknown) {
  const source = `${JSON.stringify(value, null, 2)}\n`
  const target = path.join(directory, name)
  await Bun.write(target, source)
  return {
    path: target,
    sha256: sha256(source),
  }
}

const requestPath = Bun.argv[2]
if (!requestPath || !path.isAbsolute(requestPath))
  throw new Error("Usage: bun script/evaluate-seed-grow-persisted-facts.ts /absolute/request.json")
const input = Input.parse(await regularJSON(requestPath, "Metric evaluation request"))
const contract = MetricContract.parse(await regularJSON(input.metricContractPath, "Metric contract"))
const output = await lstat(input.outputDirectory).catch(() => null)
if (output?.isSymbolicLink() || (output && !output.isDirectory()))
  throw new Error("Metric evaluation output must be a regular directory")
if (output && (await readdir(input.outputDirectory)).length)
  throw new Error("Metric evaluation output directory must be absent or empty")
await mkdir(input.outputDirectory, { recursive: true })
const adapter = await makePersistedFactArtifactAdapter(input.artifactReference)
const reports = await Effect.runPromise(
  Effect.gen(function* () {
    const reporter = yield* Service
    return {
      metrics: yield* reporter.report({
        contract,
        candidateSha: input.candidateSha,
        metricIds: [...PrePublicBlockingMetricIds],
        strategy: "seed_and_grow",
      }),
      shadow: yield* reporter.compareShadow({
        contract,
        candidateSha: input.candidateSha,
        comparisonId: input.comparisonId,
        scenarioIds: input.scenarioIds,
      }),
    }
  }).pipe(Effect.provide(makeLayer(adapter))),
)
const result = {
  status:
    reports.metrics.status === "pass" && reports.shadow.status === "pass"
      ? "pass"
      : reports.metrics.status === "failed" || reports.shadow.status === "failed"
        ? "failed"
        : "blocked",
  metricReport: await writeReport(input.outputDirectory, "metric-report.json", reports.metrics),
  shadowReport: await writeReport(input.outputDirectory, "shadow-report.json", reports.shadow),
}
process.stdout.write(`${JSON.stringify(result)}\n`)
if (result.status !== "pass") process.exitCode = result.status === "failed" ? 1 : 2
