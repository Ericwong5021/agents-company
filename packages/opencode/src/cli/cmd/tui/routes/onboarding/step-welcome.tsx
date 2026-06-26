import { createSignal, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useLanguage } from "@tui/context/language"
import { useKeyboard } from "@opentui/solid"
import { Logo } from "@tui/component/logo"
import { Spinner } from "@tui/component/spinner"
import { TextAttributes } from "@opentui/core"

interface StepWelcomeProps {
  onComplete: () => void
}

// Welcome screen for the full onboarding flow.
// While showing, we warm the template library and company-agent store so
// later steps feel instant. The starry background is provided by the parent.
export function StepWelcome(props: StepWelcomeProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const t = useLanguage().t
  const [ready, setReady] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [hovered, setHovered] = createSignal<string | null>(null)

  useKeyboard((evt) => {
    if (evt.name === "return" && ready()) props.onComplete()
  })

  onMount(() => void runPreload())

  async function runPreload() {
    setError(null)
    setReady(false)

    const started = Date.now()
    await Promise.allSettled([
      sdk.fetch(`${sdk.url}/company-agent`),
      sdk.fetch(`${sdk.url}/company-agent/templates`),
    ]).catch(() => undefined)

    const elapsed = Date.now() - started
    if (elapsed < 1200) await new Promise((r) => setTimeout(r, 1200 - elapsed))
    setReady(true)

    if (process.env["ONBOARDING_DEV"]) {
      setTimeout(() => props.onComplete(), 300)
    }
  }

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

        {/* Entry buttons — shown after preloading */}
        <Show when={ready() && !error()}>
          <box flexDirection="column" gap={1} paddingTop={2} alignItems="center">
            {/* Primary: full onboarding */}
            <box
              backgroundColor={hovered() === "start" ? theme.primary : theme.backgroundPanel}
              border
              borderColor={hovered() === "start" ? theme.primary : theme.border}
              paddingLeft={4}
              paddingRight={4}
              paddingTop={1}
              paddingBottom={1}
              flexDirection="row"
              justifyContent="center"
              width={36}
              onMouseOver={() => setHovered("start")}
              onMouseOut={() => setHovered(null)}
              onMouseUp={() => props.onComplete()}
            >
              <text fg={hovered() === "start" ? theme.background : theme.text} attributes={TextAttributes.BOLD}>
                🚀 {t("onboarding.welcome.start")}
              </text>
            </box>
            <text fg={theme.textMuted}>{t("onboarding.welcome.start_desc")}</text>
          </box>
        </Show>
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
