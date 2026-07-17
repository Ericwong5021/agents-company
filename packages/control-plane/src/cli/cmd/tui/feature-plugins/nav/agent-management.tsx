import type { TuiPlugin, TuiPluginModule } from "@agents-company/plugin/tui"
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { useLanguage } from "../../context/language"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useRightSidebar } from "../../context/right-sidebar"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { useKeybind } from "../../context/keybind"
import { DialogCompanyAgentCreate } from "../../component/dialog-company-agents"
import { DialogPrompt } from "../../ui/dialog-prompt"

const id = "internal:nav-agent-management"

interface CompanyAgentInfo {
  id: string
  name: string
  description?: string
  system_prompt?: string
  color?: string
  icon?: string
  model?: string
  org_layer?: string
  department?: string
  reports_to?: string
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
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

const ORG_LAYER_ORDER = ["board", "department", "project", "execution"]

const ORG_LAYER_LABELS: Record<string, string> = {
  board: "决策层",
  department: "部门层",
  project: "项目层",
  execution: "执行层",
}

const ORG_LAYER_ICONS: Record<string, string> = {
  board: "👑",
  department: "⭐",
  project: "▸",
  execution: "▹",
}

// Group agents by org_layer → department, keeping unclassified separate.
function groupAgents(list: CompanyAgentInfo[]) {
  const classified: CompanyAgentInfo[] = []
  const unclassified: CompanyAgentInfo[] = []
  for (const a of list) {
    if (a.org_layer) classified.push(a)
    else unclassified.push(a)
  }
  const layerMap = new Map<string, Map<string, CompanyAgentInfo[]>>()
  for (const a of classified) {
    const layer = a.org_layer!
    const dept = a.department || "未分组"
    if (!layerMap.has(layer)) layerMap.set(layer, new Map())
    const deptMap = layerMap.get(layer)!
    if (!deptMap.has(dept)) deptMap.set(dept, [])
    deptMap.get(dept)!.push(a)
  }
  const layers: {
    layer: string
    label: string
    icon: string
    departments: { dept: string; agents: CompanyAgentInfo[] }[]
    totalCount: number
  }[] = []
  for (const layer of ORG_LAYER_ORDER) {
    const deptMap = layerMap.get(layer)
    if (!deptMap) continue
    const departments: { dept: string; agents: CompanyAgentInfo[] }[] = []
    let totalCount = 0
    for (const [dept, group] of deptMap) {
      departments.push({ dept, agents: group })
      totalCount += group.length
    }
    layers.push({ layer, label: ORG_LAYER_LABELS[layer] ?? layer, icon: ORG_LAYER_ICONS[layer] ?? "▸", departments, totalCount })
  }
  for (const [layer, deptMap] of layerMap) {
    if (ORG_LAYER_ORDER.includes(layer)) continue
    const departments: { dept: string; agents: CompanyAgentInfo[] }[] = []
    let totalCount = 0
    for (const [dept, group] of deptMap) {
      departments.push({ dept, agents: group })
      totalCount += group.length
    }
    layers.push({ layer, label: ORG_LAYER_LABELS[layer] ?? layer, icon: ORG_LAYER_ICONS[layer] ?? "▸", departments, totalCount })
  }
  return { layers, unclassified }
}

function AgentManagementView(props: { params?: Record<string, unknown> }) {
  const { theme } = useTheme()
  const t = useLanguage().t
  const sdk = useSDK()
  const route = useRoute()
  const rightSidebar = useRightSidebar()
  const dialog = useDialog()
  const toast = useToast()
  const keybind = useKeybind()

  const [refetch, setRefetch] = createSignal(0)
  const [selectedID, setSelectedID] = createSignal<string | undefined>((props.params?.agentID as string) ?? undefined)
  const [confirmDelete, setConfirmDelete] = createSignal<string>()
  const [editing, setEditing] = createSignal(false)

  // Detail view toggle — separate from selection so clicking an agent in the
  // hierarchy highlights it + shows the right sidebar without leaving the tree.
  const [showDetail, setShowDetail] = createSignal(!!props.params?.agentID)

  // Collapsible group state: keys are "layer:<layer>" or "dept:<layer>:<dept>"
  const [collapsed, setCollapsed] = createStore<Record<string, boolean>>({})
  const toggle = (key: string) => setCollapsed(key, (prev) => !prev)
  const isCollapsed = (key: string) => collapsed[key] ?? false

  const [hoveredID, setHoveredID] = createSignal<string | undefined>()

  const [agents] = createResource(refetch, async () => {
    const res = await sdk.fetch(`${sdk.url}/company-agent`)
    if (!res.ok) return [] as CompanyAgentInfo[]
    return (await res.json()) as CompanyAgentInfo[]
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

  // Fetch threads for the selected agent
  const [agentThreads] = createResource(selectedID, async (agentID) => {
    if (!agentID) return [] as ThreadInfo[]
    const res = await sdk.fetch(`${sdk.url}/thread?agentID=${encodeURIComponent(agentID)}`)
    if (!res.ok) return [] as ThreadInfo[]
    return (await res.json()) as ThreadInfo[]
  })

  const selected = createMemo(() => {
    const sid = selectedID()
    return (agents() ?? []).find((a) => a.id === sid) ?? null
  })

  const grouped = createMemo(() => groupAgents(agents() ?? []))

  createEffect(() => {
    const incoming = props.params?.agentID as string | undefined
    if (incoming !== undefined && incoming !== selectedID()) {
      setSelectedID(incoming)
      setShowDetail(true)
    }
  })

  const goToAgent = (id: string) => {
    const agent = (agents() ?? []).find((a) => a.id === id)
    setSelectedID(id)
    setShowDetail(true)
    route.replace({
      type: "plugin",
      id: "agent-management",
      data: { agentID: id, subLabel: agent?.name ?? id.slice(0, 8) },
    })
  }

  const goToList = () => {
    setSelectedID(undefined)
    setShowDetail(false)
    route.replace({ type: "plugin", id: "agent-management" })
  }

  // Select an agent in the hierarchy — highlights it + shows the right sidebar.
  const selectAgent = (id: string) => {
    setSelectedID(id)
    setShowDetail(false)
  }

  const openCreate = () => {
    dialog.replace(() => (
      <DialogCompanyAgentCreate
        onDone={() => {
          setRefetch((n) => n + 1)
          dialog.clear()
        }}
      />
    ))
  }

  const doDelete = async (agentID: string) => {
    const res = await sdk.fetch(`${sdk.url}/company-agent/${agentID}`, { method: "DELETE" })
    if (!res.ok) {
      toast.show({ variant: "error", message: "Failed to delete agent" })
    } else {
      setRefetch((n) => n + 1)
      if (selectedID() === agentID) {
        setSelectedID(undefined)
        setShowDetail(false)
      }
    }
    setConfirmDelete(undefined)
  }

  const doEditField = async (field: string, currentValue?: string) => {
    const agent = selected()
    if (!agent) return
    const value = await DialogPrompt.show(dialog, `Edit ${field}`, {
      value: currentValue ?? "",
      placeholder: `Enter ${field}...`,
    })
    if (value === null) return
    const body: Record<string, string> = { [field]: value }
    const res = await sdk.fetch(`${sdk.url}/company-agent/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      toast.show({ variant: "error", message: `Failed to update ${field}` })
    } else {
      toast.show({ variant: "info", message: `${field} updated` })
      setRefetch((n) => n + 1)
    }
  }

  // Right sidebar: contextual menu for the selected agent.
  createMemo(() => {
    const agent = selected()
    if (!agent) {
      rightSidebar.set(null)
      return
    }
    const status = (agentStatuses() ?? {})[agent.id] ?? "idle"
    rightSidebar.set(() => (
      <box height="100%" flexDirection="column" gap={1}>
        {/* Agent identity */}
        <box flexShrink={0} flexDirection="row" alignItems="center" gap={1}>
          <text fg={theme[status === "busy" ? "warning" : status === "paused" ? "textMuted" : "success"]}>
            {STATUS_ICON[status]}
          </text>
          <text fg={theme.text}>
            {agent.icon ? agent.icon + " " : ""}
            <b>{agent.name}</b>
          </text>
        </box>

        {/* Department / org layer */}
        <Show when={agent.department || agent.org_layer}>
          <box flexShrink={0} paddingLeft={2}>
            <text fg={theme.textMuted}>
              {[agent.department, agent.org_layer ? ORG_LAYER_LABELS[agent.org_layer] ?? agent.org_layer : ""].filter(Boolean).join(" · ")}
            </text>
          </box>
        </Show>

        <Show when={agent.description}>
          <box flexShrink={0} paddingLeft={2}>
            <text fg={theme.textMuted}>{agent.description}</text>
          </box>
        </Show>

        <Show when={agent.model}>
          <box flexShrink={0} paddingLeft={2}>
            <text fg={theme.textMuted}>model: {agent.model}</text>
          </box>
        </Show>

        {/* Separator */}
        <box flexShrink={0} paddingTop={1} paddingBottom={1}>
          <text fg={theme.border}>{"─".repeat(26)}</text>
        </box>

        {/* Actions */}
        <box flexShrink={0} flexDirection="column" gap={1} paddingLeft={1}>
          <box onMouseUp={() => goToAgent(agent.id)}>
            <text fg={theme.accent}>📋 查看详情</text>
          </box>
          <box
            onMouseUp={() =>
              route.navigate({ type: "session", sessionID: `new-${Date.now()}`, agentID: agent.id })
            }
          >
            <text fg={theme.success}>💬 开始对话</text>
          </box>
        </box>
      </box>
    ))
  })

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <Show
        when={showDetail() && selected()}
        fallback={
          <scrollbox flexGrow={1}>
            <box flexDirection="column" gap={1} paddingTop={1}>
              <box flexShrink={0} flexDirection="row" justifyContent="flex-end">
                <box onMouseUp={openCreate}>
                  <text fg={theme.accent}>+ new agent</text>
                </box>
              </box>

              <Show
                when={(agents() ?? []).length > 0}
                fallback={<text fg={theme.textMuted}>No agents yet — create one with "+ new agent".</text>}
              >
                {/* ── Hierarchical tree ───────────────────────── */}
                <For each={grouped().layers}>
                  {(layer) => {
                    const layerKey = `layer:${layer.layer}`
                    const layerCollapsed = isCollapsed(layerKey)
                    return (
                      <box flexDirection="column" gap={0}>
                        {/* Layer header */}
                        <box
                          flexShrink={0}
                          flexDirection="row"
                          alignItems="center"
                          gap={1}
                          onMouseUp={() => toggle(layerKey)}
                        >
                          <text fg={theme.textMuted}>{layerCollapsed ? "▶" : "▼"}</text>
                          <text fg={theme.text}>
                            {layer.icon} <b>{layer.label}</b>
                          </text>
                          <text fg={theme.textMuted}>({layer.totalCount})</text>
                        </box>

                        <Show when={!layerCollapsed}>
                          <For each={layer.departments}>
                            {(dept) => {
                              const deptKey = `dept:${layer.layer}:${dept.dept}`
                              const deptCollapsed = isCollapsed(deptKey)
                              return (
                                <box flexDirection="column" gap={0} paddingLeft={2}>
                                  {/* Department header */}
                                  <box
                                    flexShrink={0}
                                    flexDirection="row"
                                    alignItems="center"
                                    gap={1}
                                    onMouseUp={() => toggle(deptKey)}
                                  >
                                    <text fg={theme.textMuted}>{deptCollapsed ? "▶" : "▼"}</text>
                                    <text fg={theme.textMuted}>
                                      <b>{dept.dept}</b>
                                    </text>
                                    <text fg={theme.textMuted}>({dept.agents.length})</text>
                                  </box>

                                  <Show when={!deptCollapsed}>
                                    <For each={dept.agents}>
                                      {(a) => {
                                        const status = () => (agentStatuses() ?? {})[a.id] ?? "idle"
                                        const hover = () => hoveredID() === a.id
                                        const isSelected = () => a.id === selectedID()
                                        return (
                                          <box
                                            paddingLeft={3}
                                            flexShrink={0}
                                            onMouseUp={() => selectAgent(a.id)}
                                            onMouseOver={() => setHoveredID(a.id)}
                                            onMouseOut={() => setHoveredID(undefined)}
                                            backgroundColor={hover() ? theme.backgroundElement : undefined}
                                          >
                                            <text fg={isSelected() ? theme.accent : theme.text}>
                                              {STATUS_ICON[status()]}{" "}
                                              {a.icon ? a.icon + " " : ""}
                                              {a.name}
                                            </text>
                                          </box>
                                        )
                                      }}
                                    </For>
                                  </Show>
                                </box>
                              )
                            }}
                          </For>
                        </Show>
                      </box>
                    )
                  }}
                </For>

                {/* ── Unclassified agents ──────────────────────── */}
                <Show when={grouped().unclassified.length > 0}>
                  <box flexShrink={0} paddingTop={1} paddingBottom={1}>
                    <text fg={theme.border}>{"─".repeat(30)}</text>
                  </box>
                  <box flexShrink={0} flexDirection="column" gap={0}>
                    <text fg={theme.textMuted}>未分类</text>
                    <For each={grouped().unclassified}>
                      {(a) => {
                        const status = () => (agentStatuses() ?? {})[a.id] ?? "idle"
                        const hover = () => hoveredID() === a.id
                        const isSelected = () => a.id === selectedID()
                        return (
                          <box
                            paddingLeft={2}
                            flexShrink={0}
                            onMouseUp={() => selectAgent(a.id)}
                            onMouseOver={() => setHoveredID(a.id)}
                            onMouseOut={() => setHoveredID(undefined)}
                            backgroundColor={hover() ? theme.backgroundElement : undefined}
                          >
                            <text fg={isSelected() ? theme.accent : theme.text}>
                              {STATUS_ICON[status()]}{" "}
                              {a.icon ? a.icon + " " : ""}
                              {a.name}
                            </text>
                          </box>
                        )
                      }}
                    </For>
                  </box>
                </Show>
              </Show>
            </box>
          </scrollbox>
        }
      >
        {(agent) => (
          <scrollbox flexGrow={1}>
            <box flexDirection="column" gap={1} paddingTop={1}>
              {/* Back button */}
              <box flexShrink={0} flexDirection="row" alignItems="center" gap={1}>
                <box onMouseUp={goToList}>
                  <text fg={theme.accent}>← list</text>
                </box>
                <text fg={theme.text}>
                  {(agentStatuses() ?? {})[agent().id] === "busy" ? STATUS_ICON.busy : (agentStatuses() ?? {})[agent().id] === "paused" ? STATUS_ICON.paused : STATUS_ICON.idle}{" "}
                  {agent().icon ? agent().icon + " " : ""}
                  <b>{agent().name}</b>
                </text>
                <Show when={agent().model}>
                  <text fg={theme.textMuted}>· {agent().model}</text>
                </Show>
              </box>

              {/* Org info */}
              <Show when={agent().org_layer || agent().department}>
                <box flexShrink={0} paddingLeft={2} flexDirection="row" gap={2}>
                  <Show when={agent().org_layer}>
                    <text fg={theme.textMuted}>
                      layer: {ORG_LAYER_LABELS[agent().org_layer!] ?? agent().org_layer}
                    </text>
                  </Show>
                  <Show when={agent().department}>
                    <text fg={theme.textMuted}>dept: {agent().department}</text>
                  </Show>
                </box>
              </Show>

              <Show when={agent().description}>
                <box flexShrink={0} paddingLeft={2}>
                  <text fg={theme.textMuted}>{agent().description}</text>
                </box>
              </Show>
              <Show when={agent().system_prompt}>
                <box flexShrink={0} paddingLeft={2}>
                  <text fg={theme.textMuted}>{agent().system_prompt}</text>
                </box>
              </Show>

              {/* Quick actions */}
              <box flexShrink={0} paddingLeft={2} flexDirection="row" gap={2}>
                <box onMouseUp={() => doEditField("name", agent().name)}>
                  <text fg={theme.accent}>[e] edit name</text>
                </box>
                <box onMouseUp={() => doEditField("description", agent().description)}>
                  <text fg={theme.accent}>edit desc</text>
                </box>
                <box onMouseUp={() => doEditField("system_prompt", agent().system_prompt)}>
                  <text fg={theme.accent}>edit prompt</text>
                </box>
                <box onMouseUp={() => doEditField("model", agent().model)}>
                  <text fg={theme.accent}>edit model</text>
                </box>
              </box>

              {/* Quick session/thread actions */}
              <box flexShrink={0} paddingLeft={2} flexDirection="row" gap={2}>
                <box
                  onMouseUp={() =>
                    route.navigate({ type: "session", sessionID: `new-${Date.now()}`, agentID: agent().id })
                  }
                >
                  <text fg={theme.success}>Start Session</text>
                </box>
                <box onMouseUp={() => setEditing((e) => !e)}>
                  <text fg={theme.accent}>View Threads</text>
                </box>
              </box>

              {/* Threads section */}
              <Show when={editing()}>
                <box flexShrink={0} paddingLeft={2} flexDirection="column" gap={0} paddingTop={1}>
                  <text fg={theme.text}>
                    <b>Active Threads</b>
                  </text>
                  <Show
                    when={(agentThreads() ?? []).length > 0}
                    fallback={<text fg={theme.textMuted}>No active threads.</text>}
                  >
                    <For each={agentThreads() ?? []}>
                      {(t) => (
                        <box flexShrink={0} flexDirection="row" gap={2} paddingTop={0}>
                          <text fg={theme.textMuted}>{t.kind}</text>
                          <text fg={theme.textMuted}>{t.status}</text>
                          <text fg={theme.textMuted}>
                            {formatTokens(t.spentTokens)}
                            {t.budgetTokens ? `/${formatTokens(t.budgetTokens)}` : ""} tk
                          </text>
                          <Show when={t.description}>
                            <text fg={theme.textMuted}>{t.description}</text>
                          </Show>
                        </box>
                      )}
                    </For>
                  </Show>
                </box>
              </Show>

              {/* Delete */}
              <box flexShrink={0} paddingLeft={2} flexDirection="row" gap={2} paddingTop={1}>
                <box
                  onMouseUp={() => {
                    const aid = agent().id
                    if (confirmDelete() === aid) {
                      void doDelete(aid)
                    } else {
                      setConfirmDelete(aid)
                    }
                  }}
                >
                  <text fg={confirmDelete() === agent().id ? theme.error : theme.textMuted}>
                    {confirmDelete() === agent().id
                      ? `Press ${keybind.print("session_delete")} again to confirm`
                      : "delete agent"}
                  </text>
                </box>
              </box>
            </box>
          </scrollbox>
        )}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: "agent-management",
      render: (input) => <AgentManagementView params={input.params} />,
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
