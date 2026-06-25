import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@agents-company/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useLanguage } from "../../context/language"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { useSDK } from "../../context/sdk"

const id = "internal:org-disband"

function DisbandDialog() {
  const { theme } = useTheme()
  const t = useLanguage().t
  const dialog = useDialog()
  const toast = useToast()
  const sdk = useSDK()

  // Two steps: initial yes/no, then the red irreversible warning.
  const [stage, setStage] = createSignal<"confirm" | "warning">("confirm")
  const [busy, setBusy] = createSignal(false)

  const doDisband = async () => {
    if (busy()) return
    setBusy(true)
    const res = await sdk.fetch(`${sdk.url}/org/disband`, { method: "POST" }).catch(() => null)
    setBusy(false)
    if (!res || !res.ok) {
      toast.show({ variant: "error", message: t("tui.org.disband.failed") })
      return
    }
    toast.show({ variant: "success", message: t("tui.org.disband.done") })
    dialog.clear()
  }

  useKeyboard((evt) => {
    if (busy()) {
      if (evt.name !== "escape") {
        evt.preventDefault()
        evt.stopPropagation()
      }
      return
    }
    if (evt.name === "escape") {
      dialog.clear()
      return
    }
    if (stage() === "confirm") {
      if (evt.name === "y" || evt.name === "return") {
        evt.preventDefault()
        setStage("warning")
      }
      if (evt.name === "n") {
        evt.preventDefault()
        dialog.clear()
      }
      return
    }
    // warning stage — require explicit "y" to execute, never on bare return.
    if (evt.name === "y") {
      evt.preventDefault()
      void doDisband()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
      <Show when={stage() === "confirm"}>
        <box flexDirection="row" justifyContent="space-between">
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            {t("tui.org.disband.title")}
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            {t("tui.dialog.close_hint")}
          </text>
        </box>
        <text fg={theme.textMuted}>{t("tui.org.disband.confirm")}</text>
        <box flexDirection="row" gap={2} paddingTop={1}>
          <text fg={theme.error} onMouseUp={() => setStage("warning")}>
            {t("tui.org.disband.yes")}
          </text>
          <text fg={theme.text} onMouseUp={() => dialog.clear()}>
            {t("tui.org.disband.no")}
          </text>
        </box>
      </Show>

      <Show when={stage() === "warning"}>
        <box
          flexDirection="column"
          gap={1}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          border
          borderColor={theme.error}
        >
          <text attributes={TextAttributes.BOLD} fg={theme.error}>
            {t("tui.org.disband.warning.title")}
          </text>
          <text fg={theme.error}>{t("tui.org.disband.warning.body")}</text>
          <Show
            when={!busy()}
            fallback={<text fg={theme.textMuted}>{t("tui.org.disband.running")}</text>}
          >
            <box flexDirection="row" gap={2} paddingTop={1}>
              <text attributes={TextAttributes.BOLD} fg={theme.error} onMouseUp={() => void doDisband()}>
                {t("tui.org.disband.warning.confirm")}
              </text>
              <text fg={theme.text} onMouseUp={() => dialog.clear()}>
                {t("tui.org.disband.no")}
              </text>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  api.command.register(() => {
    const t = useLanguage().t
    return [
      {
        title: t("tui.org.disband.title"),
        value: "org.disband",
        category: "system",
        onSelect() {
          api.ui.dialog.replace(() => <DisbandDialog />)
        },
      },
    ]
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
