import { expectField, expectOk } from "./lib/assert"
import { createScenarioEnv, type ScenarioEnv } from "./lib/env"
import { jsonOf, runCli } from "./lib/cli"

export async function runSessionScenario(existing?: ScenarioEnv) {
  const scenario = existing ?? (await createScenarioEnv("session"))
  const session = expectOk<Record<string, unknown>>(
    jsonOf(await runCli(["session", "create", "--title", "cli-session-scenario", "--json"], cli(scenario))),
  )
  const sessionID = expectField<string>(session, "id")
  expectOk(jsonOf(await runCli(["session", "rename", sessionID, "cli-session-renamed", "--json"], cli(scenario))))
  const task = expectOk<Record<string, unknown>>(
    jsonOf(await runCli(["session", "task", "create", sessionID, "--summary", "exercise task primitive", "--json"], cli(scenario))),
  )
  const taskID = expectField<string>(task, "id")
  expectOk(jsonOf(await runCli(["session", "task", "done", sessionID, taskID, "--summary", "done by scenario", "--json"], cli(scenario))))
  expectOk(jsonOf(await runCli(["session", "messages", sessionID, "--agent-id", "*", "--json"], cli(scenario))))
  const fork = expectOk<Record<string, unknown>>(jsonOf(await runCli(["session", "fork", sessionID, "--json"], cli(scenario))))
  expectOk(jsonOf(await runCli(["session", "archive", sessionID, "--json"], cli(scenario))))
  expectOk(jsonOf(await runCli(["session", "delete", expectField<string>(fork, "id"), "--json"], cli(scenario))))
  expectOk(jsonOf(await runCli(["session", "delete", sessionID, "--json"], cli(scenario))))
  return { scenario, sessionID }
}

function cli(scenario: ScenarioEnv) {
  return { env: scenario.env, cwd: scenario.project, artifactDir: scenario.artifacts }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runSessionScenario(), null, 2))
}
