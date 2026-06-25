import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useLanguage } from "@tui/context/language"
import { useDialog } from "@tui/ui/dialog"
import { Spinner } from "@tui/component/spinner"
import { TextAttributes, TextareaRenderable } from "@opentui/core"
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

interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
}

// Conversational phase: the now-named assistant talks the founder through what
// the company wants to build and which goals matter, using the default model.
// Unlike the old version we don't depend on the model emitting control markers —
// the founder explicitly clicks "build the team" when the talk feels done.
export function StepMission(props: StepMissionProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const t = useLanguage().t
  const dialog = useDialog()

  const [messages, setMessages] = createSignal<ChatMessage[]>([])
  const [loading, setLoading] = createSignal(false)
  const [sessionID, setSessionID] = createSignal<string | null>(null)
  const [ready, setReady] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let textarea: TextareaRenderable | undefined

  const agentID = "onboarding-assistant"
  const KICKOFF = t("onboarding.mission.kickoff")

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
          system_prompt: buildSystemPrompt(props),
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
      await send(res.data.id, KICKOFF)
    } catch {
      setError(t("onboarding.mission.error"))
    }
  }

  async function send(sid: string, text: string) {
    setLoading(true)
    setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: "user", content: text }])
    try {
      await sdk.client.session.promptAsync({ sessionID: sid, parts: [{ type: "text", text }] })
    } catch {
      setError(t("onboarding.mission.error"))
      setLoading(false)
    }
  }

  // Poll for assistant replies.
  createEffect(() => {
    const sid = sessionID()
    if (!sid) return
    const interval = setInterval(async () => {
      try {
        const res = await sdk.client.session.messages({ sessionID: sid })
        if (!res.data) return
        const assistantMsgs = res.data
          .filter((m: any) => m.info?.role === "assistant")
          .map((m: any) => ({
            id: m.info?.id ?? `assistant-${Date.now()}`,
            role: "assistant" as const,
            content: m.parts
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.text ?? "")
              .join(""),
          }))
        setMessages((prev) => {
          const ids = new Set(prev.map((m) => m.id))
          return [...prev, ...assistantMsgs.filter((m: ChatMessage) => !ids.has(m.id))]
        })
        if (assistantMsgs.length > 0) setLoading(false)
      } catch {
        // transient; keep polling
      }
    }, 1000)
    onCleanup(() => clearInterval(interval))
  })

  function submit() {
    const text = (textarea?.plainText ?? "").trim()
    if (!text || loading() || !sessionID()) return
    textarea?.clear()
    send(sessionID()!, text)
    focusInput()
  }

  function finish() {
    const mission = messages()
      .filter((m) => m.role === "user" && m.content !== KICKOFF)
      .map((m) => m.content)
      .join("\n")
    props.onComplete({ mission })
  }

  // Visible turns: drop the silent kickoff and any empty assistant chunks.
  const transcript = () =>
    messages().filter((m) => m.content.trim().length > 0 && m.content !== KICKOFF)
  const exchanged = () => transcript().some((m) => m.role === "user")

  return (
    <OnboardingFrame
      stepIndex={props.stepIndex}
      stepCount={props.stepCount}
      title={t("onboarding.mission.title")}
      speaker={{ name: props.assistantName, icon: "🌟" }}
      speech={t("onboarding.mission.intro").replace("{{name}}", props.userName)}
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
                keyBindings={loading() ? [] : [{ name: "return", action: "submit" }]}
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
          <Show when={exchanged()}>
            <box flexDirection="row" justifyContent="flex-end">
              <box backgroundColor={theme.success} paddingLeft={2} paddingRight={2} onMouseUp={finish}>
                <text fg={theme.background}>{t("onboarding.mission.build")}</text>
              </box>
            </box>
          </Show>
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
          <Show when={loading()}>
            <box paddingLeft={2}>
              <Spinner color={theme.textMuted} />
            </box>
          </Show>
        </box>
      </Show>
    </OnboardingFrame>
  )
}

function buildSystemPrompt(props: StepMissionProps) {
  const scopeLabels = props.scopes
    .map((s) => BUSINESS_SCOPE_PRESETS.find((p) => p.key === s)?.title ?? s)
    .join("、")
  return `你是「${props.assistantName}」，${props.userName} 的创业小助理。你温暖、好奇、善于倾听，用对话的方式帮助创始人想清楚公司要做的事。

创始人信息：
- 名字：${props.userName}
- 业务方向：${scopeLabels}

你的任务：
- 用轻松的对谈，引导 ${props.userName} 说清楚「公司想做什么事业」以及「想达成什么目标」。
- 每次只问一个问题，简短、口语化、有温度。
- 适时帮对方把想法归纳成清晰的一句话，并确认。
- 如果创始人用中文，就用中文回复。
- 不要输出任何控制标记或代码块，只是自然地聊天。`
}
