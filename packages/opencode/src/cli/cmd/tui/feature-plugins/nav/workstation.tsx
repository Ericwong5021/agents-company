import type { TuiPlugin, TuiPluginModule } from "@agents-company/plugin/tui"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useLanguage } from "../../context/language"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useRightSidebar } from "../../context/right-sidebar"
import { useKeybind } from "../../context/keybind"
import { Card } from "../../component/card"

const id = "internal:nav-workstation"

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
  kind: string
  status: string
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tk`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tk`
  return `${n} tk`
}

function WorkstationView() {
  const { theme } = useTheme()
  const t = useLanguage().t
  const sdk = useSDK()
  const route = useRoute()
  const rightSidebar = useRightSidebar()
  const keybind = useKeybind()

  const [refetch, setRefetch] = createSignal(0)

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

  const activeThreads = createMemo(() => (allThreads() ?? []).filter((t) => t.status === "active"))

  const agentThreadCounts = createMemo(() => {
    const counts: Record<string, number> = {}
    for (const t of activeThreads()) {
      counts[t.agentID] = (counts[t.agentID] ?? 0) + 1
    }
    return counts
  })

  const agentTokenTotals = createMemo(() => {
    const totals: Record<string, number> = {}
    for (const t of activeThreads()) {
      totals[t.agentID] = (totals[t.agentID] ?? 0) + t.spentTokens
    }
    return totals
  })

  // Right sidebar: summary
  createMemo(() => {
    const list = agents() ?? []
    const statuses = agentStatuses() ?? {}
    rightSidebar.set(() => (
      <box height="100%" flexDirection="column">
        <box flexShrink={0} paddingRight={1} paddingBottom={1}>
          <text fg={theme.textMuted}>
            <b>Workstation</b>
          </text>
        </box>
        <scrollbox flexGrow={1}>
          <box flexShrink={0} gap={0} paddingRight={1}>
            <For each={list}>
              {(a) => {
                const status = () => statuses[a.id] ?? "idle"
                return (
                  <box
                    flexShrink={0}
                    onMouseUp={() =>
                      route.navigate({ type: "plugin", id: "agent-management", data: { agentID: a.id } })
                    }
                  >
                    <text fg={theme.text}>
                      {STATUS_ICON[status()]}{" "}
                      {a.icon ? a.icon + " " : ""}
                      {a.name}
                    </text>
                  </box>
                )
              }}
            </For>
          </box>
        </scrollbox>
      </box>
    ))
  })

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexShrink={0} flexDirection="row" alignItems="center" gap={1} paddingTop={1}>
        <text fg={theme.text}>
          <b>Workstation</b>
        </text>
        <box flexGrow={1} />
        <box onMouseUp={() => setRefetch((n) => n + 1)}>
          <text fg={theme.accent}>Refresh</text>
        </box>
      </box>

      <scrollbox flexGrow={1}>
        <box flexDirection="column" gap={1} paddingTop={1}>
          {/* Agent cards grid */}
          <box flexShrink={0} flexDirection="row" gap={1} flexWrap="wrap">
            <For each={agents() ?? []}>
              {(a) => {
                const status = () => (agentStatuses() ?? {})[a.id] ?? "idle"
                const threadCount = () => (agentThreadCounts() ?? {})[a.id] ?? 0
                const tokenTotal = () => (agentTokenTotals() ?? {})[a.id] ?? 0
                return (
                  <box
                    border={["top", "left", "right", "bottom"]}
                    borderColor={a.color ?? theme.border}
                    flexDirection="column"
                    gap={0}
                    width={22}
                    flexShrink={0}
                    onMouseUp={() =>
                      route.navigate({ type: "plugin", id: "agent-management", data: { agentID: a.id } })
                    }
                  >
                    <box paddingLeft={1} paddingRight={1} paddingTop={0} paddingBottom={0}>
                      <text fg={theme.text}>
                        <b>{a.icon ? a.icon + " " : ""}{a.name}</b>
                      </text>
                      <text fg={theme.textMuted}>
                        {STATUS_ICON[status()]} {status()}
                      </text>
                      <Show when={a.description}>
                        <text fg={theme.textMuted}>{a.description}</text>
                      </Show>
                      <text fg={theme.textMuted}>
                        {threadCount()} thread{threadCount() !== 1 ? "s" : ""}
                      </text>
                      <text fg={theme.textMuted}>{formatTokens(tokenTotal())}</text>
                    </box>
                  </box>
                )
              }}
            </For>
            <Show when={(agents() ?? []).length === 0}>
              <text fg={theme.textMuted}>No agents configured yet.</text>
            </Show>
          </box>

          {/* Active threads table */}
          <Show when={activeThreads().length > 0}>
            <box flexShrink={0} paddingTop={1}>
              <text fg={theme.text}>
                <b>Active Threads</b>
              </text>
            </box>
            <box flexShrink={0} flexDirection="column" border={["top", "left", "right", "bottom"]} borderColor={theme.border}>
              {/* Header */}
              <box flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundElement}>
                <box width={16}>
                  <text fg={theme.textMuted}>Agent</text>
                </box>
                <box width={10}>
                  <text fg={theme.textMuted}>Kind</text>
                </box>
                <box width={10}>
                  <text fg={theme.textMuted}>Status</text>
                </box>
                <box flexGrow={1}>
                  <text fg={theme.textMuted}>Tokens</text>
                </box>
              </box>
              {/* Rows */}
              <For each={activeThreads()}>
                {(t) => {
                  const agent = () => (agents() ?? []).find((a) => a.id === t.agentID)
                  return (
                    <box flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1} border={["top"]} borderColor={theme.border}>
                      <box width={16}>
                        <text fg={theme.text}>
                          {agent()?.icon ? agent()!.icon + " " : ""}{agent()?.name ?? t.agentID}
                        </text>
                      </box>
                      <box width={10}>
                        <text fg={theme.textMuted}>{t.kind}</text>
                      </box>
                      <box width={10}>
                        <text fg={theme.textMuted}>{t.status}</text>
                      </box>
                      <box flexGrow={1}>
                        <text fg={theme.textMuted}>
                          {formatTokens(t.spentTokens)}
                          {t.budgetTokens ? `/${formatTokens(t.budgetTokens)}` : ""}
                        </text>
                      </box>
                    </box>
                  )
                }}
              </For>
            </box>
          </Show>
        </box>
      </scrollbox>
    </box>
  )
}

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
