import type { Accessor } from "solid-js"
import { Mark } from "@agents-company/ui/logo"
import { Icon } from "@agents-company/ui/icon"
import { Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  createCompanyWorkspaceDataSource,
  installCompanyRefreshTriggers,
  type CompanyWorkspaceDataSource,
} from "./company-data-source"
import { useGlobalSDK } from "@/context/global-sdk"
import type { CompanyWorkspaceSnapshot, CompanyReadyWorkspaceSnapshot, ConversationSnapshot } from "./company-model"
import { CompanyBootstrap, type CompanyBootstrapSnapshot } from "./company-bootstrap"
import { CompanyReady } from "./company-ready"
import { ChannelSidebar } from "./channel-sidebar"
import { MessageFeed } from "./message-feed"
import { ThreadPanel } from "./thread-panel"
import { CompanyComposer } from "./company-composer"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import type { ConversationStore } from "./company-conversation-data-source"
import "./workspace.css"

function CompanyRail(props: { onToggleContext: () => void; onToggleChannels: () => void }) {
  return (
    <aside class="company-rail" aria-label="公司导航">
      <div class="company-mark" aria-label="Agent Company">
        <Mark class="company-mark-icon" />
      </div>
      <nav class="company-rail-nav">
        <button type="button" class="company-rail-button active" aria-label="消息" onClick={props.onToggleChannels}>
          <Icon name="bubble-5" size="medium" />
        </button>
        <button type="button" class="company-rail-button" aria-label="公司配置" onClick={props.onToggleContext}>
          <Icon name="settings-gear" size="medium" />
        </button>
      </nav>
    </aside>
  )
}

function channelTitle(conv: ConversationSnapshot, fallback: string): string {
  const active = conv.channels.find((channel) => channel.id === conv.activeChannelID)
  if (active) return active.title
  const board = conv.channels.find((channel) => channel.kind === "board")
  return board?.title ?? fallback
}

/**
 * Live IM workspace rendered when the company is ready. Every channel, message,
 * thread entry, member and status comes from the conversation store snapshot —
 * no fixture data, no fabricated approval/delivery cards. The Context Panel
 * is collapsible so company facts stay reachable without dominating the IM surface.
 */
function CompanyReadyWorkspace(props: { snapshot: Accessor<CompanyReadyWorkspaceSnapshot>; dataSource: CompanyWorkspaceDataSource }) {
  const language = useLanguage()
  const conversation = createMemo(() => props.snapshot().conversation)
  const store = (): ConversationStore | undefined => props.dataSource.conversation
  const [contextOpen, setContextOpen] = createSignal(false)
  const [mobileChannelsOpen, setMobileChannelsOpen] = createSignal(false)
  const [interrupting, setInterrupting] = createSignal(false)

  const activeChannelID = createMemo(() => conversation().activeChannelID)
  const hasOpenThread = createMemo(() => conversation().thread !== null)
  const hasMoreMessages = createMemo(() => conversation().messagesBefore !== null)
  const hasMoreEntries = createMemo(() => conversation().threadEntriesBefore !== null)
  // The server remains authoritative for the release capability. An emergency
  // rollback keeps the persisted read model visible while hiding every send
  // entry; it never falls back to fixtures or a second conversation path.
  const boardMessagesEnabled = createMemo(() => props.snapshot().capabilities.board_messages === true)
  const companyDisabledText = createMemo(() => language.t("company.workspace.board_messages_disabled"))

  const selectChannel = (channelID: string) => {
    setMobileChannelsOpen(false)
    void store()?.setActiveChannel(channelID)
  }

  const openThread = (threadID: string) => {
    if (!threadID) return
    void store()?.openThread(threadID)
  }

  const interrupt = async () => {
    setInterrupting(true)
    try {
      await store()?.interruptThread()
    } finally {
      setInterrupting(false)
    }
  }

  return (
    <div class="company-workspace" data-thread-open={hasOpenThread() ? "true" : "false"} data-state="ready">
      <CompanyRail
        onToggleContext={() => setContextOpen((current) => !current)}
        onToggleChannels={() => setMobileChannelsOpen((current) => !current)}
      />
      <Show when={mobileChannelsOpen()}>
        <button
          type="button"
          class="company-mobile-scrim"
          aria-label="关闭频道列表"
          onClick={() => setMobileChannelsOpen(false)}
        />
      </Show>
      <div class="company-channels-wrap" classList={{ "mobile-open": mobileChannelsOpen() }}>
        <ChannelSidebar
          channels={() => conversation().channels}
          activeChannelID={activeChannelID}
          loading={() => conversation().loadingChannels}
          onSelect={selectChannel}
        />
      </div>

      <main class="company-conversation">
        <header class="company-conversation-header">
          <h1>{channelTitle(conversation(), props.snapshot().company.name)}</h1>
          <Show when={conversation().loadingMessages}>
            <span class="company-sidebar-loading" aria-live="polite">…</span>
          </Show>
        </header>
        <MessageFeed
          messages={() => conversation().messages}
          pendingMessages={() => conversation().pendingMessages}
          loading={() => conversation().loadingMessages}
          hasMore={hasMoreMessages}
          onLoadMore={() => void store()?.pageMessages()}
          onOpenThread={openThread}
        />
        <Show
          when={boardMessagesEnabled()}
          fallback={
            <div class="company-composer-disabled" data-capability="board-messages-disabled" role="status">
              {companyDisabledText()}
            </div>
          }
        >
          <CompanyComposer
            sending={() => conversation().sending}
            error={() => conversation().error}
            hasOpenThread={hasOpenThread}
            onSend={(body) => void store()?.sendMessage(body)}
            onInterrupt={() => void interrupt()}
            onRetry={() => void store()?.refresh()}
          />
        </Show>
      </main>

      <Show when={hasOpenThread()}>
        <ThreadPanel
          thread={() => conversation().thread}
          entries={() => conversation().threadEntries}
          loading={() => conversation().loadingMessages}
          hasMore={hasMoreEntries}
          interrupting={interrupting}
          threadSources={() => conversation().threadSources}
          loadingSourceIDs={() => conversation().loadingThreadSourceIDs}
          onClose={() => void store()?.openThread("")}
          onInterrupt={() => void interrupt()}
          onLoadMore={() => void store()?.pageThreadEntries()}
          onLoadSource={(sourceID) => void store()?.loadThreadSource(sourceID)}
        />
      </Show>

      <Show when={contextOpen()}>
        <aside class="company-context-panel" aria-label="公司配置">
          <header class="company-context-header">
            <strong>{props.snapshot().company.name}</strong>
            <button
              type="button"
              class="company-icon-button"
              aria-label="关闭配置"
              onClick={() => setContextOpen(false)}
            >
              <Icon name="close" />
            </button>
          </header>
          <div class="company-context-body">
            <CompanyReady snapshot={props.snapshot()} />
          </div>
        </aside>
      </Show>
    </div>
  )
}

