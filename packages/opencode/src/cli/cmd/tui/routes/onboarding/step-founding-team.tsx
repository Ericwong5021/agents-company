import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { TextAttributes } from "@opentui/core"
import { Spinner } from "@tui/component/spinner"

interface StepFoundingTeamProps {
  agentIDs: string[]
  userName: string
  assistantName: string
  businessScopes: string[]
  onComplete: () => void
}

interface AgentInfo {
  id: string
  name: string
  description: string | null
  color: string | null
  icon: string | null
}

interface TeamError {
  type: "fetch" | "empty" | "partial"
  message: string
  retryable: boolean
}

export function StepFoundingTeam(props: StepFoundingTeamProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const [agents, setAgents] = createSignal<AgentInfo[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [visibleCards, setVisibleCards] = createSignal(0)
  const [error, setError] = createSignal<TeamError | null>(null)
  const [fetchAttempts, setFetchAttempts] = createSignal(0)

  onMount(async () => {
    await fetchAgents()
  })

  async function fetchAgents() {
    setError(null)
    setFetchAttempts((c) => c + 1)

    // Validate agentIDs
    if (!props.agentIDs || props.agentIDs.length === 0) {
      setError({
        type: "empty",
        message: "No founding team members were created. Please go back and complete the interview.",
        retryable: true,
      })
      return
    }

    const agentList: AgentInfo[] = []
    const failedIDs: string[] = []

    for (const id of props.agentIDs) {
      try {
        const res = await sdk.fetch(`${sdk.url}/company-agent/${id}`)
        if (res.ok) {
          const data = await res.json()
          agentList.push({
            id: data.id,
            name: data.name,
            description: data.description,
            color: data.color,
            icon: data.icon,
          })
        } else {
          failedIDs.push(id)
        }
      } catch {
        failedIDs.push(id)
      }
    }

    if (agentList.length === 0) {
      setError({
        type: "fetch",
        message: "Failed to load founding team members. Please try again.",
        retryable: true,
      })
      return
    }

    if (failedIDs.length > 0) {
      setError({
        type: "partial",
        message: `Loaded ${agentList.length} of ${props.agentIDs.length} team members. Some may be missing.`,
        retryable: true,
      })
    }

    setAgents(agentList)
    setLoaded(true)

    // Stagger card appearance
    for (let i = 0; i < agentList.length; i++) {
      setTimeout(() => {
        setVisibleCards((prev) => prev + 1)
      }, 400 * (i + 1))
    }
  }

  function handleRetry() {
    setLoaded(false)
    setVisibleCards(0)
    setAgents([])
    fetchAgents()
  }

  function handleEnter() {
    // Final validation before completing
    if (agents().length === 0) {
      setError({
        type: "empty",
        message: "Cannot proceed without founding team members.",
        retryable: true,
      })
      return
    }

    props.onComplete()
  }

  return (
    <box
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      width="100%"
      height="100%"
      gap={2}
    >
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

      {/* Achievement banner */}
      <box flexDirection="column" alignItems="center" gap={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>
          🏆 Founding Team Assembled!
        </text>
        <text fg={theme.textMuted}>
          Congratulations, {props.userName}! Your team is ready.
        </text>
      </box>

      {/* Loading state */}
      <Show when={!loaded() && !error()}>
        <Spinner color={theme.textMuted}>Loading team details...</Spinner>
      </Show>

      {/* Agent cards */}
      <Show when={loaded()}>
        <box flexDirection="row" gap={2} flexWrap="wrap" justifyContent="center">
          <For each={agents()}>
            {(agent, index) => (
              <Show when={index() < visibleCards()}>
                <box
                  flexDirection="column"
                  width={30}
                  backgroundColor={theme.backgroundPanel}
                  border
                  borderColor={theme.border}
                  paddingTop={2}
                  paddingBottom={2}
                  paddingLeft={2}
                  paddingRight={2}
                  gap={1}
                >
                  <box flexDirection="row" gap={1} alignItems="center">
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      {agent.icon || "👤"}
                    </text>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      {agent.name}
                    </text>
                  </box>
                  <Show when={agent.description}>
                    <box>
                      <text fg={theme.textMuted}>
                        {agent.description}
                      </text>
                    </box>
                  </Show>
                  <box flexDirection="row" gap={1}>
                    <text fg={theme.textMuted}>ID:</text>
                    <text fg={theme.primary}>{agent.id}</text>
                  </box>
                </box>
              </Show>
            )}
          </For>
        </box>
      </Show>

      {/* Summary info */}
      <Show when={loaded() && visibleCards() >= agents().length}>
        <box flexDirection="column" alignItems="center" gap={1}>
          <text fg={theme.textMuted}>
            Business scopes: {props.businessScopes.join(", ")}
          </text>
        </box>
      </Show>

      {/* Enter button */}
      <Show when={loaded() && visibleCards() >= agents().length}>
        <box flexDirection="column" alignItems="center" gap={1} paddingTop={2}>
          <text fg={theme.textMuted}>
            {props.assistantName} and your founding team are ready to help.
          </text>
          <box
            backgroundColor={theme.primary}
            paddingLeft={4}
            paddingRight={4}
            paddingTop={1}
            paddingBottom={1}
            onMouseUp={handleEnter}
          >
            <text fg={theme.background}>Enter Company →</text>
          </box>
        </box>
      </Show>
    </box>
  )
}
