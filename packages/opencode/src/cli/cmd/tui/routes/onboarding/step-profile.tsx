import { createSignal, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useLanguage } from "@tui/context/language"
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
// flakiness: names are collected via explicit inputs, scopes via cards.
export function StepProfile(props: StepProfileProps) {
  const { theme } = useTheme()
  const t = useLanguage().t
  const [phase, setPhase] = createSignal<Phase>("user-name")
  const [value, setValue] = createSignal("")
  const [userName, setUserName] = createSignal("")
  const [assistantName, setAssistantName] = createSignal("")
  const [errorMsg, setErrorMsg] = createSignal("")

  function submitText() {
    const text = value().trim()
    setErrorMsg("")

    if (phase() === "user-name") {
      if (text.length < 1 || text.length > 50) return setErrorMsg(t("onboarding.profile.error.name"))
      setUserName(text)
      setValue("")
      setPhase("assistant-name")
      return
    }

    if (phase() === "assistant-name") {
      if (text.length < 1 || text.length > 30) return setErrorMsg(t("onboarding.profile.error.assistant"))
      if (text.toLowerCase() === userName().toLowerCase())
        return setErrorMsg(t("onboarding.profile.error.assistant_same"))
      setAssistantName(text)
      setValue("")
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
        <box flexDirection="row" gap={1}>
          <box
            flexGrow={1}
            backgroundColor={theme.backgroundElement}
            paddingLeft={1}
            paddingRight={1}
          >
            <input
              value={value()}
              onInput={(e: any) => setValue(e.target?.value ?? e.detail ?? "")}
              placeholder={
                phase() === "user-name"
                  ? t("onboarding.interview.placeholder.name")
                  : t("onboarding.interview.placeholder.assistant")
              }
              onSubmit={submitText}
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
