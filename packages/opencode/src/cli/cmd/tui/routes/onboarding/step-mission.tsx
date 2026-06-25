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

// Conversational phase: the now-named assistant talks the founder through what
// the company wants to build and which goals matter, using the default model.
// The transcript is derived from the reactive sync store (the same source the
// main session view uses) so streamed replies show and update live — polling
// the REST endpoint dropped messages. The founder ends the talk explicitly via
// the "build the team" button rather than relying on a model-emitted marker.
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
            scopeLabels: props.scopes
              .map((s) => BUSINESS_SCOPE_PRESETS.find((p) => p.key === s)?.title ?? s)
              .join("、"),
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
      focusInput()
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

  // Derive the conversation from the reactive store: flatten every agent bucket
  // for this session, order by message id (time-ordered), and join each
  // message's visible text parts. Streaming deltas update parts in place, so
  // this memo re-runs and the UI follows along.
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

  // Busy while the founder's prompt is in flight or the assistant is still
  // generating its reply (last message is an assistant with no completed time).
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

  function finish() {
    const mission = transcript()
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n")
    props.onComplete({ mission })
  }

  const userTurns = () => transcript().filter((m) => m.role === "user").length
  const enoughDepth = () => userTurns() >= 4

  return (
    <OnboardingFrame
      stepIndex={props.stepIndex}
      stepCount={props.stepCount}
      title={t("onboarding.mission.title")}
      subtitle={t("onboarding.mission.subtitle")
        .replace("{{name}}", props.userName)
        .replace("{{assistant}}", props.assistantName)}
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
            <Show when={userTurns() > 0 && userTurns() < 4}>
              <text fg={theme.textMuted}>
                {t("onboarding.mission.hint").replace("{{n}}", String(4 - userTurns()))}
              </text>
            </Show>
            <box />
            <Show when={enoughDepth()}>
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

      <Show when={!ready() && !error()}>
        <Spinner color={theme.textMuted}>{t("onboarding.interview.preparing")}</Spinner>
      </Show>

      {/* Transcript (last few turns) */}
      <Show when={ready()}>
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

