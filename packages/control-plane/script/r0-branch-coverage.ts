#!/usr/bin/env bun
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import type { CoverageMapData } from "istanbul-lib-coverage"
import { createCoverageMap } from "istanbul-lib-coverage"

const dir = path.resolve(import.meta.dir, "..")
const output = path.join(dir, ".artifacts/r0-branch-coverage/coverage.json")
const targets = [
  "src/company/activity.ts",
  "src/company-project/experience-artifact.ts",
  "src/company-project/work-projection.ts",
  "src/goal-brief/goal-brief.ts",
  "src/goal-brief/model-adapter.ts",
  "src/server/routes/instance/experience.ts",
  "../shared/src/experience.ts",
]
const tests = [
  "test/company/activity.test.ts",
  "test/company-agent/file-bundle.test.ts",
  "test/company-project/work-projection.test.ts",
  "test/goal-brief/experience-contract.test.ts",
  "test/goal-brief/goal-brief.test.ts",
  "test/goal-brief/migration.test.ts",
  "test/goal-brief/model-adapter.test.ts",
  "test/goal-brief/schema.test.ts",
  "test/server/experience-route.test.ts",
  "test/session/auto-dream-default.test.ts",
]

function isCoverageMapData(value: unknown): value is CoverageMapData {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

await mkdir(path.dirname(output), { recursive: true })
await rm(output, { force: true })
const test = Bun.spawnSync({
  cmd: ["bun", "--config=test/r0-branch/bunfig.toml", "test", "--timeout", "30000", "--reporter=dots", ...tests],
  cwd: dir,
  env: {
    ...process.env,
    AGENTCOMPANY_R0_BRANCH_COVERAGE_OUTPUT: output,
  },
  stdout: "inherit",
  stderr: "inherit",
})
if (test.exitCode !== 0) process.exit(test.exitCode)

const data: unknown = await Bun.file(output).json()
if (!isCoverageMapData(data)) throw new Error("R0 branch coverage output is invalid")
const map = createCoverageMap(data)
const results = targets.map((file) => {
  const absolute = path.resolve(dir, file)
  const coverage = map.fileCoverageFor(absolute)
  const branches = coverage.toSummary().branches
  const uncovered = Object.entries(coverage.branchMap).flatMap(([id, branch]) =>
    coverage.b[id].flatMap((hits, index) =>
      hits === 0
        ? [
            {
              line: branch.locations[index]?.start.line ?? branch.line,
              type: branch.type,
              index,
            },
          ]
        : [],
    ),
  )
  return {
    file,
    total: branches.total,
    covered: branches.covered,
    percent: branches.pct,
    uncovered,
  }
})

await Bun.write(path.join(path.dirname(output), "report.json"), JSON.stringify({ threshold: 90, results }, null, 2))
results.map((result) =>
  console.log(`${result.file}: ${result.covered}/${result.total} branches (${result.percent.toFixed(2)}%)`),
)

const failed = results.filter((result) => result.total < 1 || result.percent < 90)
if (!failed.length) process.exit(0)
failed.map((result) =>
  console.error(
    `${result.file}: uncovered ${result.uncovered.map((branch) => `${branch.line}:${branch.type}[${branch.index}]`).join(", ")}`,
  ),
)
process.exit(1)
