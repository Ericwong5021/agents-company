import { For, Show, type JSX } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { TextAttributes } from "@opentui/core"

interface OnboardingFrameProps {
  // 0-based index of the active step, used to render the progress dots.
  stepIndex: number
  stepCount: number
  title: string
  subtitle?: string
  // Small assistant-style speech line shown above the body, e.g. the helper
  // asking a question. Rendered with the assistant icon.
  speaker?: { name: string; icon: string }
  speech?: string
  children: JSX.Element
  // Optional footer (actions). Rendered below the body with a separator.
  footer?: JSX.Element
}

// Inner content for an onboarding step. This is rendered *inside* the shared
// dialog chrome (see ui/dialog.tsx → <Dialog>), the very same modal window the
// provider/model selector uses, so the whole flow keeps one consistent window
// form. It therefore only lays out content (no overlay/centering/panel of its
// own) and matches the dialog padding conventions used by DialogPrompt.
export function OnboardingFrame(props: OnboardingFrameProps) {
  const { theme } = useTheme()

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      {/* Header: title + step dots */}
      <box flexDirection="row" justifyContent="space-between" alignItems="center">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <box flexDirection="row" gap={1}>
          <For each={Array.from({ length: props.stepCount })}>
            {(_, i) => (
              <text fg={i() === props.stepIndex ? theme.primary : theme.border}>
                {i() === props.stepIndex ? "●" : "○"}
              </text>
            )}
          </For>
        </box>
      </box>

      <Show when={props.subtitle}>
        <text fg={theme.textMuted}>{props.subtitle}</text>
      </Show>

      {/* Assistant speech bubble */}
      <Show when={props.speech}>
        <box
          flexDirection="row"
          gap={1}
          backgroundColor={theme.backgroundElement}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
        >
          <text fg={theme.primary}>{props.speaker?.icon ?? "🌟"}</text>
          <box flexDirection="column" flexGrow={1}>
            <Show when={props.speaker}>
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                {props.speaker!.name}
              </text>
            </Show>
            <text fg={theme.text}>{props.speech}</text>
          </box>
        </box>
      </Show>

      {/* Body */}
      <box flexDirection="column" gap={1}>
        {props.children}
      </box>

      {/* Footer */}
      <Show when={props.footer}>
        <box border={["top"]} borderColor={theme.border} paddingTop={1}>
          {props.footer}
        </box>
      </Show>
    </box>
  )
}
