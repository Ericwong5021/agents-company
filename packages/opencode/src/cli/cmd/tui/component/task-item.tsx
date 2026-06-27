import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import "opentui-spinner/solid"

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export interface TaskItemProps {
  id: string
  status: string
  summary: string
  owner?: string
  depth: number
  sessionID?: string
  eventSummary?: string
}

export function TaskItem(props: TaskItemProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const running = () => props.status === "in_progress"
  const glyph =
    props.status === "done"
      ? "✓"
      : props.status === "blocked"
        ? "⏸"
        : props.status === "abandoned"
          ? "✗"
          : " "
  const fg = () => (running() ? theme.warning : theme.textMuted)
  const indent = "  ".repeat(props.depth)
  const canAbandon = () => props.sessionID && (props.status === "open" || props.status === "in_progress" || props.status === "blocked")

  function handleAbandon() {
    if (!props.sessionID || !canAbandon()) return
    DialogConfirm.show(
      dialog,
      "Abandon Task",
      `Abandon ${props.id}: ${props.summary}?`,
      "Abandon",
    ).then((confirmed) => {
      if (!confirmed || !props.sessionID) return
      sdk
        .fetch(`${sdk.url}/session/${props.sessionID}/task/${props.id}/abandon`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        .then((res) => {
          if (!res.ok) toast.show({ variant: "error", message: "Failed to abandon task" })
        })
        .catch(() => toast.show({ variant: "error", message: "Failed to abandon task" }))
    })
  }

  return (
    <box flexDirection="row" gap={0}>
      <text flexShrink={0} style={{ fg: fg() }}>
        {indent}
      </text>
      <Show
        when={running()}
        fallback={
          <text
            flexShrink={0}
            style={{ fg: fg() }}
            onMouseUp={() => handleAbandon()}
          >
            [{glyph}]{" "}
          </text>
        }
      >
        <box flexShrink={0} flexDirection="row" gap={0}>
          <text style={{ fg: theme.warning }}>[</text>
          <Show
            when={kv.get("animations_enabled", true)}
            fallback={<text style={{ fg: theme.warning }}>•</text>}
          >
            <spinner frames={spinnerFrames} interval={80} color={theme.warning} />
          </Show>
          <text style={{ fg: theme.warning }}>]{" "}</text>
        </box>
      </Show>
      <text flexGrow={1} wrapMode="word" style={{ fg: fg() }}>
        <span style={{ fg: theme.textMuted }}>{props.id}</span> {props.summary}
        <Show when={props.status === "done" && props.eventSummary}>
          <span style={{ fg: theme.textMuted }}> — {props.eventSummary}</span>
        </Show>
      </text>
    </box>
  )
}
