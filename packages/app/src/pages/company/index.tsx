import type { Accessor } from "solid-js"
import { Icon } from "@agents-company/ui/icon"
import { Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  createCompanyWorkspaceDataSource,
  installCompanyRefreshTriggers,
  type CompanyWorkspaceDataSource,
} from "./company-data-source"
import { useGlobalSDK } from "@/context/global-sdk"
import type { CompanyWorkspaceSnapshot, CompanyReadyWorkspaceSnapshot } from "./company-model"
import { CompanyBootstrap, type CompanyBootstrapSnapshot } from "./company-bootstrap"
import { CompanyReady } from "./company-ready"
import { ChannelSidebar, type CompanyWorkspaceView } from "./channel-sidebar"
import { MessageFeed } from "./message-feed"
import { ThreadPanel } from "./thread-panel"
import { CompanyComposer } from "./company-composer"
import { BoardRoundtable } from "./board-roundtable"
import { OfficeSurface } from "./office-surface"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { useDialog } from "@agents-company/ui/context/dialog"
import { useLayout } from "@/context/layout"
import { projectWorkspacePath } from "@/utils/shell-navigation"
import type { ConversationStore } from "./company-conversation-data-source"
import "./workspace.css"

/**
 * Live IM workspace rendered when the company is ready. Every channel, message,
 * thread entry, member and status comes from the conversation store snapshot —
 * no fixture data, no fabricated approval/delivery cards. The Context Panel
 * is collapsible so company facts stay reachable without dominating the IM surface.
 */
