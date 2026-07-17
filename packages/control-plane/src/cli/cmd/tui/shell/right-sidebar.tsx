import { Show } from "solid-js"
import { RGBA } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useRightSidebar } from "../context/right-sidebar"

// Renders the route-published right-sidebar content inside the standard
// 32-col panel frame. When narrow + force-shown, renders as an overlay with
// a dimmed backdrop (mirrors the old session sidebar overlay behavior).
//
// The footer (Control Plane version / getting-started) is owned by each route's
// published content — the session route's <Sidebar> renders its own
// sidebar_footer slot, and other routes render their own footers as needed.
export function RightSidebar(props: { overlay?: boolean; collapsed?: boolean; onToggle?: () => void }) {
  const { theme } = useTheme()
  const right = useRightSidebar()

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
          <text fg={theme.textMuted}>◀</text>
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
      <box flexShrink={0} flexDirection="row" justifyContent="flex-start" height={1}>
        <Show when={props.onToggle}>
          <box onMouseUp={props.onToggle}>
            <text fg={theme.textMuted}>▶</text>
          </box>
        </Show>
      </box>
      <Show when={right.content()} keyed>
        {(render) => <>{render()}</>}
      </Show>
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
        alignItems="flex-end"
        backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
      >
        {panel}
      </box>
    </Show>
  )
}