function CompanyLiveWorkspace(props: {
  snapshot: CompanyWorkspaceSnapshot
  dataSource: CompanyWorkspaceDataSource
  serverUrl: string
  onRefresh: () => void
}) {
  const needsBootstrap = () => {
    const snapshot = props.snapshot
    return snapshot.status === "needs_bootstrap" ? (snapshot satisfies CompanyBootstrapSnapshot) : undefined
  }
  const ready = () => {
    const snapshot = props.snapshot
    return snapshot.status === "ready" ? (snapshot satisfies CompanyReadyWorkspaceSnapshot) : undefined
  }
  const failed = () => {
    const snapshot = props.snapshot
    return snapshot.status === "error" ? snapshot : undefined
  }
  const disconnected = () => {
    const snapshot = props.snapshot
    return snapshot.status === "disconnected" ? snapshot : undefined
  }

  return (
    <Switch fallback={<main class="company-state-panel" data-company-state="loading">正在读取本地 Company…</main>}>
      <Match when={needsBootstrap()}>
        {(snapshot) => (
          <CompanyBootstrap
            snapshot={snapshot()}
            dataSource={props.dataSource}
            serverUrl={props.serverUrl}
            onComplete={props.onRefresh}
          />
        )}
      </Match>
      <Match when={ready()}>{(snapshot) => <CompanyReadyWorkspace snapshot={snapshot} dataSource={props.dataSource} />}</Match>
      <Match when={failed()}>
        {(snapshot) => (
          <main class="company-state-panel" data-company-state="error">
            <h1>{snapshot().title}</h1>
            <p>{snapshot().description}</p>
            <Show when={snapshot().retryable}>
              <button type="button" onClick={props.onRefresh}>重试</button>
            </Show>
          </main>
        )}
      </Match>
      <Match when={disconnected()}>
        {(snapshot) => (
          <main class="company-state-panel" data-company-state="disconnected">
            <h1>{snapshot().title}</h1>
            <p>{snapshot().description}</p>
          </main>
        )}
      </Match>
    </Switch>
  )
}

export default function CompanyWorkspace(props: { dataSource?: CompanyWorkspaceDataSource }) {
  const globalSDK = useGlobalSDK()
  const server = useServer()
  const source = props.dataSource ?? createCompanyWorkspaceDataSource(globalSDK.client)
  const [snapshot, setSnapshot] = createSignal(source.getSnapshot())

  const state = createMemo<CompanyWorkspaceSnapshot>(() => snapshot())

  onMount(() => {
    const unsubscribe = source.subscribe(setSnapshot)
    onCleanup(unsubscribe)
    onCleanup(installCompanyRefreshTriggers(source, document))
    void source.refresh()

    if (source.handleEvent) {
      const unsubEvent = globalSDK.event.on("global", (event) => {
        source.handleEvent?.(event)
      })
      onCleanup(unsubEvent)
    }
  })

  return (
    <CompanyLiveWorkspace
      snapshot={state()}
      dataSource={source}
      serverUrl={server.current?.http.url ?? ""}
      onRefresh={() => void source.refresh()}
    />
  )
}
