import { createScenarioEnv } from "./lib/env"
import { runDoctor } from "./doctor"
import { runSessionScenario } from "./session"
import { runGroupSessionScenario } from "./group-session"
import { runPermissionsScenario } from "./permissions"
import { runOnboardingScenario } from "./onboarding"
import { runSmoke } from "./smoke"

export async function runFull() {
  const scenario = await createScenarioEnv("full")
  return {
    doctor: await runDoctor(scenario),
    session: await runSessionScenario(scenario),
    groupSession: await runGroupSessionScenario(scenario),
    permissions: await runPermissionsScenario(scenario),
    onboarding: await runOnboardingScenario(scenario),
    smoke: await runSmoke(scenario),
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runFull(), null, 2))
}
