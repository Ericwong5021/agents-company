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
// The assistant generates a personalised opening via a hidden kickstart; that
// reply appears as the first message in the chat transcript (same style as all
// subsequent turns — no separate speech bubble). The hidden kickstart user
// message is filtered out. The founder can skip at any time.
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
  // ID of the hidden kickstart user message — filtered from the visible transcript.
  const [kickoffUserID, setKickoffUserID] = createSignal<string | null>(null)
  let textarea: TextareaRenderable | undefined

  const agentID = "onboarding-assistant"
  const scopeLabels = props.scopes
    .map((s) => BUSINESS_SCOPE_PRESETS.find((p) => p.key === s)?.title ?? s)
    .join("、")
  const KICKOFF_TEXT = `[系统] 请直接用一句话问创始人：「${props.userName}，你想创办一家什么样的「${scopeLabels}」公司？」。不要加任何前缀、解释或额外内容，直接输出这一句问话。`

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

      // Send hidden kickstart so the AI generates a personalised opening.
      setSubmitting(true)
      try {
        await sdk.client.session.promptAsync({
          sessionID: res.data.id,
          parts: [{ type: "text", text: KICKOFF_TEXT }],
        })
      } catch {
        setError(t("onboarding.mission.error"))
      }
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

  // Visible transcript: the hidden kickstart user message is filtered out, but
  // the assistant's opening reply stays — it appears as the first chat message
  // in the same style as all subsequent turns.
  const transcript = createMemo(() => {
    const sid = sessionID()
    if (!sid) return []
    const buckets = sync.data.message[sid]
    if (!buckets) return []
    const koUID = kickoffUserID()
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
      .filter((m) => m.content.trim().length > 0 && m.id !== koUID)
  })

  // Once the opening line lands (first completed assistant message), mark the
  // step as ready and capture the kickstart user message id for filtering.
  createMemo(() => {
    const sid = sessionID()
    if (!sid || ready()) return
    const buckets = sync.data.message[sid]
    if (!buckets) return
    const all = Object.values(buckets).flat().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    const kickoff = all.find((m) => m.role === "user")
    if (kickoff && !kickoffUserID()) setKickoffUserID(kickoff.id)

    const assistantReply = all.find((m) => m.role === "assistant" && m.time.completed)
    if (assistantReply && kickoffUserID()) {
      const text = (sync.data.part[assistantReply.id] ?? [])
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => ("text" in p ? (p.text ?? "") : ""))
        .join("")
        .trim()
      if (text) {
        setSubmitting(false)
        setReady(true)
        focusInput()
      }
    }
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
          <box flexDirection="row" justifyContent="flex-end" gap={2}>
            <Show when={ready()}>
              <text fg={theme.textMuted} onMouseUp={skip}>
                {t("onboarding.mission.skip")}
              </text>
            </Show>
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

      {/* Loading while generating opening line */}
      <Show when={!ready() && !error()}>
        <box flexDirection="row" alignItems="center" gap={1} paddingLeft={1}>
          <Spinner color={theme.primary} />
        </box>
      </Show>

      {/* Chat transcript — all messages in the same style */}
      <Show when={ready() && transcript().length > 0}>
        <box flexDirection="column" gap={1}>
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
