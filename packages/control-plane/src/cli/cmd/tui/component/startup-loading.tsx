import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { Spinner } from "./spinner"
import { isPlainTerminal } from "../util/terminal"
import { useLanguage } from "../context/language"

export function StartupLoading(props: { ready: () => boolean }) {
  const theme = useTheme().theme
  const t = useLanguage().t
  const plainTerminal = isPlainTerminal()
  const [show, setShow] = createSignal(false)
  const [elapsed, setElapsed] = createSignal(0)
  const text = createMemo(() => (props.ready() ? t("tui.startup.finishing") : t("tui.startup.loading_plugins")))
  const elapsedText = createMemo(() => t("tui.startup.elapsed", { seconds: elapsed() }))
  let wait: NodeJS.Timeout | undefined
  let hold: NodeJS.Timeout | undefined
  let ticker: NodeJS.Timeout | undefined
  let stamp = 0

  function stopTicker() {
    if (!ticker) return
    clearInterval(ticker)
    ticker = undefined
  }

  createEffect(() => {
    if (props.ready()) {
      stopTicker()
      if (wait) {
        clearTimeout(wait)
        wait = undefined
      }
      if (!show()) return
      if (hold) return

      const left = 3000 - (Date.now() - stamp)
      if (left <= 0) {
        setShow(false)
        return
      }

      hold = setTimeout(() => {
        hold = undefined
        setShow(false)
      }, left).unref()
      return
    }

    if (hold) {
      clearTimeout(hold)
      hold = undefined
    }
    if (show()) return
    if (wait) return

    wait = setTimeout(() => {
      wait = undefined
      stamp = Date.now()
      setElapsed(0)
      stopTicker()
      ticker = setInterval(() => {
        setElapsed(Math.max(1, Math.floor((Date.now() - stamp) / 1000)))
      }, 1000).unref()
      setShow(true)
    }, 500).unref()
  })

  onCleanup(() => {
    if (wait) clearTimeout(wait)
    if (hold) clearTimeout(hold)
    stopTicker()
  })

  return (
    <Show when={show()}>
      <box position="absolute" zIndex={5000} left={0} right={0} bottom={1} justifyContent="center" alignItems="center">
        <box
          backgroundColor={plainTerminal ? undefined : theme.backgroundPanel}
          paddingLeft={1}
          paddingRight={1}
          gap={1}
        >
          <Show when={plainTerminal} fallback={<Spinner color={theme.textMuted}>{text()}</Spinner>}>
            <text fg={theme.textMuted}>{text()}</text>
          </Show>
          <Show when={elapsed() >= 3}>
            <text fg={theme.textMuted}>{elapsedText()}</text>
          </Show>
          <Show when={elapsed() >= 10}>
            <text fg={theme.warning}>{t("tui.startup.slow_hint")}</text>
          </Show>
        </box>
      </box>
    </Show>
  )
}
