import type { TuiPlugin, TuiPluginModule } from "@agents-company/plugin/tui"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
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

type AgentStatus = "idle" | "busy" | "focused"

const STATUS_ICON: Record<AgentStatus, string> = {
  idle: "○",
  busy: "◐",
  focused: "◉",
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
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
      if (selectedID() === agentID) setSelectedID(undefined)
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

  // Right sidebar: agent quick-jump list with status.
  createMemo(() => {
    const list = agents() ?? []
    const statuses = agentStatuses() ?? {}
    rightSidebar.set(() => (
      <box height="100%" flexDirection="column">
        <box flexShrink={0} paddingRight={1} paddingBottom={1}>
          <text fg={theme.textMuted}>
            <b>{t("tui.shell.right.agents")}</b>
          </text>
        </box>
        <scrollbox flexGrow={1}>
          <box flexShrink={0} gap={0} paddingRight={1}>
            <For each={list}>
              {(a) => {
                const status = () => statuses[a.id] ?? "idle"
                return (
                  <box flexShrink={0} onMouseUp={() => setSelectedID(a.id)}>
                    <text fg={a.id === selectedID() ? theme.accent : theme.text}>
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
          <b>{t("tui.shell.route.agent-management")}</b>
        </text>
        <box flexGrow={1} />
        <box onMouseUp={openCreate}>
          <text fg={theme.accent}>+ new agent</text>
        </box>
      </box>

      <Show
        when={selected()}
        fallback={
          <scrollbox flexGrow={1}>
            <box flexDirection="column" gap={1} paddingTop={1}>
              <For each={agents() ?? []}>
                {(a) => {
                  const status = () => (agentStatuses() ?? {})[a.id] ?? "idle"
                  return (
                    <box
                      border={["left"]}
                      borderColor={a.color ?? theme.border}
                      flexShrink={0}
                      onMouseUp={() => setSelectedID(a.id)}
                    >
                      <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
                        <text fg={theme.text}>
                          {STATUS_ICON[status()]}{" "}
                          {a.icon ? a.icon + " " : ""}
                          <b>{a.name}</b>
                        </text>
                        <Show when={a.description}>
                          <text fg={theme.textMuted}>{a.description}</text>
                        </Show>
                      </box>
                    </box>
                  )
                }}
              </For>
              <Show when={(agents() ?? []).length === 0}>
                <text fg={theme.textMuted}>No agents yet — create one with "+ new agent".</text>
              </Show>
            </box>
          </scrollbox>
        }
      >
        {(agent) => (
          <scrollbox flexGrow={1}>
            <box flexDirection="column" gap={1} paddingTop={1}>
              {/* Header row */}
              <box flexShrink={0} flexDirection="row" alignItems="center" gap={1}>
                <box onMouseUp={() => setSelectedID(undefined)}>
                  <text fg={theme.accent}>← list</text>
                </box>
                <text fg={theme.text}>
                  {(agentStatuses() ?? {})[agent().id] === "focused" ? STATUS_ICON.focused : (agentStatuses() ?? {})[agent().id] === "busy" ? STATUS_ICON.busy : STATUS_ICON.idle}{" "}
                  {agent().icon ? agent().icon + " " : ""}
                  <b>{agent().name}</b>
                </text>
                <Show when={agent().model}>
                  <text fg={theme.textMuted}>· {agent().model}</text>
                </Show>
              </box>

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
