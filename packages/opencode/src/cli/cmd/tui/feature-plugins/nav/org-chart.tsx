import type { TuiPlugin, TuiPluginModule } from "@agents-company/plugin/tui"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useLanguage } from "../../context/language"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useRightSidebar } from "../../context/right-sidebar"
import { useToast } from "@tui/ui/toast"
import { TextAttributes } from "@opentui/core"

// ---------------------------------------------------------------------------
// Plugin identity
// ---------------------------------------------------------------------------

const id = "internal:nav-org-chart"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CompanyAgentInfo {
  id: string
  name: string
  description?: string
  color?: string
  icon?: string
  org_layer?: string
  department?: string
  reports_to?: string
}

interface GroupSessionInfo {
  id: string
}

const BOARD_DEPT_NAME = "董事会圆桌"

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function OrgChartView() {
  const { theme } = useTheme()
  const t = useLanguage().t
  const sdk = useSDK()
  const route = useRoute()
  const rightSidebar = useRightSidebar()
  const toast = useToast()

  // Load all company agents from the server.
  const [agents] = createResource(async () => {
    const res = await sdk.fetch(`${sdk.url}/company-agent`)
    if (!res.ok) return [] as CompanyAgentInfo[]
    return (await res.json()) as CompanyAgentInfo[]
  })
  const [company] = createResource(async () => {
    const result = await sdk.client.company.current()
    const data = result.data
    if (data?.state !== "ready") return
    return data.company
  })

  // ── Derived data ──────────────────────────────────────────────────────────
  const ASSISTANT_ID = "assistant"
  const assistant = createMemo(() => agents()?.find((a) => a.id === ASSISTANT_ID) ?? null)
  const teamMembers = createMemo(() => agents()?.filter((a) => a.id !== ASSISTANT_ID) ?? [])
  const userName = () => "创始人"
  const companyName = createMemo(() => company()?.name ?? "")
  const assistantName = createMemo(() => assistant()?.name ?? "")

  // Show sidebar panel for the board department.
  const [showBoardMenu, setShowBoardMenu] = createSignal(false)

  // Right sidebar — shows board department menu with "start group chat" action.
  createMemo(() => {
    const members = teamMembers()
    const open = showBoardMenu()

    rightSidebar.set(() => (
      <box height="100%" flexDirection="column">
        <Show
          when={open}
          fallback={
            <box height="100%" flexDirection="column">
              <box flexShrink={0} paddingRight={1} paddingBottom={1}>
                <text fg={theme.textMuted}>
                  <b>{t("tui.shell.nav.org-chart")}</b>
                </text>
              </box>
              <scrollbox flexGrow={1}>
                <box flexShrink={0} paddingRight={1} paddingBottom={1} flexDirection="column">
                  <text fg={theme.text}>
                    📁 {BOARD_DEPT_NAME} · {members.length} 人
                  </text>
                </box>
              </scrollbox>
            </box>
          }
        >
          <>
            {/* Department header with back */}
            <box flexShrink={0} paddingRight={1} paddingBottom={1} flexDirection="column">
              <box onMouseUp={() => setShowBoardMenu(false)}>
                <text fg={theme.accent}>← {t("tui.shell.nav.org-chart")}</text>
              </box>
            </box>
            <box flexShrink={0} paddingRight={1} paddingBottom={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                📁 {BOARD_DEPT_NAME}
              </text>
            </box>

            {/* Start group chat button */}
            <box flexShrink={0} paddingRight={1} paddingBottom={1}>
              <box
                backgroundColor={theme.primary}
                paddingLeft={2}
                paddingRight={2}
                paddingTop={0}
                paddingBottom={0}
                onMouseUp={async () => {
                  if (members.length === 0) {
                    toast.show({ variant: "warning", message: "暂无团队成员" })
                    return
                  }
                  const agentIDs = members.map((a) => a.id)
                  const title = `${BOARD_DEPT_NAME} · ${companyName() || userName()}`
                  const res = await sdk.fetch(`${sdk.url}/group-session`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ title, agentIDs }),
                  })
                  if (!res.ok) {
                    toast.show({ variant: "error", message: "创建群聊失败" })
                    return
                  }
                  const info = (await res.json()) as GroupSessionInfo
                  route.navigate({ type: "group-session", groupSessionID: info.id })
                }}
              >
                <text fg={theme.background}>💬 发起群聊</text>
              </box>
            </box>

            {/* Divider */}
            <box width="100%" height={1}>
              <text fg={theme.border}>{'─'.repeat(40)}</text>
            </box>

            {/* Members list */}
            <scrollbox flexGrow={1}>
              <For each={members}>
                {(a) => (
                  <box flexShrink={0} paddingRight={1} paddingBottom={1} flexDirection="row" gap={1}>
                    <text>{layerBadge(a.org_layer)}</text>
                    <text fg={theme.text}>
                      {a.icon ?? "🤖"} {a.name}
                    </text>
                    <Show when={a.org_layer}>
                      <text fg={theme.textMuted}>({layerLabel(a.org_layer)})</text>
                    </Show>
                  </box>
                )}
              </For>
            </scrollbox>
          </>
        </Show>
      </box>
    ))
  })

  // Map org_layer to a visual badge.
  function layerBadge(layer?: string) {
    if (layer === "board") return "👑"
    if (layer === "department") return "⭐"
    if (layer === "execution") return "▸"
    return ""
  }

  // Map org_layer to a human-readable label.
  function layerLabel(layer?: string) {
    if (layer === "board") return "决策层"
    if (layer === "department") return "部门层"
    if (layer === "project") return "项目层"
    if (layer === "execution") return "执行层"
    return ""
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      {/* Page header */}
      <box flexShrink={0} paddingBottom={1}>
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
          {t("tui.shell.nav.org-chart")}
        </text>
        <Show when={companyName()}>
          <text fg={theme.textMuted}> · {companyName()}</text>
        </Show>
      </box>

      {/* Main body */}
      <scrollbox flexGrow={1}>
        <Show
          when={agents() !== undefined}
          fallback={
            <box flexDirection="column" alignItems="center" paddingTop={4}>
              <text fg={theme.textMuted}>加载中…</text>
            </box>
          }
        >
          <Show
            when={agents()!.length > 1}
            fallback={
              <box flexDirection="column" alignItems="center" paddingTop={4} gap={1}>
                <text fg={theme.textMuted}>暂无组织数据</text>
                <text fg={theme.textMuted}>{t("company.setup.required.body")}</text>
              </box>
            }
          >
            <box flexDirection="column" alignItems="center" width="100%" gap={0} paddingTop={1}>
              {/* ════════════════════════════════════════════ */}
              {/*  Level 1 — Chairman / Founder (human user)  */}
              {/* ════════════════════════════════════════════ */}
              <box
                border
                borderColor={theme.primary}
                paddingLeft={4}
                paddingRight={4}
                paddingTop={1}
                paddingBottom={1}
                flexDirection="column"
                alignItems="center"
              >
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  👤 {userName()}
                </text>
                <text fg={theme.textMuted}>董事长 / 创始人</text>
              </box>

              {/* Connector */}
              <text fg={theme.textMuted}>│</text>

              {/* ════════════════════════════════════════════ */}
              {/*  Level 2 — Assistant (company butler)       */}
              {/* ════════════════════════════════════════════ */}
              <Show when={assistant()}>
                {(a) => (
                  <>
                    <box
                      border
                      borderColor={a().color ?? theme.accent}
                      paddingLeft={4}
                      paddingRight={4}
                      paddingTop={1}
                      paddingBottom={1}
                      flexDirection="column"
                      alignItems="center"
                    >
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>
                        {a().icon ?? "🌟"} {a().name || assistantName()}
                      </text>
                      <text fg={theme.textMuted}>董事长助理</text>
                    </box>

                    {/* Connector to department */}
                    <Show when={teamMembers().length > 0}>
                      <text fg={theme.textMuted}>│</text>
                    </Show>
                  </>
                )}
              </Show>

              {/* ════════════════════════════════════════════ */}
              {/*  Level 3 — Board department                 */}
              {/* ════════════════════════════════════════════ */}
              <Show when={teamMembers().length > 0}>
                <box
                  border
                  borderColor={theme.warning ?? theme.accent}
                  paddingTop={1}
                  paddingBottom={1}
                  flexDirection="column"
                  alignItems="center"
                  minWidth={26}
                  onMouseUp={() => setShowBoardMenu(true)}
                >
                  {/* Department header */}
                  <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      📁 {BOARD_DEPT_NAME}
                    </text>
                  </box>

                  {/* Divider */}
                  <box width="100%" height={1}>
                    <text fg={theme.border}>{'─'.repeat(50)}</text>
                  </box>

                  {/* Agents inside the department */}
                  <For each={teamMembers()}>
                    {(a, i) => (
                      <box
                        flexShrink={0}
                        width="100%"
                        paddingLeft={2}
                        paddingRight={2}
                        paddingTop={0}
                        paddingBottom={0}
                        backgroundColor={i() % 2 === 1 ? theme.backgroundPanel : undefined}
                      >
                        <text fg={theme.text}>
                          {a.icon ?? "🤖"} {layerBadge(a.org_layer)} {a.name}
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              </Show>
            </box>
          </Show>
        </Show>
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
      name: "org-chart",
      render: (input) => <OrgChartView />,
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
