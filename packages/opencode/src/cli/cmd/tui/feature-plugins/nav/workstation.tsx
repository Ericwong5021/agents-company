import type { TuiPlugin, TuiPluginModule } from "@agents-company/plugin/tui"
import { createMemo, createResource, createSignal, createEffect, For, Show, onCleanup } from "solid-js"
import { useTheme } from "../../context/theme"
import { useLanguage } from "../../context/language"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useRightSidebar } from "../../context/right-sidebar"
import { useEvent } from "../../context/event"
import { Card } from "../../component/card"

const id = "internal:nav-workstation"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CompanyAgentInfo {
  id: string
  name: string
  description?: string
  color?: string
  icon?: string
  model?: string
}

interface ThreadInfo {
  id: string
  agentID: string
  kind: "primary" | "reactive" | "ambient"
  status: "active" | "paused" | "completed"
  sessionID?: string
  description?: string
  budgetTokens?: number
  spentTokens: number
  time: { created: number; updated: number }
}

type AgentStatus = "idle" | "busy" | "paused"

const STATUS_ICON: Record<AgentStatus, string> = {
  idle: "○",
  busy: "◉",
  paused: "◐",
}

interface WorkstationAgent {
  id: string
  name: string
  icon?: string
  color?: string
  description?: string
  model?: string
  orgLayer: "board" | "execution"
  status: AgentStatus
  threads: ThreadInfo[]
  totalTokens: number
}

// ---------------------------------------------------------------------------
// Status indicators with colors
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
// Helpers
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

/** Derive org layer from agent ID heuristic. CEO/CTO/CFO = board, others = execution */
function deriveOrgLayer(agentID: string): "board" | "execution" {
  const boardIDs = ["ceo", "cto", "cfo", "coo", "cmo", "board"]
  if (boardIDs.includes(agentID.toLowerCase())) return "board"
  return "execution"
}

// ---------------------------------------------------------------------------
// WorkstationView
// ---------------------------------------------------------------------------

