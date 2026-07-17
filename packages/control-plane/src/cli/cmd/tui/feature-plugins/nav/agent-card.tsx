import { createSignal, Show, For, type JSX } from "solid-js"
import { useTheme } from "../../context/theme"
import { useLanguage } from "../../context/language"
import { formatTokens, type AgentCardData, type AgentStatus, type ThreadInfo } from "./workstation-model"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentCardProps {
  agent: AgentCardData
  onStart?: (agentID: string) => void
  onStop?: (agentID: string) => void
  onConfigure?: (agentID: string) => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<AgentStatus, { icon: string; colorKey: "success" | "warning" | "textMuted" | "error" }> = {
  idle: { icon: "●", colorKey: "success" },
  busy: { icon: "◉", colorKey: "warning" },
  paused: { icon: "◐", colorKey: "textMuted" },
}

const THREAD_KIND_LABEL: Record<string, string> = {
  primary: "[primary]",
  reactive: "[reactive]",
  ambient: "[ambient]",
}

// ---------------------------------------------------------------------------
// AgentCard
// ---------------------------------------------------------------------------

export function AgentCard(props: AgentCardProps) {
  const { theme } = useTheme()
  const t = useLanguage().t
  const [hover, setHover] = createSignal(false)

  const cfg = () => STATUS_CONFIG[props.agent.status]
  const agent = () => props.agent

  const statusLabel = () => {
    const key = `tui.workstation.status.${agent().status}` as const
    return t(key)
  }

  const threadKindLabel = (kind: string) => {
    const key = `tui.workstation.thread.${kind}` as const
    return t(key)
  }

  return (
    <box
      flexShrink={0}
      flexDirection="column"
      gap={0}
      border={["left"]}
      borderColor={agent().color ?? theme.border}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      backgroundColor={hover() ? theme.backgroundElement : undefined}
    >
      {/* Agent header */}
      <box flexShrink={0} flexDirection="row" alignItems="center" gap={1} paddingLeft={1}>
        <text fg={theme[cfg().colorKey]}>{cfg().icon}</text>
        <text fg={theme.text}>
          <b>{agent().icon ? agent().icon + " " : ""}{agent().name}</b>
        </text>
        <Show when={agent().orgLayer}>
          <text fg={theme.textMuted}>({agent().orgLayer})</text>
        </Show>
        <box flexGrow={1} />
        <text fg={theme[cfg().colorKey]}>{statusLabel()}</text>
      </box>

      {/* Department and layer info */}
      <box flexShrink={0} flexDirection="row" gap={2} paddingLeft={3}>
        <Show when={agent().department}>
          <text fg={theme.textMuted}>
            {t("tui.workstation.department")}: {agent().department}
          </text>
        </Show>
        <Show when={agent().orgLayer}>
          <text fg={theme.textMuted}>
            {t("tui.workstation.layer")}: {agent().orgLayer}
          </text>
        </Show>
      </box>

      {/* Model info */}
      <Show when={agent().model}>
        <box flexShrink={0} paddingLeft={3}>
          <text fg={theme.textMuted}>model: {agent().model}</text>
        </box>
      </Show>

      {/* Threads */}
      <box flexShrink={0} flexDirection="column" paddingLeft={3}>
        <Show
          when={agent().threads.length > 0}
          fallback={<text fg={theme.textMuted}>  └─ {t("tui.workstation.no_threads")}</text>}
        >
          <For each={agent().threads}>
            {(thread, idx) => {
              const isLast = () => idx() === agent().threads.length - 1
              const connector = () => (isLast() ? "  └─ " : "  ├─ ")
              const kindLabel = threadKindLabel(thread.kind)
              const taskSummary = thread.description ?? t("tui.workstation.working")
              return (
                <text fg={theme.textMuted}>
                  {connector()}
                  <text fg={theme.accent}>{kindLabel}</text>
                  {" "}
                  {taskSummary}
                  <text fg={theme.textMuted}>
                    {" "}
                    ({formatTokens(thread.spentTokens)}
                    {thread.budgetTokens ? `/${formatTokens(thread.budgetTokens)}` : ""})
                  </text>
                </text>
              )
            }}
          </For>
        </Show>
      </box>

      {/* Token summary */}
      <box flexShrink={0} paddingLeft={3}>
        <text fg={theme.textMuted}>
          {t("tui.workstation.tokens")}: {formatTokens(agent().totalTokens)}
        </text>
      </box>

      {/* Action buttons */}
      <box flexShrink={0} flexDirection="row" gap={2} paddingLeft={3} paddingTop={0}>
        <Show when={agent().status === "idle" && props.onStart}>
          <box onMouseUp={() => props.onStart?.(agent().id)}>
            <text fg={theme.success}>{t("tui.workstation.action.start")}</text>
          </box>
        </Show>
        <Show when={agent().status !== "idle" && props.onStop}>
          <box onMouseUp={() => props.onStop?.(agent().id)}>
            <text fg={theme.error}>{t("tui.workstation.action.stop")}</text>
          </box>
        </Show>
        <Show when={props.onConfigure}>
          <box onMouseUp={() => props.onConfigure?.(agent().id)}>
            <text fg={theme.accent}>{t("tui.workstation.action.configure")}</text>
          </box>
        </Show>
      </box>
    </box>
  )
}
