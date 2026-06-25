import type { TuiPlugin, TuiPluginModule } from "@mimo-ai/plugin/tui"
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

  const [agents] = createResource(refetch, async () => {
    const res = await sdk.fetch(`${sdk.url}/company-agent`)
    if (!res.ok) return [] as CompanyAgentInfo[]
    return (await res.json()) as CompanyAgentInfo[]
  })

  const selected = createMemo(() => {
    const id = selectedID()
    return (agents() ?? []).find((a) => a.id === id) ?? null
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

  // Right sidebar: agent quick-jump list.
  createMemo(() => {
    const list = agents() ?? []
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
              {(a) => (
                <box flexShrink={0} onMouseUp={() => setSelectedID(a.id)}>
                  <text fg={a.id === selectedID() ? theme.accent : theme.text}>
                    {a.icon ? a.icon + " " : ""}
                    {a.name}
                  </text>
                </box>
              )}
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
                {(a) => (
                  <box
                    border={["left"]}
                    borderColor={a.color ?? theme.border}
                    flexShrink={0}
                    onMouseUp={() => setSelectedID(a.id)}
                  >
                    <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
                      <text fg={theme.text}>
                        {a.icon ? a.icon + " " : ""}
                        <b>{a.name}</b>
                      </text>
                      <Show when={a.description}>
                        <text fg={theme.textMuted}>{a.description}</text>
                      </Show>
                    </box>
                  </box>
                )}
              </For>
              <Show when={(agents() ?? []).length === 0}>
                <text fg={theme.textMuted}>No agents yet — create one with “+ new agent”.</text>
              </Show>
            </box>
          </scrollbox>
        }
      >
        {(agent) => (
          <scrollbox flexGrow={1}>
            <box flexDirection="column" gap={1} paddingTop={1}>
              <box flexShrink={0} flexDirection="row" alignItems="center" gap={1}>
                <box onMouseUp={() => setSelectedID(undefined)}>
                  <text fg={theme.accent}>← list</text>
                </box>
                <text fg={theme.text}>
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
              <box flexShrink={0} paddingLeft={2} flexDirection="row" gap={2}>
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
