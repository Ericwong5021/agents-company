import { createSignal, createEffect, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useLanguage } from "@tui/context/language"
import { useDialog } from "@tui/ui/dialog"
import { TextareaRenderable } from "@opentui/core"
import { OnboardingFrame } from "./frame"
import { BusinessScopeCards } from "./business-scope-cards"

interface StepProfileProps {
  stepIndex: number
  stepCount: number
  skipScope?: boolean
  onComplete: (data: { userName: string; assistantName: string; companyName: string; scopes: string[] }) => void
}

type Phase = "user-name" | "assistant-name" | "scope" | "company-name"

// Deterministic, card-driven profile capture led by the (not-yet-named) helper.
// Replacing the old free-chat name detection removes the main source of
// flakiness: names are collected via explicit text fields, scopes via cards.
export function StepProfile(props: StepProfileProps) {
  const { theme } = useTheme()
  const t = useLanguage().t
  const dialog = useDialog()
  const [phase, setPhase] = createSignal<Phase>("user-name")
  const [userName, setUserName] = createSignal("")
  const [companyName, setCompanyName] = createSignal("")
  const [assistantName, setAssistantName] = createSignal("")
  const [errorMsg, setErrorMsg] = createSignal("")
  let textarea: TextareaRenderable | undefined

  const DEFAULTS: Partial<Record<Phase, string>> = {
    "user-name": "创始人",
    "assistant-name": "助理",
    "company-name": "我的公司",
  }

  onMount(() => {
    dialog.setSize("medium")
    focusInput()
  })

  // Auto-advance the scope phase with defaults.
  createEffect(() => {
    if (phase() === "scope") {
      setTimeout(() => onScopeConfirm(["saas"]), 200)
    }
  })

  function focusInput() {
    setTimeout(() => {
      if (textarea && !textarea.isDestroyed) {
        textarea.focus()
      }
    }, 1)
  }

  function submitText() {
    const raw = (textarea?.plainText ?? "").trim()
    const text = raw.length > 0 ? raw : (DEFAULTS[phase()] ?? "")
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
      if (props.skipScope) {
        setPhase("company-name")
      } else {
        setPhase("scope")
      }
      focusInput()
    }
  }

  function onScopeConfirm(scopes: string[]) {
    if (scopes.length === 0) return setErrorMsg(t("onboarding.profile.error.scope"))
    setPhase("company-name")
    focusInput()
  }

  function onCompanyNameSubmit() {
    const raw = (textarea?.plainText ?? "").trim()
    const text = raw.length > 0 ? raw : (DEFAULTS["company-name"] ?? "")
    if (text.length > 50) return setErrorMsg(t("onboarding.profile.error.company"))
    setCompanyName(text)
    props.onComplete({ userName: userName(), assistantName: assistantName(), companyName: text, scopes: [] })
  }

  function speech() {
    if (phase() === "user-name") return t("onboarding.profile.ask_name")
    if (phase() === "assistant-name") return t("onboarding.profile.ask_assistant").replace("{{name}}", userName())
    if (phase() === "scope") return t("onboarding.profile.ask_scope").replace("{{name}}", userName())
    return t("onboarding.profile.ask_company").replace("{{name}}", userName())
  }

  function placeholder() {
    return DEFAULTS[phase()] ?? ""
  }

  function submitCurrent() {
    if (phase() === "company-name") {
      onCompanyNameSubmit()
    } else {
      submitText()
    }
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

      <Show when={phase() === "user-name" || phase() === "assistant-name" || phase() === "company-name"}>
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
              onSubmit={submitCurrent}
              placeholder={placeholder()}
              placeholderColor={theme.textMuted}
              textColor={theme.text}
              focusedTextColor={theme.text}
              cursorColor={theme.text}
              onMouseDown={(r: any) => r.target?.focus()}
              ref={(r: TextareaRenderable) => (textarea = r)}
            />
          </box>
          <box backgroundColor={theme.primary} paddingLeft={2} paddingRight={2} onMouseUp={submitCurrent}>
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
