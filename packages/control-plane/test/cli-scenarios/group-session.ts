import { expectField, expectOk } from "./lib/assert"
import { createScenarioEnv, type ScenarioEnv } from "./lib/env"
import { jsonOf, runCli } from "./lib/cli"

export async function runGroupSessionScenario(existing?: ScenarioEnv) {
  const scenario = existing ?? (await createScenarioEnv("group"))
  await createAgent(scenario, "cli-agent-alpha", "CLI Alpha")
  await createAgent(scenario, "cli-agent-beta", "CLI Beta")
  const group = expectOk<Record<string, unknown>>(
    jsonOf(
      await runCli(
        ["group", "create", "cli-group", "--agent", "cli-agent-alpha", "--agent", "cli-agent-beta", "--json"],
        cli(scenario),
      ),
    ),
  )
  const groupID = expectField<string>(group, "id")
  expectOk(jsonOf(await runCli(["group", "status", groupID, "--json"], cli(scenario))))
  expectOk(jsonOf(await runCli(["group", "messages", groupID, "--json"], cli(scenario))))
  expectOk(jsonOf(await runCli(["group", "transcript", groupID, "--json"], cli(scenario))))
  expectOk(jsonOf(await runCli(["group", "delete", groupID, "--json"], cli(scenario))))
  await deleteAgent(scenario, "cli-agent-alpha")
  await deleteAgent(scenario, "cli-agent-beta")
  return { scenario, groupID }
}

async function createAgent(scenario: ScenarioEnv, id: string, name: string) {
  return expectOk(
    jsonOf(
      await runCli(
        [
          "company-agent",
          "create",
          id,
          name,
          "--description",
          `${name} test agent`,
          "--system-prompt",
          "You are a concise test agent.",
          "--json",
        ],
        cli(scenario),
      ),
    ),
  )
}

async function deleteAgent(scenario: ScenarioEnv, id: string) {
  return expectOk(jsonOf(await runCli(["company-agent", "delete", id, "--json"], cli(scenario))))
}

function cli(scenario: ScenarioEnv) {
  return { env: scenario.env, cwd: scenario.project, artifactDir: scenario.artifacts }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runGroupSessionScenario(), null, 2))
}
