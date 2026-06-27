import { createEffect, createSignal, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useKV } from "@tui/context/kv"
import { useRoute } from "@tui/context/route"
import { useKeybind } from "@tui/context/keybind"
import { useExit } from "@tui/context/exit"
import { useDialog } from "@tui/ui/dialog"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { useLanguage } from "@tui/context/language"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { BUSINESS_SCOPE_PRESETS } from "./business-scope-cards"
import { StarryBackground } from "@tui/component/starry-background"
import { DialogProvider } from "@tui/component/dialog-provider"
import { DialogModel } from "@tui/component/dialog-model"
import { StepWelcome } from "./step-welcome"
import { StepTemplateSelect } from "./step-template-select"
import { StepProfile } from "./step-profile"
import { StepMission } from "./step-mission"
import { StepFoundingTeam } from "./step-founding-team"

type Step = "welcome" | "provider" | "template" | "customize" | "mission" | "team"

interface OnboardingData {
  providerID?: string
  modelID?: string
  templateId?: string
  userName?: string
  assistantName?: string
  companyName?: string
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
  const route = useRoute()
  const keybind = useKeybind()
  const exit = useExit()
  const dialog = useDialog()
  const t = useLanguage().t
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
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

  async function finish(agentIDs: string[], teamNames: string[]) {
    setDone(true)
    kv.set("onboarding_profile", {
      ...data(),
      foundingTeam: agentIDs,
      teamNames,
      completedAt: Date.now(),
    })
    kv.set("onboarding_done", true)
    dialog.clear()

    // Drop the founder straight into a kickoff session with the two co-founders.
    // Their job (baked into the cofounder-* personas) is to interview the founder
    // and converge on a company thesis before any vertical work begins. If the
    // session can't be created, fall back to home so onboarding still completes.
    const groupSessionID = await startKickoff(agentIDs)
    route.navigate(groupSessionID ? { type: "group-session", groupSessionID } : { type: "home" })
  }

  // Creates a group session with the founding team and seeds an opening message
  // in the founder's voice that hands the floor to the co-founders. Returns the
  // new group session ID, or null on any failure.
  async function startKickoff(agentIDs: string[]): Promise<string | null> {
    if (agentIDs.length === 0) return null
    const scopeLabels = (data().scopes ?? [])
      .map((s) => BUSINESS_SCOPE_PRESETS.find((p) => p.key === s)?.title ?? s)
      .join("、")
    const mission = data().mission?.trim()
    const kickoff = [
      `我们第一次正式碰头。公司刚建起来${scopeLabels ? `，我选的方向是【${scopeLabels}】` : ""}。`,
      mission ? `我现在的想法是：${mission}` : `说实话，具体要做成什么样，我心里还很模糊。`,
      `先别急着给方案——帮我把「我们到底为谁、解决什么、凭什么是我们」理清楚。`,
    ].join("\n")
    try {
      const res = await sdk.fetch(`${sdk.url}/group-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `${data().companyName || data().userName || "我们"} · 创始对齐`, agentIDs }),
      })
      if (!res.ok) return null
      const info = (await res.json()) as { id: string }
      await sdk
        .fetch(`${sdk.url}/group-session/${encodeURIComponent(info.id)}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: kickoff }),
        })
        .catch(() => undefined)
      return info.id
    } catch {
      return null
    }
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
            // Derive scopes from templateId — the template key matches the scope key
            setData((p) => ({ ...p, templateId, scopes: [templateId] }))
            setStep("customize")
          }}
        />
      ))
      return
    }

    if (s === "customize") {
      dialog.replace(() => (
        <StepProfile
          stepIndex={2}
          stepCount={STEP_COUNT}
          skipScope={true}
          onComplete={(r) => {
            setData((p) => ({ ...p, userName: r.userName, assistantName: r.assistantName, companyName: r.companyName }))
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
