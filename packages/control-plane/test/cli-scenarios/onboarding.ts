import path from "path"
import { expectFile, expectOk } from "./lib/assert"
import { createScenarioEnv, type ScenarioEnv } from "./lib/env"
import { jsonOf, runCli } from "./lib/cli"

export async function runOnboardingScenario(existing?: ScenarioEnv) {
  const scenario = existing ?? (await createScenarioEnv("onboarding"))
  const paths = expectOk<Record<string, string>>(jsonOf(await runCli(["debug", "paths", "--json"], cli(scenario))))
  expectOk(jsonOf(await runCli(["settings", "set", "onboarding.completed", "true", "--json"], cli(scenario))))
  expectOk(jsonOf(await runCli(["settings", "get", "onboarding.completed", "--json"], cli(scenario))))
  await expectFile(path.join(paths.state, "kv.json"))
  const session = expectOk<Record<string, unknown>>(
    jsonOf(await runCli(["session", "create", "--title", "cli-headless-kickoff", "--json"], cli(scenario))),
  )
  expectOk(jsonOf(await runCli(["session", "delete", String(session.id), "--json"], cli(scenario))))
  return { scenario }
}

function cli(scenario: ScenarioEnv) {
  return { env: scenario.env, cwd: scenario.project, artifactDir: scenario.artifacts }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runOnboardingScenario(), null, 2))
}
