import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useLanguage } from "@tui/context/language"
import { useDialog } from "@tui/ui/dialog"
import { Spinner } from "@tui/component/spinner"
import { TextAttributes, TextareaRenderable } from "@opentui/core"
import { OnboardingFrame } from "./frame"
import { BUSINESS_SCOPE_PRESETS } from "./business-scope-cards"
import { buildGuidancePrompt } from "./prompts"

interface StepMissionProps {
  stepIndex: number
  stepCount: number
  userName: string
  assistantName: string
  scopes: string[]
  onComplete: (data: { mission: string }) => void
}

// Short conversation to understand what business the founder wants to build.
// The opening question is generated locally (no LLM dependency) so it appears
// instantly. Subsequent turns use real LLM conversation. The founder can skip
// at any time — the skip button is prominent and always visible.
export function StepMission(props: StepMissionProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const t = useLanguage().t
  const dialog = useDialog()

  const [sessionID, setSessionID] = createSignal<string | null>(null)
  const [ready, setReady] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let textarea: TextareaRenderable | undefined

  const agentID = "onboarding-assistant"
  const scopeLabels = props.scopes
    .map((s) => BUSINESS_SCOPE_PRESETS.find((p) => p.key === s)?.title ?? s)
    .join("、")

  // Local opening question — no LLM call needed.
  const openingQuestion = t("onboarding.mission.opening")
    .replace("{{name}}", props.userName)
    .replace("{{scope}}", scopeLabels)

  onMount(() => {
    dialog.setSize("large")
    void initialize()
  })

  function focusInput() {
    setTimeout(() => {
      if (textarea && !textarea.isDestroyed) textarea.focus()
    }, 1)
  }

  async function initialize() {
    setError(null)
    try {
      await sdk.fetch(`${sdk.url}/company-agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: agentID,
          name: props.assistantName,
          description: t("onboarding.assistant.description"),
          color: "#8B5CF6",
          icon: "🌟",
          system_prompt: buildGuidancePrompt({
            userName: props.userName,
            assistantName: props.assistantName,
            scopeLabels,
          }),
        }),
      })

      const res = await sdk.client.session.create({ companyAgentID: agentID })
      if (!res.data) {
        setError(t("onboarding.mission.error"))
        return
      }
      setSessionID(res.data.id)
      setReady(true)
    } catch {
      setError(t("onboarding.mission.error"))
    }
  }

  async function send(sid: string, text: string) {
    setSubmitting(true)
    try {
      await sdk.client.session.promptAsync({ sessionID: sid, parts: [{ type: "text", text }] })
    } catch {
      setError(t("onboarding.mission.error"))
    } finally {
      setSubmitting(false)
    }
  }

  // Visible transcript: all messages in chat style.
  const transcript = createMemo(() => {
    const sid = sessionID()
    if (!sid) return []
    const buckets = sync.data.message[sid]
    if (!buckets) return []
    return Object.values(buckets)
      .flat()
      .filter((m) => m.role === "user" || m.role === "assistant")
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: (sync.data.part[m.id] ?? [])
          .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
          .map((p) => ("text" in p ? (p.text ?? "") : ""))
          .join(""),
      }))
      .filter((m) => m.content.trim().length > 0)
  })

  const waiting = createMemo(() => {
    if (submitting()) return true
    const sid = sessionID()
    if (!sid) return false
    const buckets = sync.data.message[sid]
    if (!buckets) return false
    const last = Object.values(buckets)
      .flat()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .at(-1)
    return !!last && last.role === "assistant" && !last.time.completed
  })

  function submit() {
    const text = (textarea?.plainText ?? "").trim()
    if (!text || waiting() || !sessionID()) return
    textarea?.clear()
    void send(sessionID()!, text)
    focusInput()
  }

  function skip() {
    props.onComplete({ mission: "" })
  }

  function finish() {
    const mission = transcript()
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n")
    props.onComplete({ mission })
  }

  return (
    <OnboardingFrame
      stepIndex={props.stepIndex}
      stepCount={props.stepCount}
      title={t("onboarding.mission.title")}
      subtitle={
        !ready() && !error()
          ? t("onboarding.mission.generating").replace("{{assistant}}", props.assistantName)
          : undefined
      }
      footer={
        <box flexDirection="column" gap={1}>
          <box flexDirection="row" alignItems="center" gap={1}>
            <box
              flexGrow={1}
              backgroundColor={theme.backgroundElement}
              paddingLeft={1}
              paddingRight={1}
            >
              <textarea
                height={1}
                keyBindings={waiting() ? [] : [{ name: "return", action: "submit" }]}
                onSubmit={submit}
                placeholder={t("onboarding.interview.placeholder.message")}
                placeholderColor={theme.textMuted}
                textColor={theme.text}
                focusedTextColor={theme.text}
                cursorColor={theme.text}
                onMouseDown={(r: any) => r.target?.focus()}
                ref={(r: TextareaRenderable) => (textarea = r)}
              />
            </box>
            <box backgroundColor={theme.primary} paddingLeft={2} paddingRight={2} onMouseUp={submit}>
              <text fg={theme.background}>{t("onboarding.profile.next")}</text>
            </box>
          </box>
          <box flexDirection="row" justifyContent="space-between" alignItems="center">
            {/* Prominent skip — always visible, left-aligned */}
            <box
              flexDirection="row"
              gap={1}
              alignItems="center"
              onMouseUp={skip}
            >
              <text fg={theme.textMuted}>→</text>
              <text fg={theme.textMuted}>{t("onboarding.mission.skip")}</text>
            </box>
            <Show when={transcript().some((m) => m.role === "user")}>
              <box backgroundColor={theme.success} paddingLeft={2} paddingRight={2} onMouseUp={finish}>
                <text fg={theme.background}>{t("onboarding.mission.build")}</text>
              </box>
            </Show>
          </box>
        </box>
      }
    >
      <Show when={error()}>
        <text fg={theme.error}>⚠ {error()}</text>
      </Show>

      {/* Loading while session initializes */}
      <Show when={!ready() && !error()}>
        <box flexDirection="row" alignItems="center" gap={1} paddingLeft={1}>
          <Spinner color={theme.primary} />
        </box>
      </Show>

      {/* Chat transcript */}
      <Show when={ready()}>
        <box flexDirection="column" gap={1}>
          {/* Local opening question as the first assistant message */}
          <box flexDirection="column">
            <text fg={theme.success} attributes={TextAttributes.BOLD}>
              {props.assistantName}
            </text>
            <box paddingLeft={2}>
              <text fg={theme.text}>{openingQuestion}</text>
            </box>
          </box>
          {/* LLM conversation */}
          <For each={transcript().slice(-6)}>
            {(msg) => (
              <box flexDirection="column">
                <text
                  fg={msg.role === "user" ? theme.primary : theme.success}
                  attributes={TextAttributes.BOLD}
                >
                  {msg.role === "user" ? t("onboarding.mission.you") : props.assistantName}
                </text>
                <box paddingLeft={2}>
                  <text fg={theme.text}>{msg.content.trim()}</text>
                </box>
              </box>
            )}
          </For>
          <Show when={waiting()}>
            <box paddingLeft={2}>
              <Spinner color={theme.textMuted} />
            </box>
          </Show>
        </box>
      </Show>
    </OnboardingFrame>
  )
}
