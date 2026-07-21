import type { Accessor } from "solid-js"
import { Icon } from "@agents-company/ui/icon"
import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js"
import {
  createCompanyWorkspaceDataSource,
  installCompanyRefreshTriggers,
  type CompanyWorkspaceDataSource,
} from "./company-data-source"
import { useGlobalSDK } from "@/context/global-sdk"
import {
  companyProjectExecutionStateEquals,
  type CompanyProjectExecutionState,
  type CompanyWorkspaceSnapshot,
  type CompanyReadyWorkspaceSnapshot,
} from "./company-model"
import { CompanyReady } from "./company-ready"
import { ChannelSidebar, type CompanyWorkspaceView } from "./channel-sidebar"
import { MessageFeed } from "./message-feed"
import { ThreadPanel } from "./thread-panel"
import { CompanyComposer } from "./company-composer"
import { BoardRoundtable } from "./board-roundtable"
import { OfficeSurface } from "./office-surface"
import { NewGoalSurface } from "./new-goal-surface"
import { ProjectRoom } from "./project-room"
import {
  COMPANY_PROVIDER_CONFIGURED_EVENT,
  projectExecutionModel,
  providerConfigured,
} from "./provider-availability"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { useDialog } from "@agents-company/ui/context/dialog"
import type { ConversationStore } from "./company-conversation-data-source"
import "./workspace.css"
import "./organization-workspace.css"

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
  const conversation = createMemo(() => props.snapshot().conversation)
  const store = (): ConversationStore | undefined => props.dataSource.conversation
  const [mobileChannelsOpen, setMobileChannelsOpen] = createSignal(false)
  const [interrupting, setInterrupting] = createSignal(false)
  const [view, setView] = createSignal<CompanyWorkspaceView>("conversation")
  const [workPanelOpen, setWorkPanelOpen] = createSignal(false)
  const [companyProject, setCompanyProject] = createSignal<CompanyProjectExecutionState | null>(null, {
    equals: companyProjectExecutionStateEquals,
  })
  const [projectBusy, setProjectBusy] = createSignal(false)
  const [projectError, setProjectError] = createSignal<string | null>(null)
  const [failedProjectProviderIDs, setFailedProjectProviderIDs] = createSignal<string[]>([])
  const [retryModelValue, setRetryModelValue] = createSignal("")
  let threadReturnTarget: HTMLElement | undefined
  let projectThreadKey = ""
  const [providers, { refetch: refetchProviders }] = createResource(() => props.dataSource.listProviders())

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
  const hasConfiguredProvider = createMemo(() => providerConfigured(providers()))
  const needsProviderSetup = createMemo(() => Boolean(providers()) && !hasConfiguredProvider())
  const retryModels = createMemo(() =>
    (providers()?.providers ?? []).flatMap((provider) =>
      provider.connected
        ? provider.models
            .filter((model) => model.status === "active")
            .map((model) => ({
              provider_id: provider.provider_id,
              model_id: model.model_id,
              label: `${provider.name} / ${model.name}`,
            }))
        : [],
    ),
  )
  const companyDisabledText = createMemo(() => language.t("company.workspace.board_messages_disabled"))
  const projectGoal = createMemo(() => {
    const entry = conversation().threadEntries
      .filter((item) => item.type === "message" && item.message.author.kind === "agent" && item.message.signalType === "plan")
      .at(-1)
    if (entry?.type === "message") return entry.message.body
    return conversation().messages
      .filter((message) => message.author.kind === "agent" && message.signalType === "plan")
      .at(-1)?.body ?? ""
  })

  createEffect(() => {
    const key = `${conversation().thread?.id ?? ""}:${projectGoal()}`
    if (key === projectThreadKey) return
    projectThreadKey = key
    setCompanyProject(null)
    setProjectError(null)
    if (!conversation().thread?.id || !projectGoal()) return
    void props.dataSource
      .listCompanyProjects()
      .then((projects) => {
        const matching = projects.filter((project) => project.goal === projectGoal())
        setFailedProjectProviderIDs(
          matching.flatMap((project) =>
            project.status === "blocked" && project.provider_id ? [project.provider_id] : [],
          ),
        )
        return matching.at(0)
      })
      .then((project) => (project ? props.dataSource.getCompanyProject(project.id) : null))
      .then((project) => {
        if (`${conversation().thread?.id ?? ""}:${projectGoal()}` === key) setCompanyProject(project)
      })
      .catch((error: unknown) => setProjectError(String(error)))
  })

  onMount(() => {
    const refreshProviderState = () => void refetchProviders()
    window.addEventListener(COMPANY_PROVIDER_CONFIGURED_EVENT, refreshProviderState)
    onCleanup(() => window.removeEventListener(COMPANY_PROVIDER_CONFIGURED_EVENT, refreshProviderState))

    const projectRefresh = window.setInterval(() => {
      const current = companyProject()
      if (!current || ["completed", "rejected", "blocked"].includes(current.project.status)) return
      void props.dataSource
        .getCompanyProject(current.project.id)
        .then(setCompanyProject)
        .catch((error: unknown) => setProjectError(String(error)))
    }, 1_000)
    onCleanup(() => window.clearInterval(projectRefresh))
  })

  const startCompanyProject = () => {
    if (!projectGoal() || projectBusy()) return
    if (!hasConfiguredProvider()) {
      setProjectError("没有已连接且配置了默认模型的供应商")
      return
    }
    setProjectBusy(true)
    setProjectError(null)
    void props.dataSource
      .startCompanyProject({ goal: projectGoal(), title: conversation().thread?.title })
      .then((project) => props.dataSource.getCompanyProject(project.id))
      .then(setCompanyProject)
      .catch((error: unknown) => setProjectError(String(error)))
      .finally(() => setProjectBusy(false))
  }

  const retryCompanyProject = () => {
    const current = companyProject()
    const selectedModel = retryModels().find((model) => `${model.provider_id}:${model.model_id}` === retryModelValue())
    const executionModel =
      selectedModel ??
      projectExecutionModel(providers(), [
        ...new Set([
          ...failedProjectProviderIDs(),
          ...(current?.project.provider_id ? [current.project.provider_id] : []),
        ]),
      ])
    if (!current || current.project.status !== "blocked" || !executionModel || projectBusy()) return
    setProjectBusy(true)
    setProjectError(null)
    void props.dataSource
      .retryCompanyProject({ projectID: current.project.id, ...executionModel })
      .then((project) => props.dataSource.getCompanyProject(project.id))
      .then(setCompanyProject)
      .catch((error: unknown) => setProjectError(String(error)))
      .finally(() => setProjectBusy(false))
  }

  const cancelCompanyProject = () => {
    const current = companyProject()
    if (!current?.project.active_run_id || projectBusy()) return
    setProjectBusy(true)
    setProjectError(null)
    void props.dataSource
      .cancelCompanyProject({ projectID: current.project.id, reason: "模型长时间未返回，停止本轮执行" })
      .then(() => props.dataSource.getCompanyProject(current.project.id))
      .then((project) => {
        setCompanyProject(project)
        if (project.project.provider_id) {
          setFailedProjectProviderIDs((currentIDs) => [...new Set([...currentIDs, project.project.provider_id!])])
        }
      })
      .catch((error: unknown) => setProjectError(String(error)))
      .finally(() => setProjectBusy(false))
  }

  const resolveCompanyProjectGate = (gateID: string, decision: "approve" | "reject") => {
    const current = companyProject()
    if (!current || projectBusy()) return
    setProjectBusy(true)
    setProjectError(null)
    void props.dataSource
      .resolveCompanyProjectGate({ projectID: current.project.id, gateID, decision })
      .then(() => props.dataSource.getCompanyProject(current.project.id))
      .then(setCompanyProject)
      .catch((error: unknown) => setProjectError(String(error)))
      .finally(() => setProjectBusy(false))
  }

  const openSettings = (defaultValue = "company") =>
    void import("@/components/dialog-settings").then((settings) =>
      dialog.show(() => (
        <settings.DialogSettings
          defaultValue={defaultValue}
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

  const openProject = (projectID: string) => {
    setMobileChannelsOpen(false)
    setWorkPanelOpen(false)
    setView("project")
    if (companyProject()?.project.id === projectID) return
    setProjectError(null)
    void props.dataSource.getCompanyProject(projectID).then(setCompanyProject).catch((error: unknown) => setProjectError(String(error)))
  }

  const selectChannel = (channelID: string) => {
    setMobileChannelsOpen(false)
    setView("conversation")
    setWorkPanelOpen(true)
    void store()?.setActiveChannel(channelID)
  }

  const openThread = (threadID: string) => {
    if (!threadID) return
    threadReturnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    setWorkPanelOpen(true)
    void store()?.openThread(threadID)
  }

  const closeThread = () => {
    setWorkPanelOpen(false)
    queueMicrotask(() => threadReturnTarget?.focus())
  }

  const interrupt = async () => {
    setInterrupting(true)
    try {
      await store()?.interruptThread()
    } finally {
      setInterrupting(false)
    }
  }

  const sendGoal = (body: string) => {
    if (!hasConfiguredProvider()) {
      void props.dataSource.deferSetupGoal({ companySetupGoalInput: { body } })
      return
    }
    const current = store()
    if (!current) return
    setView("conversation")
    void current
      .sendMessage(body, { referenced_thread_id: current.getOpenThreadID() ?? undefined })
      .then((accepted) => {
        if (!accepted.threadID) return
        openThread(accepted.threadID)
        window.setTimeout(() => void current.openThread(accepted.threadID!), 1_200)
      })
  }

  return (
    <div
      class="company-workspace"
      data-thread-open={workPanelOpen() && view() === "conversation" ? "true" : "false"}
      data-view={view()}
      data-state="ready"
    >
      <a class="company-skip-link" href="#company-main-content">
        跳到主要内容
      </a>
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
          projects={() => (companyProject() ? [companyProject()!.project] : [])}
          activeProjectID={() => companyProject()?.project.id ?? null}
          loading={() => conversation().loadingChannels}
          onSelect={selectChannel}
          onOpenProject={openProject}
          onNewConversation={() => {
            setMobileChannelsOpen(false)
            setView("new")
            setWorkPanelOpen(true)
            const board = conversation().channels.find((channel) => channel.kind === "board")
            if (board) void store()?.setActiveChannel(board.id, { restoreLatestThread: false })
          }}
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
            <main id="company-main-content" class="company-conversation" tabindex="-1">
              <header class="company-conversation-header">
                <div>
                  <h1>
                    {view() === "new"
                      ? "新建目标"
                      : view() === "project"
                        ? "项目室"
                        : boardChannel()
                          ? "董事会圆桌会议"
                          : `与 ${props.snapshot().company.name} 的对话`}
                  </h1>
                  <Show when={view() === "project" && companyProject()}>
                    {(project) => <span>董事会 / {project().project.title}</span>}
                  </Show>
                </div>
                <Show when={conversation().loadingMessages}>
                  <span class="company-sidebar-loading" aria-live="polite">
                    …
                  </span>
                </Show>
              </header>

              <Switch>
                <Match when={view() === "new"}>
                  <NewGoalSurface
                    companyName={props.snapshot().company.name}
                    sending={() => conversation().sending}
                    error={() => conversation().error}
                    hasOpenThread={hasOpenThread}
                    onSend={sendGoal}
                    onInterrupt={() => void interrupt()}
                    onRetry={() => void store()?.refresh()}
                  />
                </Match>
                <Match when={view() === "project"}>
                  <ProjectRoom
                    project={companyProject}
                    busy={projectBusy}
                    error={projectError}
                    onOpenBoard={openBoard}
                    onCancel={cancelCompanyProject}
                  />
                </Match>
                <Match when={view() === "conversation" && boardChannel()}>
                  <BoardRoundtable
                    members={() => props.snapshot().company.board}
                    thread={() => conversation().thread}
                    entries={() => conversation().threadEntries}
                    messages={() => conversation().messages}
                    project={companyProject}
                    projectBusy={projectBusy}
                    projectError={projectError}
                    onStartProject={startCompanyProject}
                    onRetryProject={retryCompanyProject}
                    onCancelProject={cancelCompanyProject}
                    retryModels={retryModels}
                    retryModelValue={retryModelValue}
                    onRetryModelChange={setRetryModelValue}
                    onResolveGate={resolveCompanyProjectGate}
                    onOpenThread={openThread}
                    onOpenProject={() => companyProject() && openProject(companyProject()!.project.id)}
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

              <Show when={view() !== "project" && needsProviderSetup()}>
                <section class="company-provider-setup-card" aria-live="polite">
                  <span class="company-provider-setup-icon">
                    <Icon name="providers" size="small" />
                  </span>
                  <div>
                    <strong>连接模型后继续董事会讨论</strong>
                    <p>
                      {props.snapshot().company.setup_goal?.body
                        ? `已暂存：${props.snapshot().company.setup_goal?.body}`
                        : "当前没有可用模型。配置 Provider 和 API Key 后即可开始讨论。"}
                    </p>
                  </div>
                  <button type="button" onClick={() => openSettings("providers")}>
                    配置 Provider
                  </button>
                </section>
              </Show>

              <Show when={view() === "conversation"}>
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
                    onSend={sendGoal}
                    onInterrupt={() => void interrupt()}
                    onRetry={() => void store()?.refresh()}
                  />
                </Show>
              </Show>
              <Show when={view() !== "project"}><span class="company-ai-disclaimer">以上内容由 AI 生成</span></Show>
            </main>

            <Show when={workPanelOpen() && view() === "conversation"}>
              <ThreadPanel
                thread={() => conversation().thread}
                entries={() => conversation().threadEntries}
                loading={() => conversation().loadingMessages}
                hasMore={hasMoreEntries}
                interrupting={interrupting}
                threadSources={() => conversation().threadSources}
                loadingSourceIDs={() => conversation().loadingThreadSourceIDs}
                onClose={closeThread}
                onInterrupt={() => void interrupt()}
                onLoadMore={() => void store()?.pageThreadEntries()}
                onLoadSource={(sourceID) => void store()?.loadThreadSource(sourceID)}
              />
            </Show>
            <Show when={!workPanelOpen() && view() === "conversation"}>
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
        <OfficeSurface
          snapshot={props.snapshot}
          conversation={conversation}
          project={companyProject}
          onOpenProject={() => companyProject() && openProject(companyProject()!.project.id)}
          onOpenThread={openThread}
        />
      </Show>
    </div>
  )
}

function CompanyLiveWorkspace(props: {
  snapshot: CompanyWorkspaceSnapshot
  dataSource: CompanyWorkspaceDataSource
  onRefresh: () => void
}) {
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
      const unsubEvent = globalSDK.event.listen((event) => {
        source.handleEvent?.(event.details)
      })
      onCleanup(unsubEvent)
    }
  })

  return <CompanyLiveWorkspace snapshot={state()} dataSource={source} onRefresh={() => void source.refresh()} />
}
