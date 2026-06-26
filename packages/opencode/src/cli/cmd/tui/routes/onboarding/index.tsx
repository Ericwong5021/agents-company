import { createEffect, createSignal, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useKV } from "@tui/context/kv"
import { useKeybind } from "@tui/context/keybind"
import { useExit } from "@tui/context/exit"
import { useDialog } from "@tui/ui/dialog"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { useLanguage } from "@tui/context/language"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { StarryBackground } from "@tui/component/starry-background"
import { DialogProvider } from "@tui/component/dialog-provider"
import { DialogModel } from "@tui/component/dialog-model"
import { StepWelcome } from "./step-welcome"
import { StepTemplateSelect } from "./step-template-select"
import { StepCustomize } from "./step-customize"
import { StepMission } from "./step-mission"
import { StepFoundingTeam } from "./step-founding-team"

type Step = "welcome" | "provider" | "template" | "customize" | "mission" | "team"

interface OnboardingData {
  providerID?: string
  modelID?: string
  templateId?: string
  userName?: string
  assistantName?: string
  scopes?: string[]
  mission?: string
}

// First-launch wizard. Every step after the welcome screen is driven through the
// shared dialog stack so it renders in the exact same modal window as the
// provider/model selector — one consistent window form, no second shell. The
// starry background stays underneath. Completion is gated on the persisted
// `onboarding_done` flag (see app.tsx) and the captured profile is saved to KV.
//
// Flow: welcome → provider → template → customize → mission → team
export function Onboarding() {
  const kv = useKV()
  const keybind = useKeybind()
  const exit = useExit()
  const dialog = useDialog()
  const t = useLanguage().t
  const local = useLocal()
  const sync = useSync()
  const [step, setStep] = createSignal<Step>("welcome")
  const [data, setData] = createSignal<OnboardingData>({})
  const [done, setDone] = createSignal(false)

  const [exiting, setExiting] = createSignal(false)

  useKeyboard((evt) => {
    if (keybind.match("app_exit", evt)) {
      setExiting(true)
      // Clear any existing dialogs first
      if (dialog.stack.length > 0) {
        dialog.clear()
      }
      void DialogConfirm.show(dialog, t("tui.dialog.exit.title"), t("tui.dialog.exit.message")).then((result) => {
        if (result) {
          void exit()
        } else {
          setExiting(false)
        }
      })
    }
  })

  // Card steps share a 5-dot progress indicator (provider, template, customize, mission, team).
  const STEP_COUNT = 5

  function hasConnectedModels() {
    return sync.data.provider_next.connected.some((id) => {
      const provider = sync.data.provider.find((p) => p.id === id)
      return provider && Object.keys(provider.models).length > 0
    })
  }

  function finish(agentIDs: string[], teamNames: string[]) {
    setDone(true)
    kv.set("onboarding_profile", {
      ...data(),
      foundingTeam: agentIDs,
      teamNames,
      completedAt: Date.now(),
    })
    kv.set("onboarding_done", true)
    dialog.clear()
  }

  // Push the dialog content for a given step into the shared window.
  function renderStep(s: Step) {
    if (s === "provider") {
      dialog.replace(
        () => (hasConnectedModels() ? <DialogModel /> : <DialogProvider />),
        () => {
          const current = local.model.current()
          if (current?.providerID && current?.modelID) {
            setData((p) => ({ ...p, providerID: current.providerID, modelID: current.modelID }))
            setStep("template")
          }
        },
      )
      return
    }

    if (s === "template") {
      dialog.replace(() => (
        <StepTemplateSelect
          stepIndex={1}
          stepCount={STEP_COUNT}
          onComplete={(templateId) => {
            setData((p) => ({ ...p, templateId }))
            setStep("customize")
          }}
        />
      ))
      return
    }

    if (s === "customize") {
      dialog.replace(() => (
        <StepCustomize
          stepIndex={2}
          stepCount={STEP_COUNT}
          templateName={data().templateId ?? ""}
          onComplete={(r) => {
            setData((p) => ({ ...p, userName: r.userName, assistantName: r.assistantName }))
            setStep("mission")
          }}
        />
      ))
      return
    }

    if (s === "mission") {
      dialog.replace(() => (
        <StepMission
          stepIndex={3}
          stepCount={STEP_COUNT}
          userName={data().userName ?? ""}
          assistantName={data().assistantName ?? ""}
          scopes={data().scopes ?? []}
          onComplete={(r) => {
            setData((p) => ({ ...p, mission: r.mission }))
            setStep("team")
          }}
        />
      ))
      return
    }

    if (s === "team") {
      dialog.replace(() => (
        <StepFoundingTeam
          stepIndex={4}
          stepCount={STEP_COUNT}
          userName={data().userName ?? ""}
          assistantName={data().assistantName ?? ""}
          templateId={data().templateId}
          scopes={data().scopes ?? []}
          mission={data().mission ?? ""}
          onComplete={finish}
        />
      ))
    }
  }

  // Single source of truth for what occupies the dialog window.
  let rendered: Step | null = null
  createEffect(() => {
    const s = step()
    const stackLen = dialog.stack.length

    if (exiting()) return

    if (s === "welcome" || done()) {
      if (stackLen) dialog.clear()
      rendered = null
      return
    }

    if (rendered !== s || stackLen === 0) {
      rendered = s
      renderStep(s)
    }
  })

  return (
    <box position="relative" width="100%" height="100%">
      <StarryBackground />
      <Show when={step() === "welcome"}>
        <box position="absolute" top={0} left={0} right={0} bottom={0}>
          <StepWelcome onComplete={() => setStep("provider")} />
        </box>
      </Show>
    </box>
  )
}
