import { createSignal, Match, Switch } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useKV } from "@tui/context/kv"
import { useKeybind } from "@tui/context/keybind"
import { useExit } from "@tui/context/exit"
import { StarryBackground } from "@tui/component/starry-background"
import { StepWelcome } from "./step-welcome"
import { StepProvider } from "./step-provider"
import { StepProfile } from "./step-profile"
import { StepMission } from "./step-mission"
import { StepFoundingTeam } from "./step-founding-team"

type Step = "welcome" | "provider" | "profile" | "mission" | "team"

interface OnboardingData {
  providerID?: string
  modelID?: string
  userName?: string
  assistantName?: string
  scopes?: string[]
  mission?: string
}

// Card-style wizard shown on first launch. The starry background is rendered
// once here; every step after the welcome screen draws itself as a centered
// card via <OnboardingFrame>. Completion is gated on the persisted
// `onboarding_done` flag (see app.tsx), and the captured profile is saved to the
// KV settings store so later sessions know who the founder and team are.
export function Onboarding() {
  const kv = useKV()
  const keybind = useKeybind()
  const exit = useExit()
  const [step, setStep] = createSignal<Step>("welcome")
  const [data, setData] = createSignal<OnboardingData>({})

  useKeyboard((evt) => {
    if (keybind.match("app_exit", evt)) void exit()
  })

  // Card steps share a 4-dot progress indicator.
  const STEP_COUNT = 4

  function finish(agentIDs: string[]) {
    kv.set("onboarding_profile", {
      ...data(),
      foundingTeam: agentIDs,
      completedAt: Date.now(),
    })
    kv.set("onboarding_done", true)
  }

  return (
    <box position="relative" width="100%" height="100%">
      <StarryBackground />
      <box position="absolute" top={0} left={0} right={0} bottom={0}>
        <Switch>
          <Match when={step() === "welcome"}>
            <StepWelcome onComplete={() => setStep("provider")} />
          </Match>

          <Match when={step() === "provider"}>
            <StepProvider
              stepIndex={0}
              stepCount={STEP_COUNT}
              onComplete={(r) => {
                setData((p) => ({ ...p, providerID: r.providerID, modelID: r.modelID }))
                setStep("profile")
              }}
            />
          </Match>

          <Match when={step() === "profile"}>
            <StepProfile
              stepIndex={1}
              stepCount={STEP_COUNT}
              onComplete={(r) => {
                setData((p) => ({ ...p, userName: r.userName, assistantName: r.assistantName, scopes: r.scopes }))
                setStep("mission")
              }}
            />
          </Match>

          <Match when={step() === "mission"}>
            <StepMission
              stepIndex={2}
              stepCount={STEP_COUNT}
              userName={data().userName ?? ""}
              assistantName={data().assistantName ?? ""}
              scopes={data().scopes ?? []}
              onComplete={(r) => {
                setData((p) => ({ ...p, mission: r.mission }))
                setStep("team")
              }}
            />
          </Match>

          <Match when={step() === "team"}>
            <StepFoundingTeam
              stepIndex={3}
              stepCount={STEP_COUNT}
              userName={data().userName ?? ""}
              assistantName={data().assistantName ?? ""}
              scopes={data().scopes ?? []}
              mission={data().mission ?? ""}
              onComplete={finish}
            />
          </Match>
        </Switch>
      </box>
    </box>
  )
}
