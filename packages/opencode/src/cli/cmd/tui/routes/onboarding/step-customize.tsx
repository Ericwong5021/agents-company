import { createSignal, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useLanguage } from "@tui/context/language"
import { useDialog } from "@tui/ui/dialog"
import { TextareaRenderable } from "@opentui/core"
import { OnboardingFrame } from "./frame"

interface StepCustomizeProps {
  stepIndex: number
  stepCount: number
  templateName: string
  onComplete: (data: { userName: string; assistantName: string }) => void
}

type Phase = "user-name" | "assistant-name"

// Collects the founder's name and the assistant's name. Shown after template
// selection so the context is "you've chosen X, now let's personalize it".
export function StepCustomize(props: StepCustomizeProps) {
  const { theme } = useTheme()
  const t = useLanguage().t
  const dialog = useDialog()
  const [phase, setPhase] = createSignal<Phase>("user-name")
  const [userName, setUserName] = createSignal("")
  const [errorMsg, setErrorMsg] = createSignal("")
  let textarea: TextareaRenderable | undefined

  onMount(() => {
    dialog.setSize("medium")
    focusInput()
  })

  function focusInput() {
    setTimeout(() => {
      if (textarea && !textarea.isDestroyed) textarea.focus()
    }, 1)
  }

  function submitText() {
    const text = (textarea?.plainText ?? "").trim()
    setErrorMsg("")

    if (phase() === "user-name") {
      if (text.length < 1 || text.length > 50) return setErrorMsg(t("onboarding.profile.error.name"))
      setUserName(text)
      textarea?.clear()
      setPhase("assistant-name")
      focusInput()
      return
    }

    if (phase() === "assistant-name") {
      if (text.length < 1 || text.length > 30) return setErrorMsg(t("onboarding.profile.error.assistant"))
      if (text.toLowerCase() === userName().toLowerCase())
        return setErrorMsg(t("onboarding.profile.error.assistant_same"))
      props.onComplete({ userName: userName(), assistantName: text })
    }
  }

  function speech() {
    if (phase() === "user-name")
      return t("onboarding.customize.ask_name").replace("{{template}}", props.templateName)
    return t("onboarding.customize.ask_assistant").replace("{{name}}", userName())
  }

  return (
    <OnboardingFrame
      stepIndex={props.stepIndex}
      stepCount={props.stepCount}
      title={t("onboarding.customize.title")}
      speaker={{ name: t("onboarding.assistant.default_name"), icon: "🌟" }}
      speech={speech()}
    >
      <Show when={errorMsg()}>
        <text fg={theme.error}>⚠ {errorMsg()}</text>
      </Show>

      <box flexDirection="row" gap={1} alignItems="center">
        <box flexGrow={1} backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
          <textarea
            height={1}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={submitText}
            placeholder={
              phase() === "user-name"
                ? t("onboarding.interview.placeholder.name")
                : t("onboarding.interview.placeholder.assistant")
            }
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            onMouseDown={(r: any) => r.target?.focus()}
            ref={(r: TextareaRenderable) => (textarea = r)}
          />
        </box>
        <box backgroundColor={theme.primary} paddingLeft={2} paddingRight={2} onMouseUp={submitText}>
          <text fg={theme.background}>{t("onboarding.profile.next")}</text>
        </box>
      </box>
    </OnboardingFrame>
  )
}
