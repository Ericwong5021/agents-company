import path from "node:path"
import { afterAll } from "bun:test"
import type { CoverageMapData } from "istanbul-lib-coverage"
import { createInstrumenter } from "istanbul-lib-instrument"

const output = process.env["AGENTCOMPANY_R0_BRANCH_COVERAGE_OUTPUT"]
if (!output) throw new Error("AGENTCOMPANY_R0_BRANCH_COVERAGE_OUTPUT is required")

const targets = new Set([
  path.resolve(import.meta.dir, "../../src/company/activity.ts"),
  path.resolve(import.meta.dir, "../../src/company-project/experience-artifact.ts"),
  path.resolve(import.meta.dir, "../../src/company-project/work-projection.ts"),
  path.resolve(import.meta.dir, "../../src/goal-brief/goal-brief.ts"),
  path.resolve(import.meta.dir, "../../src/goal-brief/model-adapter.ts"),
  path.resolve(import.meta.dir, "../../src/server/routes/instance/experience.ts"),
  path.resolve(import.meta.dir, "../../../shared/src/experience.ts"),
])
const instrumenter = createInstrumenter({
  esModules: true,
  produceSourceMap: false,
  parserPlugins: ["typescript"],
})

Bun.plugin({
  name: "r0-branch-coverage",
  setup(build) {
    build.onLoad(
      {
        filter:
          /(?:company[\\/]activity|company-project[\\/]experience-artifact|company-project[\\/]work-projection|goal-brief[\\/]goal-brief|goal-brief[\\/]model-adapter|server[\\/]routes[\\/]instance[\\/]experience|shared[\\/]src[\\/]experience)\.ts$/,
      },
      async (args) => {
        if (!targets.has(args.path)) throw new Error(`Unexpected R0 branch instrumentation target: ${args.path}`)
        return {
          contents: instrumenter.instrumentSync(await Bun.file(args.path).text(), args.path),
          loader: "ts",
        }
      },
    )
  },
})

afterAll(async () => {
  const coverage = (globalThis as typeof globalThis & { __coverage__?: CoverageMapData }).__coverage__
  if (!coverage) throw new Error("R0 branch instrumentation produced no coverage")
  await Bun.write(output, JSON.stringify(coverage))
})
