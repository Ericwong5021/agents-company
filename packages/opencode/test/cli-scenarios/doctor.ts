import { expectField, expectOk } from "./lib/assert"
import { createScenarioEnv, type ScenarioEnv } from "./lib/env"
import { jsonOf, runCli } from "./lib/cli"

export async function runDoctor(existing?: ScenarioEnv) {
  const scenario = existing ?? (await createScenarioEnv("doctor"))
  const paths = expectOk<Record<string, string>>(
    jsonOf(await runCli(["debug", "paths", "--json"], { env: scenario.env, cwd: scenario.project, artifactDir: scenario.artifacts })),
  )
  const providers = expectOk<{ credentials: unknown[]; environment: unknown[] }>(
    jsonOf(await runCli(["providers", "list", "--json"], { env: scenario.env, cwd: scenario.project, artifactDir: scenario.artifacts })),
  )
  const models = expectOk<unknown[]>(
    jsonOf(await runCli(["models", "--json"], { env: scenario.env, cwd: scenario.project, artifactDir: scenario.artifacts })),
  )
  expectOk(jsonOf(await runCli(["mcp", "list", "--json"], { env: scenario.env, cwd: scenario.project, artifactDir: scenario.artifacts })))

  if (providers.credentials.length === 0 && providers.environment.length === 0) {
    throw new Error("No real provider credentials or provider environment variables are available")
  }
  if (models.length === 0) throw new Error("No real models are available")

  return {
    scenario,
    paths,
    providers,
    modelCount: models.flatMap((provider) => expectField<unknown[]>(provider, "models")).length,
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runDoctor(), null, 2))
}
