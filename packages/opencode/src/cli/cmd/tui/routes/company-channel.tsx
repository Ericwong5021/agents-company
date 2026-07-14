import {
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js"
import { useRouteData, useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useToast } from "../ui/toast"
import { Spinner } from "@tui/component/spinner"
import { useKeyboard } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { useKeybind } from "@tui/context/keybind"
import { useExit } from "@tui/context/exit"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useLanguage } from "../context/language"
import {
  authorLabel,
  interruptAction,
  type ChannelMessage,
  type ThreadDetail,
  type ThreadEntry,
} from "./company-channel-model"

/**
 * Board / company channel view. Reads real channels and messages through the
 * generated SDK; the user goal already entered the Control Plane via
 * HomeBoardPrompt, so this route only paginates the main conversation, opens a
 * source Thread and can interrupt the running thread. It deliberately mirrors
 * only a slice of the Web IA: no project creation, no fabricated governance.
 */
export function CompanyChannel() {
  const route = useRouteData("company-channel")
  const fullRoute = useRoute()
  const navigate = fullRoute.navigate
  const sdk = useSDK()
  const { theme } = useTheme()
  const toast = useToast()
  const keybind = useKeybind()
  const exit = useExit()
  const dialog = useDialog()
  const t = useLanguage().t

  let textarea: any
  const [inputText, setInputText] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [thread, setThread] = createSignal<ThreadDetail | null>(null)
  const [threadEntries, setThreadEntries] = createSignal<ThreadEntry[]>([])

  // Fetch channel info
  const [channelInfo] = createResource(
    () => route.companyID,
    async (companyID) => {
      const result = await sdk.client.company.channels({ company_id: companyID })
      if (result.error) throw result.error
      return (result.data ?? []).find((c) => c.id === route.channelID)
    },
  )

  // Fetch channel messages
  const [messages, { refetch: refetchMessages }] = createResource(
    () => ({ channelID: route.channelID, companyID: route.companyID }),
    async ({ channelID, companyID }) => {
      const result = await sdk.client.company.channelMessages({
        channelID,
        company_id: companyID,
        limit: 50,
      })
      if (result.error) throw result.error
      return (result.data?.items ?? []) as ChannelMessage[]
    },
  )

  async function send() {
    const raw = textarea && !textarea.isDestroyed ? textarea.plainText : inputText()
    const text = raw.trim()
    if (!text || sending()) return
    setSending(true)
    try {
      const result = await sdk.client.company.channelSend({
        channelID: route.channelID,
        company_id: route.companyID,
        channelSendInput: { request_id: crypto.randomUUID(), body: text },
      })
      if (result.error) throw result.error
      setInputText("")
      if (textarea && !textarea.isDestroyed) textarea.clear()
      // The 202 confirmed persistence; refresh the snapshot immediately. SSE
      // invalidation (when connected) reconciles any later high-signal updates.
      void refetchMessages()
    } catch (err) {
      toast.show({
        variant: "error",
        message: err instanceof Error ? err.message : t("tui.company.channel.send_failed"),
      })
    } finally {
      setSending(false)
    }
  }

  async function openThread(threadID: string) {
    try {
      const [tResult, eResult] = await Promise.all([
        sdk.client.company.thread({ threadID, company_id: route.companyID }),
        sdk.client.company.threadEntries({ threadID, company_id: route.companyID, limit: 50 }),
      ])
      if (tResult.error) throw tResult.error
      if (eResult.error) throw eResult.error
      setThread(tResult.data as ThreadDetail)
      setThreadEntries((eResult.data?.items ?? []) as ThreadEntry[])
    } catch {
      toast.show({ variant: "error", message: t("tui.company.channel.thread_load_failed") })
    }
  }

  async function interruptThread() {
    const current = thread()
    if (!current) return
    try {
      const result = await sdk.client.company.threadAction({
        threadID: current.id,
        company_id: route.companyID,
        threadActionInput: interruptAction(),
      })
      if (result.error) throw result.error
      toast.show({ variant: "info", message: t("tui.company.channel.interrupted") })
      await openThread(current.id)
    } catch {
      toast.show({ variant: "error", message: t("tui.company.channel.interrupt_failed") })
    }
  }

  // Exit via keyboard
  useKeyboard((evt) => {
    if (keybind.match("app_exit", evt)) {
      void DialogConfirm.show(dialog, t("tui.dialog.exit.title"), t("tui.dialog.exit.message")).then((result) => {
        if (result) void exit()
      })
    }
  })

  return (
    <box flexDirection="row" width="100%" height="100%">
      <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
        {/* Header */}
        <box flexShrink={0} flexDirection="row" gap={1}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
            {channelInfo()?.title ?? route.channelID}
          </text>
          <button onClick={() => navigate({ type: "home" })}>
            <text fg={theme.textMuted}>{t("tui.company.channel.back")}</text>
          </button>
        </box>

        {/* Messages list */}
        <scrollbox flexGrow={1} flexShrink={1}>
          <Show when={!messages.loading} fallback={<Spinner>{t("tui.company.channel.loading")}</Spinner>}>
            <Show
              when={messages() && messages()!.length > 0}
              fallback={<text fg={theme.textMuted}>{t("tui.company.channel.empty")}</text>}
            >
              <box flexDirection="column" gap={1}>
                <For each={messages()}>
                  {(msg) => (
                    <box flexDirection="column" gap={0}>
                      <box flexDirection="row" gap={1}>
                        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                          {authorLabel(msg.author, t("tui.company.channel.you"))}
                        </text>
                        <Show when={msg.signalType}>
                          <text fg={theme.success}>[{msg.signalType}]</text>
                        </Show>
                        <text fg={theme.textMuted}>
                          {new Date(msg.time.created).toLocaleTimeString()}
                        </text>
                        <Show when={msg.sourceThreadID}>
                          <button onClick={() => void openThread(msg.sourceThreadID!)}>
                            <text fg={theme.info}>{t("tui.company.channel.thread")}</text>
                          </button>
                        </Show>
                      </box>
                      <text fg={theme.text}>{msg.body}</text>
                    </box>
                  )}
                </For>
              </box>
            </Show>
          </Show>
        </scrollbox>

        {/* Thread detail panel */}
        <Show when={thread()}>
          {(th) => (
            <box
              flexDirection="column"
              gap={1}
              padding={1}
              border={["top", "left", "right", "bottom"]}
              borderColor={theme.border}
            >
              <box flexDirection="row" gap={1}>
                <text fg={theme.accent} attributes={TextAttributes.BOLD}>{th().title}</text>
                <text fg={theme.textMuted}>({th().status})</text>
                <button onClick={() => void interruptThread()}>
                  <text fg={theme.warning}>{t("tui.company.channel.interrupt")}</text>
                </button>
                <button onClick={() => setThread(null)}>
                  <text fg={theme.textMuted}>{t("tui.company.channel.close")}</text>
                </button>
              </box>
              <For each={threadEntries()}>
                {(entry) => (
                  <box flexDirection="column" gap={0} paddingLeft={1}>
                    <text fg={theme.textMuted}>{entry.message.author.id}</text>
                    <text>{entry.message.body}</text>
                  </box>
                )}
              </For>
            </box>
          )}
        </Show>

        {/* Input area */}
        <box flexShrink={0} flexDirection="column" gap={1}>
          <textarea
            ref={(v: any) => { textarea = v }}
            height={3}
            keyBindings={sending() ? [] : [{ name: "return", action: "submit" }]}
            onContentChange={() => {
              const value = textarea && !textarea.isDestroyed ? textarea.plainText : ""
              setInputText(value)
            }}
            onSubmit={() => void send()}
            placeholder={t("tui.company.channel.placeholder")}
            placeholderColor={theme.textMuted}
            textColor={sending() ? theme.textMuted : theme.text}
            focusedTextColor={sending() ? theme.textMuted : theme.text}
            cursorColor={theme.text}
          />
          <Show when={sending()}>
            <Spinner color={theme.textMuted}>{t("tui.company.channel.sending")}</Spinner>
          </Show>
        </box>
      </box>
    </box>
  )
}
