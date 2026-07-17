import { batch, createMemo, createSignal, Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import { useLanguage } from "../context/language"
import { useCommandDialog, type CommandOption } from "../component/dialog-command"
import type { DialogContext } from "../ui/dialog"
import { useRightSidebar } from "../context/right-sidebar"
import { isPlainTerminal } from "../util/terminal"
import { TopBar } from "./top-bar"
import { LeftNav } from "./left-nav"
import { RightSidebar } from "./right-sidebar"

// Persistent shell: top bar + [left nav | center | right sidebar]. Both
// sidebars are individually collapsible to a thin 2-col strip with an expand
// icon. In narrow terminals (< WIDE_THRESHOLD) the sidebars render as overlays
// and the toggle shows/hides them completely.
const WIDE_THRESHOLD = 120
const LEFT_WIDTH = 32
const RIGHT_WIDTH = 32
const COLLAPSED_WIDTH = 2

export function Shell(props: { children: JSX.Element }) {
  const dimensions = useTerminalDimensions()
  const kv = useKV()
  const t = useLanguage().t
  const command = useCommandDialog()
  const right = useRightSidebar()
  const plainTerminal = isPlainTerminal()

  // Right sidebar keeps the existing "sidebar" kv key so <leader>b muscle
  // memory and any persisted preference survive.
  const [rightPref, setRightPref] = kv.signal<"auto" | "hide">("sidebar", "auto")
  const [rightOpen, setRightOpen] = createSignal(false)
  const [rightCollapsed, setRightCollapsed] = createSignal(false)
  // Left sidebar uses a new "left_sidebar" kv key.
  const [leftPref, setLeftPref] = kv.signal<"auto" | "hide">("left_sidebar", "auto")
  const [leftOpen, setLeftOpen] = createSignal(false)
  const [leftCollapsed, setLeftCollapsed] = createSignal(false)

  const wide = createMemo(() => dimensions().width > WIDE_THRESHOLD)

  const hasRightContent = createMemo(() => right.content() !== null)

  const leftVisible = createMemo(() => {
    if (plainTerminal) return false
    if (leftOpen()) return true
    if (leftPref() === "hide") return false
    return wide()
  })
  const rightVisible = createMemo(() => {
    if (plainTerminal) return false
    if (!hasRightContent()) return false
    if (rightOpen()) return true
    if (rightPref() === "hide") return false
    return wide()
  })

  // Publish visibility and effective width to routes (e.g. session computes
  // content width from it).
  createMemo(() => {
    right.setVisible(rightVisible())
    return rightVisible()
  })
  createMemo(() => {
    if (!rightVisible()) {
      right.setEffectiveWidth(0)
    } else if (wide() && rightCollapsed()) {
      right.setEffectiveWidth(COLLAPSED_WIDTH)
    } else {
      right.setEffectiveWidth(RIGHT_WIDTH)
    }
  })

  // In narrow terminals, sidebars render as overlays (no collapsed strip).
  const leftOverlay = createMemo(() => leftVisible() && !wide())
  const rightOverlay = createMemo(() => rightVisible() && !wide())

  // Toggle collapse/expand. In overlay mode, hides completely instead.
  const toggleRight: CommandOption["onSelect"] = (dialog: DialogContext) => {
    batch(() => {
      if (!wide()) {
        // Overlay mode: hide completely
        const isVisible = rightVisible()
        setRightPref(() => (isVisible ? "hide" : "auto"))
        setRightOpen(!isVisible)
      } else {
        // Inline mode: toggle collapsed strip
        setRightCollapsed((c) => !c)
      }
    })
    dialog.clear()
  }
  const toggleLeft: CommandOption["onSelect"] = (dialog: DialogContext) => {
    batch(() => {
      if (!wide()) {
        const isVisible = leftVisible()
        setLeftPref(() => (isVisible ? "hide" : "auto"))
        setLeftOpen(!isVisible)
      } else {
        setLeftCollapsed((c) => !c)
      }
    })
    dialog.clear()
  }

  // Toggle commands — registered from the shell so they own the local *Open
  // signals. <leader>b keeps sidebar_toggle (right); <leader>v is
  // left_sidebar_toggle (left).
  command.register(() => [
    {
      title: t(rightVisible() ? "tui.command.session.sidebar.hide" : "tui.command.session.sidebar.show"),
      value: "shell.sidebar.right.toggle",
      keybind: "sidebar_toggle",
      category: "session",
      onSelect: toggleRight,
    },
    {
      title: t(leftVisible() ? "Hide left navigation" : "Show left navigation"),
      value: "shell.sidebar.left.toggle",
      keybind: "left_sidebar_toggle",
      category: "session",
      onSelect: toggleLeft,
    },
  ])

  if (plainTerminal) {
    return <>{props.children}</>
  }

  return (
    <box flexDirection="row" flexGrow={1} width="100%" height="100%">
      <Show when={leftVisible()}>
        <LeftNav
          overlay={leftOverlay()}
          collapsed={wide() && leftCollapsed()}
          onToggle={() => {
            batch(() => {
              if (!wide()) {
                const isVisible = leftVisible()
                setLeftPref(() => (isVisible ? "hide" : "auto"))
                setLeftOpen(!isVisible)
              } else {
                setLeftCollapsed((c) => !c)
              }
            })
          }}
        />
      </Show>
      <box flexGrow={1} flexDirection="column" height="100%" position="relative">
        <TopBar />
        {props.children}
      </box>
      <Show when={rightVisible()}>
        <RightSidebar
          overlay={rightOverlay()}
          collapsed={wide() && rightCollapsed()}
          onToggle={() => {
            batch(() => {
              if (!wide()) {
                const isVisible = rightVisible()
                setRightPref(() => (isVisible ? "hide" : "auto"))
                setRightOpen(!isVisible)
              } else {
                setRightCollapsed((c) => !c)
              }
            })
          }}
        />
      </Show>
    </box>
  )
}

// Exported for routes that need to compute their content width from the
// shell's column layout. Reads the live dimensions + kv preferences.
export const SHELL_LEFT_WIDTH = LEFT_WIDTH
export const SHELL_RIGHT_WIDTH = RIGHT_WIDTH
export const SHELL_COLLAPSED_WIDTH = COLLAPSED_WIDTH
export const SHELL_WIDE_THRESHOLD = WIDE_THRESHOLD
