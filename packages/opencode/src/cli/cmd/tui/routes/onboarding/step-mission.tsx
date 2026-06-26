import { createSignal, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useLanguage } from "@tui/context/language"
import { useDialog } from "@tui/ui/dialog"
import { TextareaRenderable } from "@opentui/core"
import { OnboardingFrame } from "./frame"
import { BUSINESS_SCOPE_PRESETS } from "./business-scope-cards"

interface StepMissionProps {
  stepIndex: number
  stepCount: number
  userName: string
  assistantName: string
  scopes: string[]
  onComplete: (data: { mission: string }) => void
}

// Simple text input for company mission. No LLM dependency — the founder
// types their vision directly and moves on.
export function StepMission(props: StepMissionProps) {
  const { theme } = useTheme()
  const t = useLanguage().t
  const dialog = useDialog()
  const [errorMsg, setErrorMsg] = createSignal("")
  let textarea: TextareaRenderable | undefined

  const scopeLabels = props.scopes
    .map((s) => BUSINESS_SCOPE_PRESETS.find((p) => p.key === s)?.title ?? s)
    .join("、")

  const question = t("onboarding.mission.opening")
    .replace("{{name}}", props.userName)
    .replace("{{scope}}", scopeLabels)

  onMount(() => {
    dialog.setSize("medium")
    focusInput()
  })

  function focusInput() {
    setTimeout(() => {
      if (textarea && !textarea.isDestroyed) {
        textarea.focus()
        if (textarea.plainText === "") {
          textarea.insertText("打造一款让人工智能赋能每个人的 SaaS 产品")
        }
      }
    }, 1)
  }

  function submit() {
    const text = (textarea?.plainText ?? "").trim()
    if (text.length < 1) return setErrorMsg(t("onboarding.mission.error.empty"))
    props.onComplete({ mission: text })
  }

  function skip() {
    props.onComplete({ mission: "" })
  }

  return (
    <OnboardingFrame
      stepIndex={props.stepIndex}
      stepCount={props.stepCount}
      title={t("onboarding.mission.title")}
      speaker={{ name: props.assistantName, icon: "🌟" }}
      speech={question}
    >
      <Show when={errorMsg()}>
        <text fg={theme.error}>⚠ {errorMsg()}</text>
      </Show>

      <box flexDirection="row" gap={1} alignItems="center">
        <box flexGrow={1} backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
          <textarea
            height={3}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={submit}
            placeholder={t("onboarding.mission.placeholder")}
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            onMouseDown={(r: any) => r.target?.focus()}
            ref={(r: TextareaRenderable) => (textarea = r)}
          />
        </box>
      </box>

      <box flexDirection="row" justifyContent="space-between" alignItems="center">
        <box flexDirection="row" gap={1} alignItems="center" onMouseUp={skip}>
          <text fg={theme.textMuted}>→</text>
          <text fg={theme.textMuted}>{t("onboarding.mission.skip")}</text>
        </box>
        <box backgroundColor={theme.primary} paddingLeft={3} paddingRight={3} onMouseUp={submit}>
          <text fg={theme.background}>{t("onboarding.profile.next")}</text>
        </box>
      </box>
    </OnboardingFrame>
  )
}
