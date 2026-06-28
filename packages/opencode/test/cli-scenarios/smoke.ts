import { expectField, expectOk } from "./lib/assert"
import { createScenarioEnv, type ScenarioEnv } from "./lib/env"
import { jsonOf, runCli } from "./lib/cli"
import { runDoctor } from "./doctor"

export async function runSmoke(existing?: ScenarioEnv) {
  const scenario = existing ?? (await createScenarioEnv("smoke"))
  await runDoctor(scenario)
  const session = expectOk<Record<string, unknown>>(
    jsonOf(await runCli(["session", "create", "--title", "cli-smoke", "--json"], cli(scenario))),
  )
  const sessionID = expectField<string>(session, "id")
  expectOk(
    jsonOf(
      await runCli(
        ["session", "prompt", sessionID, "Reply with exactly AGENTCOMPANY_CLI_SMOKE_OK.", "--json"],
        { ...cli(scenario), timeoutMs: 180_000 },
      ),
    ),
  )
  const messages = expectOk<unknown[]>(jsonOf(await runCli(["session", "messages", sessionID, "--agent-id", "*", "--json"], cli(scenario))))
  if (messages.length === 0) throw new Error("Expected smoke prompt to create messages")
  expectOk(jsonOf(await runCli(["session", "diff", sessionID, "--json"], cli(scenario))))
  expectOk(jsonOf(await runCli(["session", "delete", sessionID, "--json"], cli(scenario))))
  return { scenario, sessionID }
}

function cli(scenario: ScenarioEnv) {
  return { env: scenario.env, cwd: scenario.project, artifactDir: scenario.artifacts }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runSmoke(), null, 2))
}
