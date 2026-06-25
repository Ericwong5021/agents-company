import { createEffect, createSignal, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { Logo } from "@tui/component/logo"
import { Spinner } from "@tui/component/spinner"
import { StarryBackground } from "@tui/component/starry-background"
import { TextAttributes } from "@opentui/core"

interface StepWelcomeProps {
  onComplete: () => void
}

interface WelcomeError {
  type: "preload" | "timeout"
  message: string
  retryable: boolean
}

export function StepWelcome(props: StepWelcomeProps) {
  const { theme } = useTheme()
  const [ready, setReady] = createSignal(false)
  const [minTimePassed, setMinTimePassed] = createSignal(false)
  const [error, setError] = createSignal<WelcomeError | null>(null)
  const [progress, setProgress] = createSignal(0)

  onMount(() => {
    runPreload()
  })

  async function runPreload() {
    setError(null)
    setProgress(0)

    try {
      // Simulate preloading with progress
      const steps = [
        { label: "Initializing database...", duration: 400 },
        { label: "Loading configuration...", duration: 300 },
        { label: "Preparing workspace...", duration: 400 },
        { label: "Setting up environment...", duration: 400 },
      ]

      for (let i = 0; i < steps.length; i++) {
        setProgress(((i + 1) / steps.length) * 100)
        await new Promise((resolve) => setTimeout(resolve, steps[i].duration))
      }

      setReady(true)

      // Minimum display time so the welcome screen doesn't flash
      await new Promise((resolve) => setTimeout(resolve, 1000))
      setMinTimePassed(true)
    } catch (err) {
      setError({
        type: "preload",
        message: `Preload failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        retryable: true,
      })
    }
  }

  function handleRetry() {
    setReady(false)
    setMinTimePassed(false)
    setProgress(0)
    runPreload()
  }

  // Auto-advance when both conditions are met
  createEffect(() => {
    if (ready() && minTimePassed() && !error()) {
      setTimeout(() => props.onComplete(), 500)
    }
  })

  return (
    <box position="relative" width="100%" height="100%">
      <StarryBackground />
      {/* Centered logo */}
      <box
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        justifyContent="center"
        alignItems="center"
        flexDirection="column"
      >
        <Logo idle sweep />
        <box paddingTop={2}>
          <Show
            when={ready()}
            fallback={
              <Show
                when={!error()}
                fallback={
                  <box flexDirection="column" alignItems="center" gap={2}>
                    <text fg={theme.error} attributes={TextAttributes.BOLD}>
                      ⚠ Initialization Failed
                    </text>
                    <text fg={theme.textMuted}>
                      {error()!.message}
                    </text>
                    <box
                      backgroundColor={theme.primary}
                      paddingLeft={3}
                      paddingRight={3}
                      paddingTop={1}
                      paddingBottom={1}
                      onMouseUp={handleRetry}
                    >
                      <text fg={theme.background}>Retry ↻</text>
                    </box>
                  </box>
                }
              >
                <box flexDirection="column" alignItems="center" gap={1}>
                  <text fg={theme.textMuted}>Initializing workspace...</text>
                  <box width={30} backgroundColor={theme.backgroundElement}>
                    <box
                      width={Math.max(1, Math.floor(30 * (progress() / 100)))}
                      backgroundColor={theme.primary}
                    >
                      <text fg={theme.primary}> </text>
                    </box>
                  </box>
                  <text fg={theme.textMuted}>{Math.round(progress())}%</text>
                </box>
              </Show>
            }
          >
            <text fg={theme.textMuted}>Welcome to Agent Company</text>
          </Show>
        </box>
      </box>
      {/* Bottom-right loading indicator */}
      <box position="absolute" bottom={1} right={2}>
        <Show when={!ready() && !error()}>
          <Spinner color={theme.textMuted}>Loading...</Spinner>
        </Show>
      </box>
    </box>
  )
}
