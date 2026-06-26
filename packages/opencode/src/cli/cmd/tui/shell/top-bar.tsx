import { createMemo, For, Show } from "solid-js"
import { useRoute, type Route } from "../context/route"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useKeybind } from "../context/keybind"
import { useLanguage } from "../context/language"
import { useTerminalDimensions } from "@opentui/solid"
import { Locale } from "@/util"
import { Session as SessionApi } from "@/session"

const NAV_ROUTE_LABEL: Record<string, string> = {
  "org-chart": "tui.shell.route.org-chart",
  "project-management": "tui.shell.route.project-management",
  "agent-management": "tui.shell.route.agent-management",
  settings: "tui.shell.route.settings",
}

interface BreadcrumbItem {
  route: Route
  label: string
}

// Build a short display label for a single route node.
function routeLabel(r: Route, t: (key: string) => string, sync: ReturnType<typeof useSync>): string {
  switch (r.type) {
    case "home":
      return t("tui.shell.route.home")
    case "session": {
      const session = sync.session.get(r.sessionID)
      const title = session?.title
      const shown = title && !SessionApi.isDefaultTitle(title) ? Locale.truncate(title, 30) : r.sessionID.slice(0, 8)
      return shown
    }
    case "group-session":
      return `${t("tui.shell.route.group-session")} · ${r.groupSessionID.slice(0, 8)}`
    case "plugin": {
      const labelKey = NAV_ROUTE_LABEL[r.id]
      if (labelKey) return t(labelKey)
      return `${t("tui.shell.route.plugin")}: ${r.id}`
    }
  }
}

// Derive the parent route for tree-based navigation.
function parentOf(r: Route, sync: ReturnType<typeof useSync>): Route | undefined {
  if (r.type === "session") {
    if (r.groupSessionID) return { type: "group-session", groupSessionID: r.groupSessionID }
    const parentID: string | undefined = sync.session.get(r.sessionID)?.parentID
    return parentID ? { type: "session", sessionID: parentID } : undefined
  }
  // group-session and plugin both parent to home
  if (r.type === "group-session" || r.type === "plugin") return { type: "home" }
  return undefined
}

// Build the full ancestry breadcrumb from Home down to the current route.
function buildBreadcrumb(
  r: Route,
  t: (key: string) => string,
  sync: ReturnType<typeof useSync>,
): BreadcrumbItem[] {
  if (r.type === "home") return [{ route: { type: "home" }, label: t("tui.shell.route.home") }]

  // Collect ancestors by walking up, then reverse.
  const chain: Route[] = [r]
  let parent = parentOf(r, sync)
  while (parent && parent.type !== "home") {
    chain.push(parent)
    parent = parentOf(parent, sync)
  }

  chain.reverse()
  const items: BreadcrumbItem[] = [{ route: { type: "home" }, label: t("tui.shell.route.home") }]
  for (const node of chain) {
    items.push({ route: node, label: routeLabel(node, t, sync) })
  }

  // For plugin routes with a sub-label (e.g. agent-management > agent detail),
  // add an additional breadcrumb level so the page doesn't render its own title bar.
  if (r.type === "plugin" && r.data?.subLabel) {
    const listRoute: Route = { type: "plugin", id: r.id }
    items[items.length - 1] = { route: listRoute, label: routeLabel(listRoute, t, sync) }
    items.push({ route: r, label: String(r.data.subLabel) })
  }

  return items
}

export function TopBar() {
  const route = useRoute()
  const sync = useSync()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const t = useLanguage().t
  const dimensions = useTerminalDimensions()

  const isHome = createMemo(() => route.data.type === "home")
  const showBreadcrumb = createMemo(() => !isHome() && dimensions().width >= 40)
  const breadcrumbs = createMemo(() => buildBreadcrumb(route.data, t, sync))

  // Navigate to a specific ancestor in the tree.
  const goTo = (target: Route) => {
    route.navigate(target)
  }

  return (
    <box
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      paddingLeft={1}
      paddingRight={1}
      height={1}
      backgroundColor={theme.backgroundPanel}
    >
      {/* Left: breadcrumb trail (tree-based ancestry). */}
      <box flexGrow={1} flexShrink={1} flexDirection="row" alignItems="center" overflow="hidden">
        <Show when={showBreadcrumb()}>
          <box flexDirection="row" alignItems="center" overflow="hidden">
            <For each={breadcrumbs()}>
              {(item, i) => (
                <>
                  <Show when={i() > 0}>
                    <text fg={theme.textMuted}>{" › "}</text>
                  </Show>
                  <box onMouseUp={() => goTo(item.route)}>
                    <text fg={i() === breadcrumbs().length - 1 ? theme.accent : theme.textMuted}>
                      {item.label}
                    </text>
                  </box>
                </>
              )}
            </For>
          </box>
        </Show>
      </box>

      {/* Right: keybind hint for parent navigation. */}
      <box flexShrink={0} flexDirection="row" alignItems="center" justifyContent="flex-end" width={showBreadcrumb() ? 18 : 0}>
        <Show when={showBreadcrumb()}>
          <text fg={theme.textMuted}>{keybind.print("session_parent")}</text>
        </Show>
      </box>
    </box>
  )
}
