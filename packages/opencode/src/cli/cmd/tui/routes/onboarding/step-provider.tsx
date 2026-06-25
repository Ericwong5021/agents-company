import { createEffect, createSignal, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { DialogProvider } from "@tui/component/dialog-provider"
import { DialogModel } from "@tui/component/dialog-model"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { Spinner } from "@tui/component/spinner"
import { TextAttributes } from "@opentui/core"

interface StepProviderProps {
  key?: number
  onComplete: (data: { providerID: string; modelID: string }) => void
}

export function StepProvider(props: StepProviderProps) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()
  const sync = useSync()
  const [started, setStarted] = createSignal(false)
  const [waiting, setWaiting] = createSignal(false)
  const [dismissed, setDismissed] = createSignal(false)
  const [attemptCount, setAttemptCount] = createSignal(0)

  onMount(() => {
    // Small delay to let the UI settle before showing the dialog
    setTimeout(() => {
      setStarted(true)
      showProviderDialog()
    }, 300)
  })

  function showProviderDialog() {
    setAttemptCount((c) => c + 1)
    setDismissed(false)

    dialog.replace(
      () => <DialogProvider />,
      () => {
        // Dialog was dismissed (Esc) - check if a model was already selected
        const current = local.model.current()
        if (!current) {
          // User dismissed without selecting - mark as dismissed
          setDismissed(true)
        } else {
          checkCompletion()
        }
      },
    )
  }

  function checkCompletion() {
    const current = local.model.current()
    if (current && current.providerID && current.modelID) {
      setWaiting(true)
      // Brief pause to show the "Setting up..." state
      setTimeout(() => {
        props.onComplete({
          providerID: current.providerID,
          modelID: current.modelID,
        })
      }, 800)
    } else {
      // Invalid state - no model selected
      setDismissed(true)
    }
  }

  function handleRetry() {
    setDismissed(false)
    showProviderDialog()
  }

  // Watch for model selection changes
  createEffect(() => {
    const current = local.model.current()
    if (current && started() && !dismissed()) {
      setWaiting(true)
      setTimeout(() => {
        props.onComplete({
          providerID: current.providerID,
          modelID: current.modelID,
        })
      }, 800)
    }
  })

  return (
    <box
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      width="100%"
      height="100%"
      gap={2}
    >
      <Show when={waiting()}>
        <box flexDirection="column" alignItems="center" gap={1}>
          <Spinner color={theme.textMuted}>Setting up your model...</Spinner>
        </box>
      </Show>
      <Show when={dismissed()}>
        <box flexDirection="column" alignItems="center" gap={2}>
          <text fg={theme.error} attributes={TextAttributes.BOLD}>
            ⚠ Provider Setup Required
          </text>
          <text fg={theme.textMuted}>
            You need to connect a provider and select a model to continue.
          </text>
          <text fg={theme.textMuted}>
            Attempt {attemptCount()} - Please complete the setup.
          </text>
          <box
            backgroundColor={theme.primary}
            paddingLeft={3}
            paddingRight={3}
            paddingTop={1}
            paddingBottom={1}
            onMouseUp={handleRetry}
          >
            <text fg={theme.background}>Try Again ↻</text>
          </box>
        </box>
      </Show>
      <Show when={!started() && !waiting() && !dismissed()}>
        <box flexDirection="column" alignItems="center" gap={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Connect to AI
          </text>
          <text fg={theme.textMuted}>
            Choose a provider and model to power your agents
          </text>
        </box>
      </Show>
    </box>
  )
}
