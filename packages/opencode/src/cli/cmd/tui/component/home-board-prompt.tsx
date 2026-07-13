import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { useLanguage } from "../context/language"
import { useKeybind } from "../context/keybind"
import { useCommandDialog } from "../component/dialog-command"
import { Autocomplete, type AutocompleteRef } from "../component/prompt/autocomplete"
import { useExit } from "../context/exit"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { Spinner } from "../component/spinner"
import { useLocal } from "../context/local"

/**
 * Home-page goal intake. A submitted goal starts the persistent company
 * project workflow; group chat remains available as a discussion surface but
 * is no longer the execution engine.
 */
export function HomeBoardPrompt() {
  const sdk = useSDK()
  const route = useRoute()
  const navigate = route.navigate
  const toast = useToast()
  const { theme } = useTheme()
  const t = useLanguage().t
  const command = useCommandDialog()
  const keybind = useKeybind()
  const exit = useExit()
  const dialog = useDialog()
  const local = useLocal()

  let textarea: any
  let promptAnchor: any
  let promptPartTypeId = 0
  const [inputText, setInputText] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [autocompleteRef, setAutocompleteRef] = createSignal<AutocompleteRef | undefined>()

  const fileStyleId = createMemo(() => useTheme().syntax().getStyleId("extmark.file")!)
  const agentStyleId = createMemo(() => useTheme().syntax().getStyleId("extmark.agent")!)

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function send() {
    const raw = textarea && !textarea.isDestroyed ? textarea.plainText : inputText()
    const text = raw.trim()
    if (!text || sending()) return

    // While the slash menu is open, Enter is intercepted by the autocomplete
    if (autocompleteRef()?.visible) return

    // Client-side slash commands
    const clientSlash = text.startsWith("/") ? command.slashes().find((s) => s.display === text) : undefined
    if (clientSlash) {
      setInputText("")
      if (textarea && !textarea.isDestroyed) textarea.clear()
      clientSlash.onSelect?.()
      return
    }

    setSending(true)
    try {
      const selected = local.model.current()
      const startRes = await sdk.fetch(`${sdk.url}/company-project`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: text,
          provider_id: selected?.providerID,
          model_id: selected?.modelID,
        }),
      })
      if (!startRes.ok) {
        const body = await startRes.text().catch(() => "")
        toast.show({ variant: "error", message: body || "启动项目失败，请重试" })
        return
      }

      setInputText("")
      if (textarea && !textarea.isDestroyed) textarea.clear()
      toast.show({ variant: "info", message: "项目已启动，团队正在调研；立项时会请求你批准" })
      navigate({ type: "plugin", id: "workstation" })
    } catch (err) {
      toast.show({
        variant: "error",
        message: err instanceof Error ? err.message : "操作失败",
      })
    } finally {
      setSending(false)
    }
  }

  // Ignore exit while the project-start request is in flight.
  useKeyboard((evt) => {
    if (keybind.match("app_exit", evt)) {
      if (sending()) return
      void DialogConfirm.show(dialog, t("tui.dialog.exit.title"), t("tui.dialog.exit.message")).then((result) => {
        if (result) void exit()
      })
    }
  })

  // Focus the textarea on mount
  onMount(() => {
    setTimeout(() => {
      if (textarea && !textarea.isDestroyed) textarea.focus()
    }, 1)
  })

  return (
    <box flexDirection="column" width="100%" gap={1}>
      {/* Company project intake */}
      <box flexDirection="column" gap={1}>
        <box flexDirection="row" gap={1} alignItems="center">
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
            {t("tui.home.board_chat.title")}
          </text>
          <Show when={sending()}>
            <Spinner color={theme.textMuted}>{t("tui.home.board_chat.sending")}</Spinner>
          </Show>
        </box>
        <text fg={theme.textMuted}>{t("tui.home.board_chat.subtitle")}</text>
      </box>

      {/* Goal input */}
      <Autocomplete
        value={inputText()}
        setPrompt={() => {}}
        setExtmark={() => {}}
        anchor={() => promptAnchor}
        input={() => textarea}
        ref={(r) => setAutocompleteRef(() => r)}
        fileStyleId={fileStyleId()}
        agentStyleId={agentStyleId()}
        promptPartTypeId={() => promptPartTypeId}
        slashCommandsOnly
      />
      <box ref={(r: any) => (promptAnchor = r)}>
        <textarea
          ref={(v: any) => {
            textarea = v
            if (promptPartTypeId === 0) {
              promptPartTypeId = v.extmarks.registerType("prompt-part")
            }
          }}
          height={3}
          keyBindings={sending() ? [] : [{ name: "return", action: "submit" }]}
          onContentChange={() => {
            const value = textarea && !textarea.isDestroyed ? textarea.plainText : ""
            setInputText(value)
            autocompleteRef()?.onInput(value)
          }}
          onKeyDown={(e: any) => {
            autocompleteRef()?.onKeyDown(e)
          }}
          onSubmit={() => void send()}
          placeholder={t("tui.home.board_chat.placeholder")}
          placeholderColor={theme.textMuted}
          textColor={sending() ? theme.textMuted : theme.text}
          focusedTextColor={sending() ? theme.textMuted : theme.text}
          cursorColor={theme.text}
        />
      </box>

      {/* Hint text */}
      <box>
        <text fg={theme.textMuted}>{t("tui.home.board_chat.hint")}</text>
      </box>
    </box>
  )
}
