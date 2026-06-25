import { createSignal, Show, type JSX } from "solid-js"
import { useTheme } from "../context/theme"

export interface CardProps {
  /** Optional click handler. When present, the card becomes hover-aware. */
  onSelect?: () => void
  /** Optional title element rendered at the top of the card. */
  title?: JSX.Element
  /** When true, hides inner padding (for tight card stacks). */
  flush?: boolean
  /** When true, draws a top border separator. */
  separator?: boolean
  /** Card body. */
  children: JSX.Element
}

/**
 * Generic card container for sidebar / right-rail sections.
 * Provides consistent padding, optional hover feedback, and an optional
 * title row. Sidebar plugins wrap their top-level output in <Card>
 * so the right rail has a uniform card look (no more bare text).
 */
export function Card(props: CardProps) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const interactive = () => props.onSelect !== undefined
  const p = () => (props.flush ? 0 : 1)

  return (
    <box
      onMouseOver={() => interactive() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={props.onSelect}
      flexShrink={0}
      backgroundColor={
        hover() && interactive() ? theme.backgroundElement : theme.backgroundPanel
      }
      paddingTop={p()}
      paddingBottom={p()}
      paddingLeft={props.flush ? 0 : 1}
      paddingRight={props.flush ? 0 : 1}
      border={props.separator ? ["top"] : undefined}
      borderColor={props.separator ? theme.border : undefined}
    >
      <Show when={props.title}>
        <box flexShrink={0} paddingBottom={props.flush ? 0 : 1}>
          {props.title}
        </box>
      </Show>
      {props.children}
    </box>
  )
}
