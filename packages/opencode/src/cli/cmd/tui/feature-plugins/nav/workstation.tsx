import type { TuiPlugin, TuiPluginModule } from "@agents-company/plugin/tui"
import { createMemo, createResource, createSignal, createEffect, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useLanguage } from "../../context/language"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useRightSidebar } from "../../context/right-sidebar"
import { useEvent } from "../../context/event"
import { useToast } from "../../ui/toast"
import { Card } from "../../component/card"
import { AgentCard, type AgentCardData, type AgentStatus, type ThreadInfo } from "./agent-card"

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
  org_layer?: string
  department?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
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
  const toast = useToast()

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
  // Actions
  // -------------------------------------------------------------------------

  const handleStart = async (agentID: string) => {
    const res = await sdk.fetch(`${sdk.url}/thread`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentID,
        kind: "primary",
        description: t("tui.workstation.action.start_description"),
      }),
    })
    if (!res.ok) {
      toast.show({ variant: "error", message: t("tui.workstation.action.start_failed") })
    } else {
      toast.show({ variant: "info", message: t("tui.workstation.action.start_success") })
      bump()
    }
  }

  const handleStop = async (agentID: string) => {
    const threads = (allThreads() ?? []).filter(
      (t) => t.agentID === agentID && t.status === "active",
    )
    if (threads.length === 0) return

    const results = await Promise.all(
      threads.map(async (thread) => {
        const res = await sdk.fetch(`${sdk.url}/thread/${thread.id}/complete`, {
          method: "POST",
        })
        return res.ok
      }),
    )

    const allOk = results.every(Boolean)
    if (!allOk) {
      toast.show({ variant: "error", message: t("tui.workstation.action.stop_failed") })
    } else {
      toast.show({ variant: "info", message: t("tui.workstation.action.stop_success") })
      bump()
    }
  }

  const handleConfigure = (agentID: string) => {
    route.navigate({ type: "plugin", id: "agent-management", data: { agentID } })
  }

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------

  const activeThreads = createMemo(() => (allThreads() ?? []).filter((t) => t.status === "active"))

  const workstationAgents = createMemo<AgentCardData[]>(() => {
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
        orgLayer: a.org_layer,
        department: a.department,
        status: statuses[a.id] ?? "idle",
        threads: agentThreads,
        totalTokens,
      }
    })
  })

  const summary = createMemo(() => {
    const list = workstationAgents()
    const totalAgents = list.length
    const activeAgents = list.filter((a) => a.status !== "idle").length
    const totalThreads = list.reduce((sum, a) => sum + a.threads.length, 0)
    const openTasks = list.reduce(
      (sum, a) => sum + a.threads.filter((t) => t.kind === "primary").length,
      0,
    )
    return { totalAgents, activeAgents, totalThreads, openTasks }
  })

  // -------------------------------------------------------------------------
  // Right sidebar
  // -------------------------------------------------------------------------

  createEffect(() => {
    const list = workstationAgents()
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
              {t("tui.workstation.summary.active")}: <text fg={theme.accent}>{s.activeAgents}</text>/{s.totalAgents}
            </text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.threads")}: <text fg={theme.accent}>{s.totalThreads}</text>
            </text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.tasks")}: <text fg={theme.accent}>{s.openTasks}</text>
            </text>
          </box>
        </Card>

        {/* Agent list */}
        <box flexShrink={0} paddingTop={1} paddingBottom={0}>
          <text fg={theme.textMuted}>
            <b>{t("tui.workstation.agents")}</b>
          </text>
        </box>
        <scrollbox flexGrow={1}>
          <box flexShrink={0} gap={0} paddingRight={1}>
            <For each={list}>
              {(a) => {
                const statusConfig = {
                  idle: { icon: "●", colorKey: "success" as const },
                  busy: { icon: "◉", colorKey: "warning" as const },
                  paused: { icon: "◐", colorKey: "textMuted" as const },
                }
                const cfg = statusConfig[a.status]
                return (
                  <box
                    flexShrink={0}
                    paddingTop={0}
                    paddingBottom={0}
                    onMouseUp={() => handleConfigure(a.id)}
                  >
                    <text>
                      <text fg={theme[cfg.colorKey]}>{cfg.icon}</text>
                      <text fg={theme.text}>
                        {" "}
                        {a.icon ? a.icon + " " : ""}
                        {a.name}
                      </text>
                      <Show when={a.department}>
                        <text fg={theme.textMuted}> ({a.department})</text>
                      </Show>
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
            <text fg={theme.accent}>+ {t("tui.workstation.create_agent")}</text>
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
        <text fg={theme.textMuted}>({summary().totalAgents})</text>
        <box flexGrow={1} />
        <box onMouseUp={bump}>
          <text fg={theme.accent}>{t("tui.workstation.refresh")}</text>
        </box>
        <box onMouseUp={() => route.navigate({ type: "plugin", id: "agent-management" })}>
          <text fg={theme.accent}>+ {t("tui.workstation.add_agent")}</text>
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
              {t("tui.workstation.summary.active")}: <text fg={theme.accent}>{summary().activeAgents}</text>/{summary().totalAgents}
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.threads")}: <text fg={theme.accent}>{summary().totalThreads}</text>
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.tasks")}: <text fg={theme.accent}>{summary().openTasks}</text>
            </text>
          </box>

          {/* Agent cards */}
          <box flexShrink={0} flexDirection="column" gap={1}>
            <For each={workstationAgents()}>
              {(agent) => (
                <AgentCard
                  agent={agent}
                  onStart={handleStart}
                  onStop={handleStop}
                  onConfigure={handleConfigure}
                />
              )}
            </For>

            <Show when={workstationAgents().length === 0}>
              <text fg={theme.textMuted}>{t("tui.workstation.empty")}</text>
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
              {t("tui.workstation.summary.active")}: <text fg={theme.accent}>{summary().activeAgents}</text>/{summary().totalAgents}
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.threads")}: <text fg={theme.accent}>{summary().totalThreads}</text>
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.tasks")}: <text fg={theme.accent}>{summary().openTasks}</text>
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
