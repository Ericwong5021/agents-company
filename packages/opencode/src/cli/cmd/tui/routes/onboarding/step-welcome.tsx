import { createEffect, createSignal, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useLanguage } from "@tui/context/language"
import { Logo } from "@tui/component/logo"
import { Spinner } from "@tui/component/spinner"
import { TextAttributes } from "@opentui/core"

interface StepWelcomeProps {
  onComplete: () => void
}

// Pure logo-and-background welcome screen. While it shows, we warm the things
// the rest of onboarding depends on — the agent template library and the
// company-agent store (which touches the DB and filesystem) — so later steps
// feel instant. The starry background is provided by the parent.
export function StepWelcome(props: StepWelcomeProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const t = useLanguage().t
  const [ready, setReady] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  onMount(() => void runPreload())

  async function runPreload() {
    setError(null)
    setReady(false)

    // Warm caches in parallel; ignore individual failures so a cold endpoint
    // doesn't block onboarding (the steps that need them re-fetch anyway).
    const started = Date.now()
    await Promise.allSettled([
      sdk.fetch(`${sdk.url}/company-agent`),
      sdk.fetch(`${sdk.url}/company-agent/templates`),
    ]).catch(() => undefined)

    // Keep the welcome on screen long enough to not flash.
    const elapsed = Date.now() - started
    if (elapsed < 1200) await new Promise((r) => setTimeout(r, 1200 - elapsed))
    setReady(true)
  }

  // Auto-advance once preloading is done.
  createEffect(() => {
    if (ready() && !error()) setTimeout(() => props.onComplete(), 600)
  })

  return (
    <box position="absolute" top={0} left={0} right={0} bottom={0}>
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
                  <text fg={theme.error} attributes={TextAttributes.BOLD}>
                    ⚠ {error()}
                  </text>
                }
              >
                <text fg={theme.textMuted}>{t("onboarding.welcome.initializing")}</text>
              </Show>
            }
          >
            <text fg={theme.textMuted}>{t("onboarding.welcome.ready")}</text>
          </Show>
        </box>
      </box>

      {/* Bottom-right loading indicator */}
      <box position="absolute" bottom={1} right={2}>
        <Show when={!ready() && !error()}>
          <Spinner color={theme.textMuted}>{t("onboarding.welcome.loading")}</Spinner>
        </Show>
      </box>
    </box>
  )
}
