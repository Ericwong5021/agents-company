import { createSignal, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useLanguage } from "@tui/context/language"
import { useDialog } from "@tui/ui/dialog"
import { TextareaRenderable } from "@opentui/core"
import { OnboardingFrame } from "./frame"
import { BusinessScopeCards } from "./business-scope-cards"

interface StepProfileProps {
  stepIndex: number
  stepCount: number
  onComplete: (data: { userName: string; assistantName: string; scopes: string[] }) => void
}

type Phase = "user-name" | "assistant-name" | "scope"

// Deterministic, card-driven profile capture led by the (not-yet-named) helper.
// Replacing the old free-chat name detection removes the main source of
// flakiness: names are collected via explicit text fields, scopes via cards.
export function StepProfile(props: StepProfileProps) {
  const { theme } = useTheme()
  const t = useLanguage().t
  const dialog = useDialog()
  const [phase, setPhase] = createSignal<Phase>("user-name")
  const [userName, setUserName] = createSignal("")
  const [assistantName, setAssistantName] = createSignal("")
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
      setAssistantName(text)
      textarea?.clear()
      setPhase("scope")
    }
  }

  function onScopeConfirm(scopes: string[]) {
    if (scopes.length === 0) return setErrorMsg(t("onboarding.profile.error.scope"))
    props.onComplete({ userName: userName(), assistantName: assistantName(), scopes })
  }

  function speech() {
    if (phase() === "user-name") return t("onboarding.profile.ask_name")
    if (phase() === "assistant-name") return t("onboarding.profile.ask_assistant").replace("{{name}}", userName())
    return t("onboarding.profile.ask_scope").replace("{{name}}", userName())
  }

  return (
    <OnboardingFrame
      stepIndex={props.stepIndex}
      stepCount={props.stepCount}
      title={t("onboarding.profile.title")}
      speaker={{ name: t("onboarding.assistant.default_name"), icon: "🌟" }}
      speech={speech()}
    >
      <Show when={errorMsg()}>
        <text fg={theme.error}>⚠ {errorMsg()}</text>
      </Show>

      <Show when={phase() !== "scope"}>
        <box flexDirection="row" gap={1} alignItems="center">
          <box
            flexGrow={1}
            backgroundColor={theme.backgroundElement}
            paddingLeft={1}
            paddingRight={1}
          >
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
      </Show>

      <Show when={phase() === "scope"}>
        <BusinessScopeCards onConfirm={onScopeConfirm} />
      </Show>
    </OnboardingFrame>
  )
}
