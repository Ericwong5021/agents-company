import { createEffect, createMemo, For, Show } from "solid-js"
import path from "path"
import { Logo } from "../component/logo"
import { logoThin, logos, type LogoKey } from "@/cli/logo"
import { StarryBackground } from "../component/starry-background"
import { BackgroundImage } from "../component/background-image"
import { useSync } from "../context/sync"
import { useArgs } from "../context/args"
import { useRouteData, useRoute } from "@tui/context/route"
import { useRightSidebar } from "@tui/context/right-sidebar"
import { useTheme } from "../context/theme"
import { Locale } from "@/util"
import { Session as SessionApi } from "@/session"
import { useLocal } from "../context/local"
import { useKV } from "../context/kv"
import { useSDK } from "../context/sdk"
import { useLanguage } from "@tui/context/language"
import { TuiPluginRuntime } from "../plugin"
import { Global } from "@/global"
import { isPlainTerminal } from "../util/terminal"
import { NavRow } from "../component/nav-row"
import { HomeBoardPrompt } from "../component/home-board-prompt"
import { Toast, useToast } from "../ui/toast"
import { boardMessagesEnabled } from "./company-channel-model"

export function Home() {
  const sync = useSync()
  const route = useRouteData("home")
  const fullRoute = useRoute()
  const rightSidebar = useRightSidebar()
  const { theme } = useTheme()
  const args = useArgs()
  const local = useLocal()
  const kv = useKV()
  const t = useLanguage().t
  const sdk = useSDK()
  const toast = useToast()
  const plainTerminal = isPlainTerminal()

  const bgImagePath = createMemo(() => {
    const filename = kv.get("background_image")
    if (!filename || typeof filename !== "string") return undefined
    return path.join(Global.Path.config, "backgrounds", filename)
  })
  const logoKey = createMemo(() => {
    const key = kv.get("logo_design")
    return typeof key === "string" && key in logos ? (key as LogoKey) : "classic"
  })
  const showMeteor = () => true

  // ── Right sidebar: recent sessions ──────────────────────────────────────────
  createEffect(() => {
    const sessions = (sync.data.session ?? [])
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .slice(0, 12)
    rightSidebar.set(() => (
      <box height="100%" flexDirection="column">
        <box flexShrink={0} paddingRight={1} paddingBottom={1}>
          <text fg={theme.textMuted}>
            <b>{t("tui.shell.right.recent")}</b>
          </text>
        </box>
        <scrollbox flexGrow={1}>
          <box flexShrink={0} gap={1} paddingRight={1}>
            <For each={sessions}>
              {(s) => {
                const title =
                  s.title && !SessionApi.isDefaultTitle(s.title)
                    ? s.title
                    : s.id.slice(0, 8)
                return (
                  <NavRow
                    onSelect={() => fullRoute.navigate({ type: "session", sessionID: s.id })}
                    hint={<span style={{ fg: theme.textMuted }}>·</span>}
                  >
                    <text fg={theme.text}>{Locale.truncate(title, 30)}</text>
                  </NavRow>
                )
              }}
            </For>
            <Show when={sessions.length === 0}>
              <NavRow>
                <text fg={theme.textMuted}>No recent sessions</text>
              </NavRow>
            </Show>
          </box>
        </scrollbox>
      </box>
    ))
  })

  // ── Handle --prompt CLI arg: auto-send to board channel ─────────────────────
  createEffect(() => {
    if (!sync.ready || !local.model.ready) return
    const promptText = args.prompt
    if (!promptText) return
    const sent = kv.get("_home_prompt_auto_sent")
    if (sent) return
    kv.set("_home_prompt_auto_sent", true)
    void (async () => {
      try {
        const current = await sdk.client.company.current()
        if (current.error || current.data?.state !== "ready") {
          toast.show({ variant: "error", message: t("tui.home.prompt.auto.company_not_ready") })
          return
        }
        if (!boardMessagesEnabled(current.data.capabilities)) {
          toast.show({ variant: "error", message: t("tui.home.board_chat.disabled") })
          return
        }
        const companyID = current.data.company.id
        const channels = await sdk.client.company.channels({ company_id: companyID })
        if (channels.error) throw channels.error
        const board = (channels.data ?? []).find((ch) => ch.kind === "board")
        if (!board) {
          toast.show({ variant: "error", message: t("tui.home.prompt.auto.no_board") })
          return
        }
        const result = await sdk.client.company.channelSend({
          channelID: board.id,
          company_id: companyID,
          channelSendInput: {
            request_id: crypto.randomUUID(),
            body: promptText,
          },
        })
        if (result.error) throw result.error
        fullRoute.navigate({ type: "company-channel", channelID: board.id, companyID })
      } catch {
        toast.show({ variant: "error", message: t("tui.home.prompt.auto.failed") })
      }
    })()
  })

  return (
    <>
      <Show when={!plainTerminal}>
        <Show when={bgImagePath()} fallback={<StarryBackground meteor={showMeteor} />}>
          {(p) => <BackgroundImage path={p()} />}
        </Show>
      </Show>
      <box flexGrow={1} alignItems="center" paddingLeft={8} paddingRight={8} zIndex={1}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <Show
            when={plainTerminal}
            fallback={
              <TuiPluginRuntime.Slot name="home_logo" mode="replace">
                <Show when={logoKey()} keyed>
                  {(k) => <Logo shape={logos[k]} sweep />}
                </Show>
              </TuiPluginRuntime.Slot>
            }
          >
            <box flexDirection="column" flexShrink={0}>
              {logoThin.left.slice(2).map((line, index) => (
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <text selectable={false}>{line}</text>
                  <text selectable={false}>{logoThin.right[index + 2] ?? ""}</text>
                </box>
              ))}
            </box>
          </Show>
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box width="100%" maxWidth={75} zIndex={1000} paddingTop={1} flexShrink={0}>
          <HomeBoardPrompt />
        </box>
        <Show when={plainTerminal}>
          <box paddingTop={1} flexShrink={0}>
            <text selectable={false}>{t("tui.tips.plain_terminal")}</text>
          </box>
        </Show>
        <Show when={!plainTerminal}>
          <TuiPluginRuntime.Slot name="home_bottom" />
        </Show>
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <Show when={!plainTerminal}>
        <box width="100%" flexShrink={0}>
          <TuiPluginRuntime.Slot name="home_footer" mode="single_winner" />
        </box>
      </Show>
    </>
  )
}
