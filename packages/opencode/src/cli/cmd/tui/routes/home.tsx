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

  // ── Handle --prompt CLI arg: auto-send to board group session ───────────────
  createEffect(() => {
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    const sent = kv.get("_home_prompt_auto_sent")
    if (sent) return
    kv.set("_home_prompt_auto_sent", true)
    setTimeout(async () => {
      try {
        const existing = kv.get("board_group_session_id")
        let gsid: string | undefined =
          typeof existing === "string" ? existing : undefined
        if (gsid) {
          const check = await sdk.fetch(`${sdk.url}/group-session/${gsid}`)
          if (!check.ok) gsid = undefined
        }
        if (!gsid) {
          const res = await sdk.fetch(`${sdk.url}/company-agent`)
          const agentList = (await res.json()) as Array<{ id: string }>
          const agentIDs = agentList.filter((a) => a.id !== "assistant").map((a) => a.id)
          const current = await sdk.client.company.current()
          const company = current.data
          const companyName = company?.state === "ready" ? company.company.name : ""
          const createRes = await sdk.fetch(`${sdk.url}/group-session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: `董事会圆桌 · ${companyName}`, agentIDs }),
          })
          const info = (await createRes.json()) as { id: string }
          gsid = info.id
          kv.set("board_group_session_id", gsid)
        }
        await sdk.fetch(`${sdk.url}/group-session/${gsid}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: args.prompt }),
        })
        fullRoute.navigate({ type: "group-session", groupSessionID: gsid })
      } catch {
        toast.show({ variant: "error", message: "Failed to auto-send prompt" })
      }
    }, 100)
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
