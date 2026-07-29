import { lstat } from "node:fs/promises"
import path from "node:path"
import { MetricContract } from "@agents-company/shared/seed-grow-metrics"
import z from "zod"
import { exportPersistedFactArtifact, PersistedFactExportRequest } from "../src/metrics/persisted-fact-exporter"

const Input = PersistedFactExportRequest.omit({ metricContract: true, outputPath: true })
  .extend({
    metricContractPath: z.string().refine((value) => path.isAbsolute(value)),
    outputPath: z.string().refine((value) => path.isAbsolute(value)),
  })
  .strict()

async function regularFile(target: string, label: string) {
  const info = await lstat(target)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${target}`)
  return JSON.parse(await Bun.file(target).text()) as unknown
}

const requestPath = Bun.argv[2]
if (!requestPath || !path.isAbsolute(requestPath))
  throw new Error("Usage: bun script/export-seed-grow-persisted-facts.ts /absolute/request.json")
const input = Input.parse(await regularFile(requestPath, "Persisted fact export request"))
const { metricContractPath, ...request } = input
const result = await exportPersistedFactArtifact({
  ...request,
  metricContract: MetricContract.parse(await regularFile(metricContractPath, "Metric contract")),
})
process.stdout.write(`${JSON.stringify(result.reference)}\n`)
