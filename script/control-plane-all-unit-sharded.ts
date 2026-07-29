import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const controlPlaneRoot = path.resolve(import.meta.dir, "../packages/control-plane")
const reportDirectory = path.join(controlPlaneRoot, ".artifacts/automatic-evidence")
const output = path.join(reportDirectory, "all-unit-junit.xml")
const testFiles = (
  await Promise.all(
    ["src/**/*.test.ts", "test/**/*.test.ts"].map((pattern) =>
      Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: controlPlaneRoot, onlyFiles: true })),
    ),
  )
)
  .flat()
  .sort()
const jobs = testFiles.map((file, index) => ({
  id: `file-${index + 1}`,
  files: [file],
}))
const results = []

await fs.mkdir(reportDirectory, { recursive: true })
await fs.rm(output, { force: true })
await Promise.all(
  jobs.map((_, index) => fs.rm(path.join(reportDirectory, `all-unit-junit-part-${index + 1}.xml`), { force: true })),
)

for (const [index, job] of jobs.entries()) {
  const report = path.join(reportDirectory, `all-unit-junit-part-${index + 1}.xml`)
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-all-unit-"))
  await fs.rm(report, { force: true })
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-orphans",
      "test",
      "--max-concurrency=1",
      "--timeout",
      "30000",
      "--reporter=junit",
      `--reporter-outfile=${report}`,
      ...job.files,
    ],
    cwd: controlPlaneRoot,
    env: {
      ...process.env,
      AGENTCOMPANY_HOME: home,
      AGENT_COMPANY_WEBUI_DATA_DIR: path.join(home, "webui"),
      XDG_DATA_HOME: path.join(home, "xdg-data"),
      XDG_CONFIG_HOME: path.join(home, "xdg-config"),
      XDG_CACHE_HOME: path.join(home, "xdg-cache"),
      XDG_STATE_HOME: path.join(home, "xdg-state"),
    },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  results.push({
    id: job.id,
    file: job.files[0]!,
    exitCode: await child.exited,
    source: await Bun.file(report)
      .text()
      .catch(() => ""),
  })
  await fs.rm(home, { recursive: true, force: true })
}

const summaries = results.map((result) => {
  const root = result.source.match(/<testsuites\b[^>]*>/)?.[0]
  const body = result.source.match(/<testsuites\b[^>]*>([\s\S]*)<\/testsuites>\s*$/)?.[1]
  if (!root && body === undefined && result.exitCode === 0 && result.source.trim() === "") {
    return {
      ...result,
      tests: 0,
      assertions: 0,
      failures: 0,
      errors: 0,
      skipped: 0,
      time: 0,
      body: `<testsuite name="${result.file}" file="${result.file}" tests="0" assertions="0" failures="0" skipped="0" time="0" />`,
    }
  }
  if (!root || body === undefined) throw new Error(`Missing JUnit report for ${result.id}.`)
  const count = (attribute: string) => Number(root.match(new RegExp(`\\b${attribute}="(\\d+)"`))?.[1] ?? 0)
  return {
    ...result,
    tests: count("tests"),
    assertions: count("assertions"),
    failures: count("failures"),
    errors: count("errors"),
    skipped: count("skipped"),
    time: Number(root.match(/\btime="([\d.]+)"/)?.[1] ?? 0),
    body,
  }
})
const total = summaries.reduce(
  (value, summary) => ({
    tests: value.tests + summary.tests,
    assertions: value.assertions + summary.assertions,
    failures: value.failures + summary.failures,
    errors: value.errors + summary.errors,
    skipped: value.skipped + summary.skipped,
    time: value.time + summary.time,
  }),
  { tests: 0, assertions: 0, failures: 0, errors: 0, skipped: 0, time: 0 },
)

await Bun.write(
  output,
  `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="${total.tests}" assertions="${total.assertions}" failures="${total.failures}" errors="${total.errors}" skipped="${total.skipped}" time="${total.time.toFixed(6)}">
${summaries.map((summary) => summary.body.trim()).join("\n")}
</testsuites>
`,
)
console.log(
  JSON.stringify({
    result:
      results.every((result) => result.exitCode === 0) && total.failures === 0 && total.errors === 0 ? "pass" : "fail",
    jobs: jobs.length,
    files: testFiles.length,
    ...total,
  }),
)
if (results.some((result) => result.exitCode !== 0) || total.failures > 0 || total.errors > 0) process.exit(1)