function WorkstationView() {
  const { theme } = useTheme()
  const t = useLanguage().t
  const sdk = useSDK()
  const route = useRoute()
  const rightSidebar = useRightSidebar()
  const event = useEvent()

  const [refetch, setRefetch] = createSignal(0)

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  const [agents] = createResource(refetch, async () => {
    const res = await sdk.fetch(`${sdk.url}/company-agent`)
    if (!res.ok) return [] as CompanyAgentInfo[]
    return (await res.json()) as CompanyAgentInfo[]
  })

  const [allThreads] = createResource(refetch, async () => {
    const res = await sdk.fetch(`${sdk.url}/thread`)
    if (!res.ok) return [] as ThreadInfo[]
    return (await res.json()) as ThreadInfo[]
  })

  const [agentStatuses] = createResource(refetch, async () => {
    const list = agents()
    if (!list) return {} as Record<string, AgentStatus>
    const entries = await Promise.all(
      list.map(async (a) => {
        const res = await sdk.fetch(`${sdk.url}/thread/agent/${encodeURIComponent(a.id)}/status`)
        if (!res.ok) return [a.id, "idle" as AgentStatus] as const
        const data = (await res.json()) as { status: AgentStatus }
        return [a.id, data.status] as const
      }),
    )
    return Object.fromEntries(entries) as Record<string, AgentStatus>
  })

  // -------------------------------------------------------------------------
  // Real-time updates via bus events
  // -------------------------------------------------------------------------

  const bump = () => setRefetch((n) => n + 1)

  event.on("thread.created", bump)
  event.on("thread.updated", bump)
  event.on("thread.completed", bump)

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------

  const activeThreads = createMemo(() => (allThreads() ?? []).filter((t) => t.status === "active"))

  const workstationAgents = createMemo<WorkstationAgent[]>(() => {
    const list = agents() ?? []
    const statuses = agentStatuses() ?? {}
    const threads = allThreads() ?? []

    return list.map((a) => {
      const agentThreads = threads.filter((t) => t.agentID === a.id && t.status === "active")
      const totalTokens = agentThreads.reduce((sum, t) => sum + t.spentTokens, 0)
      return {
        id: a.id,
        name: a.name,
        icon: a.icon,
        color: a.color,
        description: a.description,
        model: a.model,
        orgLayer: deriveOrgLayer(a.id),
        status: statuses[a.id] ?? "idle",
        threads: agentThreads,
        totalTokens,
      }
    })
  })

  const summary = createMemo(() => {
    const agents = workstationAgents()
    const totalAgents = agents.length
    const activeAgents = agents.filter((a) => a.status !== "idle").length
    const totalThreads = agents.reduce((sum, a) => sum + a.threads.length, 0)
    const openTasks = agents.reduce(
      (sum, a) => sum + a.threads.filter((t) => t.kind === "primary").length,
      0,
    )
    return { totalAgents, activeAgents, totalThreads, openTasks }
  })

  // -------------------------------------------------------------------------
  // Right sidebar
  // -------------------------------------------------------------------------

  createEffect(() => {
    const agents = workstationAgents()
    const s = summary()

    rightSidebar.set(() => (
      <box height="100%" flexDirection="column">
        <box flexShrink={0} paddingRight={1} paddingBottom={1}>
          <text fg={theme.textMuted}>
            <b>{t("tui.shell.right.workstation")}</b>
          </text>
        </box>

        {/* Quick stats */}
        <Card flush>
          <box flexDirection="column" gap={0} paddingLeft={1} paddingRight={1}>
            <text fg={theme.text}>
              Active: <text fg={theme.accent}>{s.activeAgents}</text>/{s.totalAgents} agents
            </text>
            <text fg={theme.text}>
              Threads: <text fg={theme.accent}>{s.totalThreads}</text>
            </text>
            <text fg={theme.text}>
              Tasks: <text fg={theme.accent}>{s.openTasks}</text> open
            </text>
          </box>
        </Card>

        {/* Agent list */}
        <box flexShrink={0} paddingTop={1} paddingBottom={0}>
          <text fg={theme.textMuted}>
            <b>Agents</b>
          </text>
        </box>
        <scrollbox flexGrow={1}>
          <box flexShrink={0} gap={0} paddingRight={1}>
            <For each={agents}>
              {(a) => {
                const cfg = STATUS_CONFIG[a.status]
                return (
                  <box
                    flexShrink={0}
                    paddingTop={0}
                    paddingBottom={0}
                    onMouseUp={() =>
                      route.navigate({ type: "plugin", id: "agent-management", data: { agentID: a.id } })
                    }
                  >
                    <text>
                      <text fg={theme[cfg.colorKey]}>{cfg.icon}</text>
                      <text fg={theme.text}>
                        {" "}
                        {a.icon ? a.icon + " " : ""}
                        {a.name}
                      </text>
                      <text fg={theme.textMuted}> ({a.orgLayer})</text>
                    </text>
                  </box>
                )
              }}
            </For>
          </box>
        </scrollbox>

        {/* Quick actions */}
        <box flexShrink={0} paddingTop={1} border={["top"]} borderColor={theme.border}>
          <box onMouseUp={() => route.navigate({ type: "plugin", id: "agent-management" })}>
            <text fg={theme.accent}>+ Create Agent</text>
          </box>
        </box>
      </box>
    ))
  })

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      {/* Header */}
      <box flexShrink={0} flexDirection="row" alignItems="center" gap={1} paddingTop={1}>
        <text fg={theme.text}>
          <b>{t("tui.shell.route.workstation")}</b>
        </text>
        <box flexGrow={1} />
        <box onMouseUp={bump}>
          <text fg={theme.accent}>Refresh</text>
        </box>
      </box>

      <scrollbox flexGrow={1}>
        <box flexDirection="column" gap={1} paddingTop={1}>
          {/* Summary bar */}
          <box
            flexShrink={0}
            flexDirection="row"
            gap={2}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={0}
            paddingBottom={0}
            backgroundColor={theme.backgroundElement}
            border={["top", "left", "right", "bottom"]}
            borderColor={theme.border}
          >
            <text fg={theme.text}>
              Active: <text fg={theme.accent}>{summary().activeAgents}</text>/{summary().totalAgents} agents
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={theme.text}>
              Threads: <text fg={theme.accent}>{summary().totalThreads}</text>
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={theme.text}>
              Tasks: <text fg={theme.accent}>{summary().openTasks}</text> open
            </text>
          </box>

          {/* Agent list with threads */}
          <box flexShrink={0} flexDirection="column" gap={1}>
            <For each={workstationAgents()}>
              {(agent) => {
                const cfg = STATUS_CONFIG[agent.status]
                return (
                  <box
                    flexShrink={0}
                    flexDirection="column"
                    gap={0}
                    border={["left"]}
                    borderColor={agent.color ?? theme.border}
                    onMouseUp={() =>
                      route.navigate({ type: "plugin", id: "agent-management", data: { agentID: agent.id } })
                    }
                  >
                    {/* Agent header */}
                    <box flexShrink={0} flexDirection="row" alignItems="center" gap={1} paddingLeft={1}>
                      <text fg={theme[cfg.colorKey]}>{cfg.icon}</text>
                      <text fg={theme.text}>
                        <b>{agent.icon ? agent.icon + " " : ""}{agent.name}</b>
                      </text>
                      <text fg={theme.textMuted}>({agent.orgLayer})</text>
                      <box flexGrow={1} />
                      <text fg={theme[cfg.colorKey]}>{agent.status}</text>
                    </box>

                    {/* Threads */}
                    <box flexShrink={0} flexDirection="column" paddingLeft={3}>
                      <Show
                        when={agent.threads.length > 0}
                        fallback={<text fg={theme.textMuted}>{"  └─ No active threads"}</text>}
                      >
                        <For each={agent.threads}>
                          {(thread, idx) => {
                            const isLast = () => idx() === agent.threads.length - 1
                            const connector = () => (isLast() ? "  └─ " : "  ├─ ")
                            const kindLabel = THREAD_KIND_LABEL[thread.kind] ?? `[${thread.kind}]`
                            const taskSummary = thread.description ?? "Working..."
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
                  </box>
                )
              }}
            </For>

            <Show when={workstationAgents().length === 0}>
              <text fg={theme.textMuted}>No agents configured yet. Create one from the Agents page.</text>
            </Show>
          </box>

          {/* Bottom separator and summary */}
          <box flexShrink={0} paddingTop={1}>
            <text fg={theme.textMuted}>
              {"─".repeat(50)}
            </text>
          </box>
          <box flexShrink={0} flexDirection="row" gap={2}>
            <text fg={theme.text}>
              Active: <text fg={theme.accent}>{summary().activeAgents}</text>/{summary().totalAgents} agents
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={theme.text}>
              Threads: <text fg={theme.accent}>{summary().totalThreads}</text>
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={theme.text}>
              Tasks: <text fg={theme.accent}>{summary().openTasks}</text> open
            </text>
          </box>
        </box>
      </scrollbox>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: "workstation",
      render: () => <WorkstationView />,
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
