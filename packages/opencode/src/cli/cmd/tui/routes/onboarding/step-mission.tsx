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
//
// On mount we send a hidden kickstart message asking the assistant to generate
// a personalised opening line. That line is shown in the speech bubble and
// filtered from the visible transcript — the founder sees the AI-crafted
// greeting, then types their first real message to begin.
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
  // The AI-generated opening line, shown in the speech bubble.
  const [openingLine, setOpeningLine] = createSignal<string | null>(null)
  // The id of the hidden kickstart user message, so we can filter it.
  const [kickoffID, setKickoffID] = createSignal<string | null>(null)
  let textarea: TextareaRenderable | undefined

  const agentID = "onboarding-assistant"
  const KICKOFF_TEXT = `[系统] 请根据以下创始人信息，用一两句话生成一句温暖、个性化的开场白，作为你和创始人对话的开始。不要加任何前缀或解释，直接说开场白。\n创始人名字：${props.userName}\n业务方向：${props.scopes.map((s) => BUSINESS_SCOPE_PRESETS.find((p) => p.key === s)?.title ?? s).join("、")}`

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
      const sid = res.data.id
      setSessionID(sid)

      // Send a hidden kickstart so the AI generates a personalised opening.
      setSubmitting(true)
      try {
        await sdk.client.session.promptAsync({
          sessionID: sid,
          parts: [{ type: "text", text: KICKOFF_TEXT }],
        })
      } catch {
        setError(t("onboarding.mission.error"))
        return
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

  // Derive the conversation from the reactive store: flatten every agent bucket
  // for this session, order by message id (time-ordered), and join each
  // message's visible text parts. Streaming deltas update parts in place, so
  // this memo re-runs and the UI follows along.
  const transcript = createMemo(() => {
    const sid = sessionID()
    if (!sid) return []
    const buckets = sync.data.message[sid]
    if (!buckets) return []
    const koID = kickoffID()
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
      .filter((m) => m.content.trim().length > 0 && m.id !== koID)
  })

  // Capture the kickstart user message id and the assistant's opening reply.
  // Once both exist, we show the opening line in the speech bubble and mark
  // the step as ready for the founder to type.
  createMemo(() => {
    const sid = sessionID()
    if (!sid || ready()) return
    const buckets = sync.data.message[sid]
    if (!buckets) return
    const all = Object.values(buckets).flat().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    // Find the kickstart user message (first user message).
    const kickoff = all.find((m) => m.role === "user")
    if (kickoff && !kickoffID()) setKickoffID(kickoff.id)

    // Find the assistant reply to the kickstart.
    const assistantReply = all.find((m) => m.role === "assistant" && m.time.completed)
    if (assistantReply && kickoffID()) {
      const text = (sync.data.part[assistantReply.id] ?? [])
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => ("text" in p ? (p.text ?? "") : ""))
        .join("")
        .trim()
      if (text) {
        setOpeningLine(text)
        setSubmitting(false)
        setReady(true)
        focusInput()
      }
    }
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
      speaker={{ name: props.assistantName, icon: "🌟" }}
      speech={openingLine() ?? undefined}
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

      {/* Generating the opening line */}
      <Show when={!ready() && !error()}>
        <box flexDirection="row" alignItems="center" gap={1} paddingLeft={1}>
          <Spinner color={theme.primary} />
          <text fg={theme.textMuted}>{t("onboarding.mission.generating")}</text>
        </box>
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
