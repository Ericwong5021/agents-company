import { expectOk } from "./lib/assert"
import { createScenarioEnv, type ScenarioEnv } from "./lib/env"
import { jsonOf, runCli } from "./lib/cli"

export async function runPermissionsScenario(existing?: ScenarioEnv) {
  const scenario = existing ?? (await createScenarioEnv("permissions"))
  expectOk(jsonOf(await runCli(["permission", "list", "--json"], cli(scenario))))
  expectOk(jsonOf(await runCli(["question", "list", "--json"], cli(scenario))))
  expectOk(jsonOf(await runCli(["question", "never-ask", "true", "--json"], cli(scenario))))
  expectOk(jsonOf(await runCli(["question", "never-ask", "false", "--json"], cli(scenario))))
  return { scenario }
}

function cli(scenario: ScenarioEnv) {
  return { env: scenario.env, cwd: scenario.project, artifactDir: scenario.artifacts }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runPermissionsScenario(), null, 2))
}