function CompanyReadyWorkspace(props: {
  snapshot: Accessor<CompanyReadyWorkspaceSnapshot>
  dataSource: CompanyWorkspaceDataSource
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const layout = useLayout()
  const conversation = createMemo(() => props.snapshot().conversation)
  const store = (): ConversationStore | undefined => props.dataSource.conversation
  const [mobileChannelsOpen, setMobileChannelsOpen] = createSignal(false)
  const [interrupting, setInterrupting] = createSignal(false)
  const [view, setView] = createSignal<CompanyWorkspaceView>("conversation")
  const [workPanelOpen, setWorkPanelOpen] = createSignal(true)

  const activeChannelID = createMemo(() => conversation().activeChannelID)
  const activeChannel = createMemo(() =>
    conversation().channels.find((channel) => channel.id === conversation().activeChannelID),
  )
  const boardChannel = createMemo(() => activeChannel()?.kind === "board")
  const hasOpenThread = createMemo(() => conversation().thread !== null)
  const hasMoreMessages = createMemo(() => conversation().messagesBefore !== null)
  const hasMoreEntries = createMemo(() => conversation().threadEntriesBefore !== null)
  // The server remains authoritative for the release capability. An emergency
  // rollback keeps the persisted read model visible while hiding every send
  // entry; it never falls back to fixtures or a second conversation path.
  const boardMessagesEnabled = createMemo(() => props.snapshot().capabilities.board_messages === true)
  const companyDisabledText = createMemo(() => language.t("company.workspace.board_messages_disabled"))

  const openSettings = () =>
    void import("@/components/dialog-settings").then((settings) =>
      dialog.show(() => (
        <settings.DialogSettings
          defaultValue="company"
          extension={{
            value: "company",
            sectionTitle: "公司",
            label: "公司概览",
            icon: "server",
            render: () => <CompanyReady snapshot={props.snapshot()} onOpenBoard={openBoard} />,
          }}
        />
      )),
    )

  const openBoard = () => {
    dialog.close()
    setView("conversation")
    setWorkPanelOpen(true)
    const board = conversation().channels.find((channel) => channel.kind === "board")
    if (board) void store()?.setActiveChannel(board.id)
  }

  const openProject = () => {
    setMobileChannelsOpen(false)
    const directory = props.snapshot().company.repository.root_path
    layout.projects.open(directory)
    window.location.assign(projectWorkspacePath(directory))
  }

  const selectChannel = (channelID: string) => {
    setMobileChannelsOpen(false)
    setView("conversation")
    setWorkPanelOpen(true)
    void store()?.setActiveChannel(channelID)
  }

  const openThread = (threadID: string) => {
    if (!threadID) return
    setWorkPanelOpen(true)
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
    <div
      class="company-workspace"
      data-thread-open={workPanelOpen() && view() !== "office" ? "true" : "false"}
      data-view={view()}
      data-state="ready"
    >
      <button
        type="button"
        class="company-mobile-channels-toggle"
        aria-label="打开频道列表"
        aria-expanded={mobileChannelsOpen()}
        onClick={() => setMobileChannelsOpen(true)}
      >
        <Icon name="menu" size="small" />
      </button>
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
          activeView={view}
          loading={() => conversation().loadingChannels}
          onSelect={selectChannel}
          onNewConversation={() => {
            setMobileChannelsOpen(false)
            setView("new")
            setWorkPanelOpen(true)
            void store()?.openThread("")
          }}
          onOpenProject={openProject}
          onOpenOffice={() => {
            setMobileChannelsOpen(false)
            setView("office")
            setWorkPanelOpen(false)
          }}
          onOpenSettings={() => {
            setMobileChannelsOpen(false)
            openSettings()
          }}
        />
      </div>

      <Show
        when={view() === "office"}
        fallback={
          <>
            <main class="company-conversation">
              <header class="company-conversation-header">
                <h1>
                  {view() === "new"
                    ? "新建对话"
                    : boardChannel()
                      ? "董事会圆桌会议"
                      : `与 ${props.snapshot().company.name} 的对话`}
                </h1>
                <Show when={conversation().loadingMessages}>
                  <span class="company-sidebar-loading" aria-live="polite">
                    …
                  </span>
                </Show>
              </header>

              <Switch>
                <Match when={view() === "new"}>
                  <div class="company-channel-placeholder" data-state="empty">
                    <span class="company-empty-icon">
                      <Icon name="brain" />
                    </span>
                    <h2>今天想完成什么？</h2>
                    <p>从一条任务开始，Agent Company 会在本地协调团队。</p>
                  </div>
                </Match>
                <Match when={boardChannel()}>
                  <BoardRoundtable
                    members={() => props.snapshot().company.board}
                    thread={() => conversation().thread}
                    entries={() => conversation().threadEntries}
                    messages={() => conversation().messages}
                  />
                </Match>
                <Match when={true}>
                  <MessageFeed
                    messages={() => conversation().messages}
                    pendingMessages={() => conversation().pendingMessages}
                    loading={() => conversation().loadingMessages}
                    hasMore={hasMoreMessages}
                    onLoadMore={() => void store()?.pageMessages()}
                    onOpenThread={openThread}
                  />
                </Match>
              </Switch>

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
                  onSend={(body) => {
                    const current = store()
                    if (!current) return
                    setView("conversation")
                    void current.sendMessage(body).then((accepted) => {
                      if (!accepted.threadID) return
                      const threadID = accepted.threadID
                      setWorkPanelOpen(true)
                      void current.openThread(threadID)
                      window.setTimeout(() => void current.openThread(threadID), 1_200)
                    })
                  }}
                  onInterrupt={() => void interrupt()}
                  onRetry={() => void store()?.refresh()}
                />
              </Show>
              <span class="company-ai-disclaimer">以上内容由 AI 生成</span>
            </main>

            <Show when={workPanelOpen()}>
              <ThreadPanel
                thread={() => conversation().thread}
                entries={() => conversation().threadEntries}
                loading={() => conversation().loadingMessages}
                hasMore={hasMoreEntries}
                interrupting={interrupting}
                threadSources={() => conversation().threadSources}
                loadingSourceIDs={() => conversation().loadingThreadSourceIDs}
                onClose={() => setWorkPanelOpen(false)}
                onInterrupt={() => void interrupt()}
                onLoadMore={() => void store()?.pageThreadEntries()}
                onLoadSource={(sourceID) => void store()?.loadThreadSource(sourceID)}
              />
            </Show>
            <Show when={!workPanelOpen()}>
              <button
                type="button"
                class="company-panel-reopen"
                aria-label="展开侧边栏"
                onClick={() => setWorkPanelOpen(true)}
              >
                <Icon name="prompt" size="small" />
              </button>
            </Show>
          </>
        }
      >
        <OfficeSurface snapshot={props.snapshot} conversation={conversation} />
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
    <Switch
      fallback={
        <main class="company-state-panel" data-company-state="loading">
          正在读取本地 Company…
        </main>
      }
    >
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
      <Match when={ready()}>
        {(snapshot) => <CompanyReadyWorkspace snapshot={snapshot} dataSource={props.dataSource} />}
      </Match>
      <Match when={failed()}>
        {(snapshot) => (
          <main class="company-state-panel" data-company-state="error">
            <h1>{snapshot().title}</h1>
            <p>{snapshot().description}</p>
            <Show when={snapshot().retryable}>
              <button type="button" onClick={props.onRefresh}>
                重试
              </button>
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
