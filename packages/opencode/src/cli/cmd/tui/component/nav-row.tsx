import { createSignal, Show, type JSX } from "solid-js"
import { useTheme } from "../context/theme"
import { SplitBorder } from "./border"

export interface NavRowProps {
  /** Whether this row is the active/current navigation item. */
  active?: boolean
  /** Whether to draw a left accent border (used for active state). */
  accent?: boolean
  /** Click handler. When present the row becomes hover-aware. */
  onSelect?: () => void
  /** Optional hint/prefix element rendered before the label (e.g. · ◈ ▾). */
  hint?: JSX.Element
  /** Main label content. */
  children: JSX.Element
}

/**
 * Single navigation row with hover feedback and optional active accent.
 * Used by LeftNav, Home recent-sessions, and Group Session member list.
 *
 * Mirrors the hover pattern from session/index.tsx BlockTool:
 *   backgroundColor = hover ? backgroundElement : backgroundPanel
 */
export function NavRow(props: NavRowProps) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)

  const bg = () => {
    if (props.active) return theme.backgroundElement
    if (hover()) return theme.backgroundElement
    return theme.backgroundPanel
  }

  return (
    <box
      onMouseOver={() => props.onSelect && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={props.onSelect}
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      backgroundColor={bg()}
      border={props.accent ? ["left"] : undefined}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={props.accent ? theme.accent : undefined}
    >
      {props.hint && <text fg={theme.textMuted}>{props.hint}{" "}</text>}
      <box flexGrow={1} flexShrink={1} flexDirection="row" alignItems="center">
        {props.children}
      </box>
    </box>
  )
}
