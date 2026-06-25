import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { Spinner } from "@tui/component/spinner"
import { BusinessScopeCards } from "./business-scope-cards"
import { TextAttributes, TextareaRenderable } from "@opentui/core"
import { useLanguage } from "@tui/context/language"
import { useKeyboard } from "@opentui/solid"

interface StepInterviewProps {
  key?: number
  onComplete: (data: {
    agentIDs: string[]
    userName: string
    assistantName: string
    businessScopes: string[]
  }) => void
}

type MessageRole = "user" | "assistant" | "system"

interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: number
}

interface InterviewError {
  type: "session" | "agent" | "message" | "timeout"
  message: string
  retryable: boolean
}

export function StepInterview(props: StepInterviewProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const t = useLanguage().t

  const [messages, setMessages] = createSignal<ChatMessage[]>([])
  const [input, setInput] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [sessionID, setSessionID] = createSignal<string | null>(null)
  const [phase, setPhase] = createSignal<"greeting" | "scope" | "interview" | "confirm" | "creating">("greeting")
  const [userName, setUserName] = createSignal("")
  const [assistantName, setAssistantName] = createSignal("")
  const [selectedScopes, setSelectedScopes] = createSignal<string[]>([])
  const [initialized, setInitialized] = createSignal(false)
  const [error, setError] = createSignal<InterviewError | null>(null)
  const [validationErrors, setValidationErrors] = createSignal<string[]>([])


  onMount(async () => {
    await initializeInterview()
  })

  async function initializeInterview() {
    setError(null)
    setValidationErrors([])

    try {
      // Create the onboarding company agent first
      const agentCreated = await createOnboardingAgent()
      if (!agentCreated) {
        setError({
          type: "agent",
          message: "Failed to create onboarding assistant. Please try again.",
          retryable: true,
        })
        return
      }

      // Then create a session with it
      const sessionCreated = await createSession()
      if (!sessionCreated) {
        setError({
          type: "session",
          message: "Failed to create session. Please try again.",
          retryable: true,
        })
        return
      }

      setInitialized(true)
    } catch (err) {
      setError({
        type: "session",
        message: `Initialization failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        retryable: true,
      })
    }
  }

  async function createOnboardingAgent(): Promise<boolean> {
    try {
      // Check if the onboarding agent already exists
      const existing = await sdk.fetch(`${sdk.url}/company-agent`)
      if (existing.ok) {
        const agents = await existing.json()
        if (agents.some((a: any) => a.id === "onboarding-assistant")) return true
      }

      // Create the onboarding company agent
      const res = await sdk.fetch(`${sdk.url}/company-agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "onboarding-assistant",
          name: "Onboarding Assistant",
          description: "A warm, friendly guide that helps new users set up their company profile",
          color: "#8B5CF6",
          icon: "🌟",
          system_prompt: ONBOARDING_SYSTEM_PROMPT,
        }),
      })

      return res.ok
    } catch {
      return false
    }
  }

  async function createSession(): Promise<boolean> {
    try {
      const res = await sdk.client.session.create({
        companyAgentID: "onboarding-assistant",
      })
      if (res.data) {
        setSessionID(res.data.id)
        // Send initial greeting to trigger the assistant
        await sendMessage(res.data.id, "Hello, I'm ready to start the onboarding process.")
        return true
      }
      return false
    } catch {
      return false
    }
  }

  async function sendMessage(sid: string, text: string) {
    setLoading(true)
    setError(null)

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    }
    setMessages((prev) => [...prev, userMsg])
    setInput("")

    try {
      await sdk.client.session.promptAsync({
        sessionID: sid,
        parts: [{ type: "text", text }],
      })
    } catch (err) {
      setError({
        type: "message",
        message: "Failed to send message. Please try again.",
        retryable: true,
      })
      setLoading(false)
    }
  }

  // Listen for assistant messages via polling
  createEffect(() => {
    const sid = sessionID()
    if (!sid) return

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined

    const interval = setInterval(async () => {
      try {
        const msgRes = await sdk.client.session.messages({ sessionID: sid })
        if (msgRes.data) {
          const assistantMsgs = msgRes.data
            .filter((m: any) => m.info?.role === "assistant")
            .map((m: any) => ({
              id: m.info?.id || `assistant-${Date.now()}`,
              role: "assistant" as const,
              content: m.parts
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text || "")
                .join(""),
              timestamp: Date.now(),
            }))

          // Check for markers in the latest assistant message
          const latest = assistantMsgs[assistantMsgs.length - 1]
          if (latest) {
            const content = latest.content

            // Check for business scope marker
            if (content.includes("[SHOW_BUSINESS_SCOPE_CARDS]") && phase() === "greeting") {
              setPhase("scope")
            }

            // Check for onboarding complete marker
            const completeMatch = content.match(
              /\[ONBOARDING_COMPLETE:([^\]]+)\]/,
            )
            if (completeMatch) {
              const agentIDs = completeMatch[1].split(",").map((s: string) => s.trim())
              setPhase("creating")

              // Validate before completing
              const errors: string[] = []
              if (!userName()) errors.push("User name not captured")
              if (!assistantName()) errors.push("Assistant name not captured")
              if (selectedScopes().length === 0) errors.push("No business scopes selected")
              if (agentIDs.length === 0) errors.push("No founding team members created")

              if (errors.length > 0) {
                setValidationErrors(errors)
                setPhase("interview")
                setLoading(false)
                return
              }

              setTimeout(() => {
                props.onComplete({
                  agentIDs,
                  userName: userName(),
                  assistantName: assistantName(),
                  businessScopes: selectedScopes(),
                })
              }, 1500)
            }
          }

          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.id))
            const newMsgs = assistantMsgs.filter((m: ChatMessage) => !existingIds.has(m.id))
            return [...prev, ...newMsgs]
          })

          setLoading(false)

          // Reset timeout on successful message
          if (timeoutTimer) clearTimeout(timeoutTimer)
          timeoutTimer = setTimeout(() => {
            // If no response for 30 seconds, show warning
            if (loading()) {
              setError({
                type: "timeout",
                message: "Response is taking longer than expected. Please wait or try again.",
                retryable: true,
              })
            }
          }, 30000)
        }
      } catch (err) {
        console.error("Failed to fetch messages:", err)
      }
    }, 1000)

    onCleanup(() => {
      clearInterval(interval)
      if (timeoutTimer) clearTimeout(timeoutTimer)
    })
  })

  function validateAndSubmit() {
    const text = input().trim()
    if (!text || loading() || !sessionID()) return

    // Validate based on current phase
    const errors: string[] = []

    if (phase() === "greeting" && !userName()) {
      // First message should be the user's name
      if (text.length < 1 || text.length > 50) {
        errors.push("Please enter a valid name (1-50 characters)")
      }
    } else if (phase() === "greeting" && userName() && !assistantName()) {
      // Second message should be the assistant's name
      if (text.length < 1 || text.length > 30) {
        errors.push("Please enter a valid assistant name (1-30 characters)")
      }
      if (text.toLowerCase() === userName().toLowerCase()) {
        errors.push("Assistant name should be different from your name")
      }
    }

    if (errors.length > 0) {
      setValidationErrors(errors)
      return
    }

    setValidationErrors([])

    // Detect names from user input
    if (phase() === "greeting" && !userName()) {
      setUserName(text)
    } else if (phase() === "greeting" && userName() && !assistantName()) {
      setAssistantName(text)
      setPhase("interview")
    }

    sendMessage(sessionID()!, text)
  }

  function handleScopeConfirm(scopes: string[]) {
    if (scopes.length === 0) {
      setValidationErrors(["Please select at least one business scope"])
      return
    }

    setValidationErrors([])
    setSelectedScopes(scopes)
    setPhase("interview")
    if (sessionID()) {
      sendMessage(
        sessionID()!,
        `I've selected the following business scopes: ${scopes.join(", ")}`,
      )
    }
  }

  function handleRetry() {
    setError(null)
    setValidationErrors([])
    initializeInterview()
  }

  // Auto-scroll to bottom when new messages arrive (handled by overflow behavior)

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Header */}
      <box
        flexDirection="row"
        justifyContent="center"
        paddingTop={1}
        paddingBottom={1}
        border={["top", "left", "right"]}
        borderColor={theme.border}
      >
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          🌟 Onboarding Interview
        </text>
      </box>

      {/* Error display */}
      <Show when={error()}>
        <box
          backgroundColor={theme.error}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
        >
          <text fg={theme.background}>
            ⚠ {error()!.message}
          </text>
          <Show when={error()!.retryable}>
            <box
              backgroundColor={theme.background}
              paddingLeft={2}
              paddingRight={2}
              onMouseUp={handleRetry}
            >
              <text fg={theme.error}>Retry ↻</text>
            </box>
          </Show>
        </box>
      </Show>

      {/* Validation errors */}
      <Show when={validationErrors().length > 0}>
        <box
          backgroundColor={theme.warning || theme.error}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <For each={validationErrors()}>
            {(err) => (
              <text fg={theme.background}>• {err}</text>
            )}
          </For>
        </box>
      </Show>

      {/* Messages area */}
      <box
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
      >
        <Show when={!initialized() && !error()}>
          <box
            flexDirection="column"
            justifyContent="center"
            alignItems="center"
            height="100%"
          >
            <Spinner color={theme.textMuted}>Preparing your assistant...</Spinner>
          </box>
        </Show>
        <For each={messages()}>
          {(msg) => (
            <box flexDirection="column" marginBottom={1}>
              <box flexDirection="row" gap={1}>
                <text
                  fg={msg.role === "user" ? theme.primary : theme.success}
                  attributes={TextAttributes.BOLD}
                >
                  {msg.role === "user" ? "You:" : `${assistantName() || "Assistant"}:`}
                </text>
              </box>
              <box paddingLeft={2}>
                <text fg={theme.text}>
                  {msg.content
                    .replace(/\[SHOW_BUSINESS_SCOPE_CARDS\]/g, "")
                    .replace(/\[ONBOARDING_COMPLETE:[^\]]+\]/g, "")
                    .trim()}
                </text>
              </box>
            </box>
          )}
        </For>
        <Show when={loading()}>
          <box flexDirection="row" gap={1} paddingLeft={2}>
            <Spinner color={theme.textMuted} />
          </box>
        </Show>
      </box>

      {/* Business scope cards (shown in scope phase) */}
      <Show when={phase() === "scope"}>
        <box
          border={["top"]}
          borderColor={theme.border}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
        >
          <BusinessScopeCards onConfirm={handleScopeConfirm} />
        </box>
      </Show>

      {/* Creating team indicator */}
      <Show when={phase() === "creating"}>
        <box
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          paddingTop={2}
          paddingBottom={2}
          border={["top"]}
          borderColor={theme.border}
        >
          <Spinner color={theme.primary}>Assembling your founding team...</Spinner>
          <box paddingTop={1}>
            <text fg={theme.textMuted}>This may take a moment</text>
          </box>
        </box>
      </Show>

      {/* Input area */}
      <Show when={phase() !== "scope" && phase() !== "creating"}>
        <box
          flexDirection="row"
          border={["top"]}
          borderColor={theme.border}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          gap={1}
        >
          <box
            flexGrow={1}
            backgroundColor={theme.backgroundElement}
            paddingLeft={1}
            paddingRight={1}
          >
            <textarea
              height={1}
              placeholder={
                phase() === "greeting" && !userName()
                  ? "Type your name..."
                  : phase() === "greeting" && !assistantName()
                    ? "Name your assistant..."
                    : "Type your message..."
              }
              placeholderColor={theme.textMuted}
              textColor={loading() || error() ? theme.textMuted : theme.text}
              focusedTextColor={loading() || error() ? theme.textMuted : theme.text}
              cursorColor={loading() || error() ? theme.backgroundElement : theme.text}
              keyBindings={loading() || error() ? [] : [{ name: "return", action: "submit" }]}
              onSubmit={() => {
                if (loading() || error()) return
                validateAndSubmit()
              }}
              ref={(val: TextareaRenderable) => {
                // Store ref for later use if needed
              }}
            />
          </box>
          <box
            backgroundColor={loading() || error() ? theme.backgroundElement : theme.primary}
            paddingLeft={2}
            paddingRight={2}
            onMouseUp={validateAndSubmit}
          >
            <text fg={loading() || error() ? theme.textMuted : theme.background}>
              Send
            </text>
          </box>
        </box>
      </Show>
    </box>
  )
}

const ONBOARDING_SYSTEM_PROMPT = `You are the Onboarding Assistant — a warm, friendly guide who helps new users set up their company profile and assemble their founding team.

Your Communication Style:
- Warm and personal. Use the user's name once you learn it.
- Concise but friendly. Keep messages short and conversational.
- Encouraging. Validate their ideas and build on them.
- Bilingual awareness. If the user writes in Chinese, respond in Chinese.

Conversation Flow:

1. Greet and Learn Their Name
Start with a warm greeting, then ask for their name.

2. Help Them Name You
After learning their name, ask them to give you a name.

3. Business Scope Selection
When you reach this step, output EXACTLY this marker on its own line:
[SHOW_BUSINESS_SCOPE_CARDS]
Wait for the user to confirm their selections.

4. Mission and Goals Interview
Ask about their company's mission, vision, and goals. Keep it conversational.

5. Summary and Confirmation
Summarize what you learned and ask for confirmation.

6. Founding Team Assembly
After confirmation, output:
[ONBOARDING_COMPLETE:agent_id_1,agent_id_2]

Critical Rules:
- Never skip steps
- Wait for responses
- Confirm before proceeding
- Use the markers exactly as specified
- Keep it natural`
