import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { useKV } from "../context/kv"
import { useToast } from "../ui/toast"
import { useLanguage } from "../context/language"
import { useKeybind } from "../context/keybind"
import { useCommandDialog } from "../component/dialog-command"
import { Autocomplete, type AutocompleteRef } from "../component/prompt/autocomplete"
import { useExit } from "../context/exit"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { Spinner } from "../component/spinner"

const BOARD_DEPT_NAME = "董事会圆桌"

/**
 * Home-page prompt that sends messages directly to the board group chat
 * (a group session with all company agents) instead of creating a new
 * one-on-one session.
 */
export function HomeBoardPrompt() {
  const sdk = useSDK()
  const route = useRoute()
  const navigate = route.navigate
  const kv = useKV()
  const toast = useToast()
  const { theme } = useTheme()
  const t = useLanguage().t
  const command = useCommandDialog()
  const keybind = useKeybind()
  const exit = useExit()
  const dialog = useDialog()

  let textarea: any
  let promptAnchor: any
  let promptPartTypeId = 0
  const [inputText, setInputText] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [autocompleteRef, setAutocompleteRef] = createSignal<AutocompleteRef | undefined>()

  const fileStyleId = createMemo(() => useTheme().syntax().getStyleId("extmark.file")!)
  const agentStyleId = createMemo(() => useTheme().syntax().getStyleId("extmark.agent")!)

  // ── Ensure the board group session exists (create once, reuse forever) ──────
  async function ensureBoardGroupSessionID(): Promise<string> {
    const existing = kv.get("board_group_session_id")
    if (existing && typeof existing === "string") {
      // Verify it still exists on the server (might have been deleted)
      const check = await sdk.fetch(`${sdk.url}/group-session/${existing}`)
      if (check.ok) return existing
    }

    const res = await sdk.fetch(`${sdk.url}/company-agent`)
    if (!res.ok) throw new Error("无法获取智能体列表")
    const agentList = (await res.json()) as Array<{ id: string }>
    const boardAgentIDs = agentList.filter((a) => a.id !== "assistant").map((a) => a.id)
    const agentIDs =
      boardAgentIDs.length > 0 ? boardAgentIDs : agentList.some((a) => a.id === "assistant") ? ["assistant"] : []

    if (agentIDs.length === 0) throw new Error(t("tui.home.board_chat.no_agents"))

    const profile = kv.get("onboarding_profile") as Record<string, any> | undefined
    const companyName = (profile?.companyName as string) || (profile?.userName as string) || ""

    const createRes = await sdk.fetch(`${sdk.url}/group-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `${BOARD_DEPT_NAME} · ${companyName}`,
        agentIDs,
      }),
    })
    if (!createRes.ok) {
      const body = await createRes.text().catch(() => "")
      throw new Error(`创建董事会群聊失败 (${createRes.status}): ${body}`)
    }
    const info = (await createRes.json()) as { id: string }
    kv.set("board_group_session_id", info.id)
    return info.id
  }

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
      const groupSessionID = await ensureBoardGroupSessionID()

      const chatRes = await sdk.fetch(`${sdk.url}/group-session/${groupSessionID}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })

      if (chatRes.status === 409) {
        // Group is busy — navigate there anyway so the user sees the live state
        navigate({ type: "group-session", groupSessionID })
        return
      }
      if (!chatRes.ok) {
        toast.show({ variant: "error", message: "发送消息失败，请重试" })
        return
      }

      // Clear the input and navigate to the board group session
      setInputText("")
      if (textarea && !textarea.isDestroyed) textarea.clear()
      navigate({ type: "group-session", groupSessionID })
    } catch (err) {
      toast.show({
        variant: "error",
        message: err instanceof Error ? err.message : "操作失败",
      })
    } finally {
      setSending(false)
    }
  }

  // ── Interrupt (not used from home, but keep for Ctrl+C handling) ────────────
  async function interrupt() {
    const gsid = kv.get("board_group_session_id")
    if (!gsid || typeof gsid !== "string") return
    await sdk.fetch(`${sdk.url}/group-session/${gsid}/interrupt`, { method: "POST" })
  }

  // Ctrl+C: first press interrupts busy agents, second press shows exit dialog
  useKeyboard((evt) => {
    if (keybind.match("app_exit", evt)) {
      if (sending()) {
        void interrupt()
        return
      }
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
      {/* Board chat header */}
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

      {/* Input area (mirrors the group-session route's textarea + autocomplete) */}
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
