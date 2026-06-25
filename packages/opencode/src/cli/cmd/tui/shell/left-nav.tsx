import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { RGBA, TextAttributes } from "@opentui/core"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useLanguage } from "../context/language"
import { useSDK } from "../context/sdk"
import { Locale } from "@/util"
import { Session as SessionApi } from "@/session"
import { getScrollAcceleration } from "../util/scroll"
import { useTuiConfig } from "../context/tui-config"
import { NavRow } from "../component/nav-row"

interface GroupSessionSummary {
  id: string
  title: string
  time: { created: number; updated: number }
}

interface NavItem {
  kind: "header" | "nav" | "session" | "group"
  label: string
  active: boolean
  onSelect?: () => void
  hint?: string
}

// Left navigation hub: Home / Recent (sessions + group sessions) / Organization
// / Projects / Agents / Settings. "Recent" is expandable; the rest are direct
// navigations to plugin nav routes (or home).
export function LeftNav(props: { overlay?: boolean; collapsed?: boolean; onToggle?: () => void }) {
  const route = useRoute()
  const sync = useSync()
  const { theme } = useTheme()
  const t = useLanguage().t
  const sdk = useSDK()
  const tuiConfig = useTuiConfig()
  const [recentOpen, setRecentOpen] = createSignal(true)

  const [groupSessions] = createResource(async () => {
    const res = await sdk.fetch(`${sdk.url}/group-session`)
    if (!res.ok) return [] as GroupSessionSummary[]
    return (await res.json()) as GroupSessionSummary[]
  })

  const recentSessions = createMemo(() =>
    (sync.data.session ?? [])
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .slice(0, 8),
  )

  const navToPlugin = (id: string) => route.navigate({ type: "plugin", id })

  const isCurrentNav = (id: string) =>
    route.data.type === "plugin" && route.data.id === id

  const items = createMemo<NavItem[]>(() => {
    const out: NavItem[] = [
      {
        kind: "nav",
        label: t("tui.shell.nav.home"),
        active: route.data.type === "home",
        onSelect: () => route.navigate({ type: "home" }),
      },
      {
        kind: "header",
        label: t("tui.shell.nav.recent"),
        active: false,
        onSelect: () => setRecentOpen((x) => !x),
        hint: recentOpen() ? "▾" : "▸",
      },
    ]
    if (recentOpen()) {
      for (const g of groupSessions() ?? []) {
        out.push({
          kind: "group",
          label: g.title || g.id.slice(0, 8),
          active: route.data.type === "group-session" && route.data.groupSessionID === g.id,
          onSelect: () => route.navigate({ type: "group-session", groupSessionID: g.id }),
          hint: "◈",
        })
      }
      for (const s of recentSessions()) {
        const title = s.title && !SessionApi.isDefaultTitle(s.title) ? s.title : s.id.slice(0, 8)
        out.push({
          kind: "session",
          label: Locale.truncate(title, 22),
          active: route.data.type === "session" && route.data.sessionID === s.id,
          onSelect: () => route.navigate({ type: "session", sessionID: s.id }),
        })
      }
    }
    out.push(
      {
        kind: "nav",
        label: t("tui.shell.nav.org-chart"),
        active: isCurrentNav("org-chart"),
        onSelect: () => navToPlugin("org-chart"),
      },
      {
        kind: "nav",
        label: t("tui.shell.nav.projects"),
        active: isCurrentNav("project-management"),
        onSelect: () => navToPlugin("project-management"),
      },
      {
        kind: "nav",
        label: t("tui.shell.nav.agents"),
        active: isCurrentNav("agent-management"),
        onSelect: () => navToPlugin("agent-management"),
      },
      {
        kind: "nav",
        label: t("tui.shell.nav.settings"),
        active: isCurrentNav("settings"),
        onSelect: () => navToPlugin("settings"),
      },
    )
    return out
  })

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  // Collapsed: thin strip with expand icon
  const collapsedPanel = (
    <box
      backgroundColor={theme.backgroundPanel}
      width={2}
      height="100%"
      alignItems="center"
      justifyContent="center"
      position={props.overlay ? "absolute" : "relative"}
    >
      <Show when={props.onToggle}>
        <box onMouseUp={props.onToggle}>
          <text fg={theme.textMuted}>▶</text>
        </box>
      </Show>
    </box>
  )

  // Expanded: full sidebar with collapse icon
  const expandedPanel = (
    <box
      backgroundColor={theme.backgroundPanel}
      width={32}
      height="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      position={props.overlay ? "absolute" : "relative"}
    >
      <box flexShrink={0} flexDirection="row" justifyContent="flex-end" height={1}>
        <Show when={props.onToggle}>
          <box onMouseUp={props.onToggle}>
            <text fg={theme.textMuted}>◀</text>
          </box>
        </Show>
      </box>
      <scrollbox
        flexGrow={1}
        scrollAcceleration={scrollAcceleration()}
        verticalScrollbarOptions={{
          trackOptions: { backgroundColor: theme.background, foregroundColor: theme.borderActive },
        }}
      >
        <box flexShrink={0} gap={1} paddingRight={1}>
          <For each={items()}>
            {(item) => (
              <Show
                when={item.kind === "header"}
                fallback={
                  <NavRow
                    active={item.active}
                    accent={item.active}
                    onSelect={item.onSelect}
                    hint={
                      <>
                        <Show when={item.hint}>
                          <span style={{ fg: theme.textMuted }}>{item.hint} </span>
                        </Show>
                        <Show when={item.kind === "session"}>
                          <span style={{ fg: theme.textMuted }}>· </span>
                        </Show>
                      </>
                    }
                  >
                    <text
                      fg={item.active ? theme.accent : theme.text}
                      attributes={item.active ? TextAttributes.BOLD : undefined}
                    >
                      {item.label}
                    </text>
                  </NavRow>
                }
              >
                <box onMouseUp={item.onSelect} flexShrink={0} marginTop={1}>
                  <text fg={theme.textMuted}>
                    {item.hint} <b>{item.label}</b>
                  </text>
                </box>
              </Show>
            )}
          </For>
        </box>
      </scrollbox>
    </box>
  )

  const panel = props.collapsed ? collapsedPanel : expandedPanel

  return (
    <Show when={props.overlay} fallback={panel}>
      <box
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        alignItems="flex-start"
        backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
      >
        {panel}
      </box>
    </Show>
  )
}
