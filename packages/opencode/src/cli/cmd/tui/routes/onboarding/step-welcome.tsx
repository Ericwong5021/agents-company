import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useLanguage } from "@tui/context/language"
import { useKeyboard } from "@opentui/solid"
import { Logo } from "@tui/component/logo"
import { Spinner } from "@tui/component/spinner"
import { TextAttributes } from "@opentui/core"

interface StepWelcomeProps {
  onComplete: () => void
  onSkip: () => void
}

const PRELOAD_STEPS = [
  {
    label: "onboarding.welcome.step.agents",
    path: "/company-agent",
  },
  {
    label: "onboarding.welcome.step.templates",
    path: "/company-agent/templates",
  },
] as const

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
  const [activeStep, setActiveStep] = createSignal(0)
  const [elapsed, setElapsed] = createSignal(0)
  const [retryCount, setRetryCount] = createSignal(0)
  const activeLabel = createMemo(() => t(PRELOAD_STEPS[activeStep()]?.label ?? PRELOAD_STEPS[0].label))
  let runID = 0
  let started = Date.now()

  useKeyboard((evt) => {
    if (evt.name === "return" && ready()) {
      props.onComplete()
      return
    }
    if (evt.name === "return" && error()) {
      void runPreload()
      return
    }
    if (evt.name === "s" && (ready() || error())) props.onSkip()
    if (evt.name === "r" && error()) void runPreload()
  })

  onMount(() => void runPreload())

  createEffect(() => {
    if (ready()) return
    const timer = setInterval(() => {
      setElapsed(Math.max(1, Math.floor((Date.now() - started) / 1000)))
    }, 1000)
    onCleanup(() => clearInterval(timer))
  })

  async function preload(path: string) {
    const res = await sdk.fetch(`${sdk.url}${path}`).catch((err) => {
      return err instanceof Error ? err.message : String(err)
    })
    if (typeof res === "string") return res
    if (!res.ok) return `${res.status} ${res.statusText}`
    return undefined
  }

  async function runPreload() {
    const current = ++runID
    setError(null)
    setReady(false)
    setActiveStep(0)
    setElapsed(0)
    setRetryCount((count) => count + 1)
    started = Date.now()

    for (const [index, step] of PRELOAD_STEPS.entries()) {
      setActiveStep(index)
      const failure = await preload(step.path)
      if (current !== runID) return
      if (!failure) continue
      setError(t("onboarding.welcome.error_step", { step: t(step.label), error: failure }))
      return
    }

    const elapsed = Date.now() - started
    if (elapsed < 1200) await new Promise((r) => setTimeout(r, 1200 - elapsed))
    if (current !== runID) return
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
                    {t("onboarding.welcome.blocked")}
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
        <box paddingTop={1} flexDirection="column" alignItems="center" gap={1}>
          <Show when={!ready() && !error()}>
            <text fg={theme.textMuted}>
              {t("onboarding.welcome.status", {
                step: activeLabel(),
                current: activeStep() + 1,
                total: PRELOAD_STEPS.length,
                seconds: elapsed(),
              })}
            </text>
          </Show>
          <Show when={elapsed() >= 8 && !ready() && !error()}>
            <text fg={theme.warning}>{t("onboarding.welcome.slow_hint")}</text>
          </Show>
          <Show when={error()}>
            {(message) => (
              <box flexDirection="column" alignItems="center" gap={1}>
                <text fg={theme.error} attributes={TextAttributes.BOLD}>
                  {message()}
                </text>
                <box flexDirection="row" gap={2}>
                  <box
                    backgroundColor={hovered() === "retry" ? theme.primary : theme.backgroundPanel}
                    border
                    borderColor={hovered() === "retry" ? theme.primary : theme.border}
                    paddingLeft={3}
                    paddingRight={3}
                    onMouseOver={() => setHovered("retry")}
                    onMouseOut={() => setHovered(null)}
                    onMouseUp={() => void runPreload()}
                  >
                    <text fg={hovered() === "retry" ? theme.background : theme.text}>
                      {t("onboarding.welcome.retry")}
                    </text>
                  </box>
                  <box
                    backgroundColor={hovered() === "skip-error" ? theme.backgroundElement : undefined}
                    paddingLeft={2}
                    paddingRight={2}
                    onMouseOver={() => setHovered("skip-error")}
                    onMouseOut={() => setHovered(null)}
                    onMouseUp={props.onSkip}
                  >
                    <text fg={theme.textMuted}>{t("onboarding.welcome.skip")}</text>
                  </box>
                </box>
              </box>
            )}
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
                {t("onboarding.welcome.start")}
              </text>
            </box>
            <text fg={theme.textMuted}>{t("onboarding.welcome.start_desc")}</text>
            <box
              paddingTop={1}
              paddingLeft={2}
              paddingRight={2}
              backgroundColor={hovered() === "skip" ? theme.backgroundElement : undefined}
              onMouseOver={() => setHovered("skip")}
              onMouseOut={() => setHovered(null)}
              onMouseUp={props.onSkip}
            >
              <text fg={hovered() === "skip" ? theme.text : theme.textMuted}>{t("onboarding.welcome.skip")}</text>
            </box>
            <text fg={theme.textMuted}>{t("onboarding.welcome.skip_desc")}</text>
          </box>
        </Show>
      </box>

      {/* Bottom-right loading indicator */}
      <box position="absolute" bottom={1} right={2}>
        <Show when={!ready() && !error()}>
          <Spinner color={theme.textMuted}>
            {t("onboarding.welcome.loading_detail", {
              step: activeStep() + 1,
              total: PRELOAD_STEPS.length,
              attempt: retryCount(),
            })}
          </Spinner>
        </Show>
      </box>
    </box>
  )
}
