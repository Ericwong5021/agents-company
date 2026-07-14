import { Avatar } from "@agents-company/ui/avatar"
import { Icon, type IconProps } from "@agents-company/ui/icon"
import { Mark } from "@agents-company/ui/logo"
import {
  For,
  Match,
  Show,
  Switch,
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js"
import { createCompanyWorkspaceDataSource, type CompanyWorkspaceDataSource } from "./company-data-source"
import { useGlobalSDK } from "@/context/global-sdk"
import type { CompanyDemoSnapshot, CompanyWorkspaceSnapshot } from "./company-model"
import { CompanyBootstrap, type CompanyBootstrapSnapshot } from "./company-bootstrap"
import { CompanyReady, type CompanyReadySnapshot } from "./company-ready"
import { useServer } from "@/context/server"
import type { Event } from "@agents-company/sdk/v2/client"
import "./workspace.css"

type WorkspaceIcon = IconProps["name"]

const sections = ["公司", "项目", "Direct"] as const

const CompanyDataContext = createContext<Accessor<CompanyDemoSnapshot>>()

function useCompanyData() {
  const data = useContext(CompanyDataContext)
  if (!data) throw new Error("CompanyDataContext is missing")
  return data
}

function AgentAvatar(props: { id: string; size?: "small" | "normal" | "large"; class?: string }) {
  const data = useCompanyData()
  const agent = () => data().agents[props.id]
  return (
    <span class={`company-avatar-wrap ${props.class ?? ""}`}>
      <Avatar fallback={agent().name} src={agent().avatar} size={props.size ?? "normal"} />
      <span class="company-presence" data-status={agent().status} />
    </span>
  )
}

function RailButton(props: { icon: WorkspaceIcon; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      class="company-rail-button"
      classList={{ active: props.active }}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size="medium" />
    </button>
  )
}

function CompanyRail(props: { onMessages: () => void }) {
  const data = useCompanyData()
  return (
    <aside class="company-rail" aria-label="公司导航">
      <div class="company-mark" aria-label="Agent Company">
        <Mark class="company-mark-icon" />
      </div>
      <nav class="company-rail-nav">
        <RailButton icon="bubble-5" label="消息" active onClick={props.onMessages} />
        <RailButton icon="eye" label="关注" />
        <RailButton icon="providers" label="成员" />
        <RailButton icon="folder" label="文件" />
        <RailButton icon="settings-gear" label="设置" />
      </nav>
      <div class="company-rail-bottom">
        <RailButton icon="help" label="帮助" />
        <AgentAvatar id={data().currentUserAgentID} size="small" />
      </div>
    </aside>
  )
}

function ChannelSidebar(props: {
  active: string
  search: string
  mobileOpen: boolean
  onSearch: (value: string) => void
  onSelect: (id: string) => void
}) {
  const data = useCompanyData()
  const filtered = createMemo(() => {
    const query = props.search.trim().toLowerCase()
    if (!query) return data().channels
    return data().channels.filter((channel) => `${channel.name} ${channel.preview ?? ""}`.toLowerCase().includes(query))
  })

  return (
    <aside class="company-channels" classList={{ "mobile-open": props.mobileOpen }} aria-label="频道">
      <div class="company-channels-header">
        <strong>{data().company.name}</strong>
        <button type="button" class="company-icon-button" aria-label="新建频道">
          <Icon name="new-session" />
        </button>
      </div>
      <label class="company-search">
        <Icon name="magnifying-glass" size="small" />
        <input
          value={props.search}
          placeholder="搜索"
          aria-label="搜索频道"
          onInput={(event) => props.onSearch(event.currentTarget.value)}
        />
      </label>
      <div class="company-channel-scroll">
        <For each={sections}>
          {(section) => (
            <section class="company-channel-section">
              <div class="company-section-heading">
                <span>{section}</span>
                <button type="button" aria-label={`添加${section}`}>
                  <Icon name="plus-small" size="small" />
                </button>
              </div>
              <div class="company-channel-list">
                <For each={filtered().filter((channel) => channel.section === section)}>
                  {(channel) => (
                    <button
                      type="button"
                      class="company-channel"
                      classList={{ active: channel.id === props.active }}
                      onClick={() => props.onSelect(channel.id)}
                    >
                      <Show
                        when={channel.agent}
                        fallback={<Icon name={section === "公司" ? "folder" : "fork"} size="small" />}
                      >
                        {(agent) => <AgentAvatar id={agent()} size="small" />}
                      </Show>
                      <span class="company-channel-copy">
                        <span class="company-channel-name">{channel.name}</span>
                        <Show when={channel.preview}>
                          <span class="company-channel-preview">{channel.preview}</span>
                        </Show>
                      </span>
                      <Show when={channel.badge}>
                        {(badge) => <span class="company-channel-badge">{badge()}</span>}
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </div>
      <button type="button" class="company-switcher">
        <span class="company-switcher-mark">AC</span>
        <span>
          <strong>{data().company.name}</strong>
          <small>{data().company.versionLabel}</small>
        </span>
        <Icon name="chevron-down" size="small" />
      </button>
    </aside>
  )
}

function Message(props: { agent: string; time: string; children: JSX.Element; bubble?: boolean }) {
  const data = useCompanyData()
  const agent = () => data().agents[props.agent]
  return (
    <article class="company-message" classList={{ bubble: props.bubble }}>
      <AgentAvatar id={props.agent} size="large" />
      <div class="company-message-body">
        <header>
          <strong>{agent().name}</strong>
          <Show when={props.agent === data().currentUserAgentID}>
            <span>（你）</span>
          </Show>
          <time>{props.time}</time>
        </header>
        <div class="company-message-content">{props.children}</div>
      </div>
    </article>
  )
}

function CheckLine(props: { label: string; value: string }) {
  return (
    <li>
      <span class="company-check-icon">
        <Icon name="check-small" size="small" />
      </span>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </li>
  )
}

function ApprovalCard(props: { canApprove: boolean; onApprove: () => void; onEvidence: () => void }) {
  const data = useCompanyData()
  const delivery = () => data().delivery
  const approved = () => delivery().status === "approved"
  const requester = () => data().agents[delivery().requesterAgentID]

  return (
    <article class="company-approval" data-approved={approved() ? "true" : undefined}>
      <header class="company-approval-header">
        <span class="company-approval-symbol">
          <Icon name={approved() ? "circle-check" : "fork"} />
        </span>
        <h2>{approved() ? `已批准合并到 ${delivery().targetBranch}` : `准备合并到 ${delivery().targetBranch}`}</h2>
        <span class="company-approval-status">{approved() ? "已批准" : "需要批准"}</span>
      </header>
      <div class="company-approval-grid">
        <dl>
          <div>
            <dt>请求人</dt>
            <dd class="company-requester">
              <AgentAvatar id={delivery().requesterAgentID} size="small" /> {requester().name}
              <Show when={delivery().requesterAgentID === data().currentUserAgentID}>（你）</Show>
            </dd>
          </div>
          <div>
            <dt>影响仓库</dt>
            <dd>{delivery().repository}</dd>
          </div>
          <div>
            <dt>为什么现在</dt>
            <dd>{delivery().reason}</dd>
          </div>
        </dl>
        <dl>
          <div>
            <dt>风险评估</dt>
            <dd>{delivery().risk}</dd>
          </div>
          <div>
            <dt>可逆性</dt>
            <dd>{delivery().reversibility}</dd>
          </div>
          <div>
            <dt>验证摘要</dt>
            <dd class="company-inline-checks">
              <For each={delivery().checks}>
                {(check) => (
                  <span>
                    <Icon name="check-small" size="small" /> {check.label} {check.value}
                  </span>
                )}
              </For>
            </dd>
          </div>
        </dl>
      </div>
      <div class="company-approval-actions">
        <button
          type="button"
          class="company-primary-action"
          disabled={approved() || !props.canApprove}
          onClick={props.onApprove}
        >
          <Icon name={approved() ? "check" : "branch"} size="small" />
          {approved() ? "已批准" : "批准合并"}
        </button>
        <button type="button" class="company-secondary-action" onClick={props.onEvidence}>
          查看证据
        </button>
      </div>
      <div class="company-delivery-preview">
        <header class="company-delivery-header">
          <strong>交付验收</strong>
          <span>已通过</span>
        </header>
        <img src={delivery().previewImage} alt="交付验收界面预览" />
        <div class="company-delivery-checklist">
          <span class="company-delivery-label">验收清单</span>
          <ul>
            <For each={delivery().evidence}>{(item) => <CheckLine {...item} />}</For>
          </ul>
        </div>
        <div class="company-delivery-files">
          <span class="company-delivery-label">交付文件</span>
          <For each={delivery().files}>
            {(file) => (
              <button type="button">
                <Icon name="open-file" size="small" /> {file}
              </button>
            )}
          </For>
        </div>
      </div>
      <footer class="company-source-link">
        <button type="button" onClick={props.onEvidence}>
          <Icon name="models" size="small" /> {delivery().sourceLabel}
        </button>
        <button type="button" onClick={props.onEvidence}>
          查看完整 Thread <Icon name="arrow-right" size="small" />
        </button>
      </footer>
    </article>
  )
}

function Composer(props: { disabled: boolean; onSend: (value: string) => void }) {
  const [value, setValue] = createSignal("")

  function send() {
    const message = value().trim()
    if (props.disabled) return
    if (!message) return
    props.onSend(message)
    setValue("")
  }

  return (
    <div class="company-composer">
      <input
        value={value()}
        placeholder="发送消息"
        aria-label="发送消息"
        disabled={props.disabled}
        onInput={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return
          event.preventDefault()
          send()
        }}
      />
      <div class="company-composer-actions">
        <div>
          <button type="button" aria-label="添加附件" disabled={props.disabled}>
            <Icon name="plus" />
          </button>
          <button type="button" aria-label="提及成员" disabled={props.disabled}>
            @
          </button>
          <button type="button" aria-label="执行动作" disabled={props.disabled}>
            /
          </button>
        </div>
        <button
          type="button"
          class="company-send"
          aria-label="发送"
          disabled={props.disabled || !value().trim()}
          onClick={send}
        >
          <Icon name="arrow-up" />
        </button>
      </div>
    </div>
  )
}

function Conversation(props: {
  channelID: string
  canApprove: boolean
  canSend: boolean
  onApprove: () => void
  onToggleThread: () => void
  onSend: (value: string) => void
}) {
  const data = useCompanyData()
  const channel = createMemo(
    () =>
      data().channels.find((item) => item.id === props.channelID) ??
      data().channels.find((item) => item.id === data().featuredChannelID) ??
      data().channels[0],
  )
  const project = createMemo(() => channel().id === data().featuredChannelID)
  const approved = createMemo(() => data().delivery.status === "approved")

  return (
    <main class="company-conversation">
      <header class="company-conversation-header">
        <div class="company-title-copy">
          <div class="company-title-row">
            <h1>{channel().name}</h1>
            <Show when={project()}>
              <span class="company-title-status" data-approved={approved() ? "true" : undefined}>
                {approved() ? "已批准" : "需要批准"}
              </span>
            </Show>
          </div>
          <span>{project() ? data().featuredDescription : channel().preview}</span>
        </div>
        <div class="company-header-actions">
          <div class="company-participants" aria-label="参与者">
            <For each={data().participantAgentIDs}>{(agentID) => <AgentAvatar id={agentID} size="small" />}</For>
            <span>{data().participantCount}</span>
          </div>
          <button type="button" class="company-icon-button" aria-label="搜索会话">
            <Icon name="magnifying-glass" />
          </button>
          <button type="button" class="company-icon-button" aria-label="更多操作">
            <Icon name="dot-grid" />
          </button>
        </div>
      </header>
      <div class="company-feed">
        <Show
          when={project()}
          fallback={
            <div class="company-channel-placeholder">
              <Icon name={channel().section === "Direct" ? "speech-bubble" : "bubble-5"} size="large" />
              <h2>{channel().name}</h2>
              <p>{channel().preview ?? "这里还没有高信号更新。"}</p>
            </div>
          }
        >
          <div class="company-feed-date">{data().dateLabel}</div>
          <For each={data().messages}>
            {(message) => (
              <Message agent={message.agent} time={message.time} bubble={message.bubble}>
                <For each={message.body}>{(paragraph) => <p>{paragraph}</p>}</For>
              </Message>
            )}
          </For>
          <ApprovalCard canApprove={props.canApprove} onApprove={props.onApprove} onEvidence={props.onToggleThread} />
          <For each={data().userMessages}>
            {(message) => (
              <Message agent={data().currentUserAgentID} time="刚刚" bubble>
                <p>{message}</p>
              </Message>
            )}
          </For>
        </Show>
      </div>
      <Composer disabled={!props.canSend} onSend={props.onSend} />
    </main>
  )
}

function ThreadPanel(props: { onClose: () => void }) {
  const data = useCompanyData()
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})
  const approved = createMemo(() => data().delivery.status === "approved")

  return (
    <aside class="company-thread" aria-label={data().threadTitle}>
      <header class="company-thread-header">
        <strong>{data().threadTitle}</strong>
        <button type="button" class="company-icon-button" aria-label="关闭 Thread" onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div class="company-thread-scroll">
        <For each={data().threadEvents}>
          {(event) => {
            const agent = () => data().agents[event.agent]
            const open = () => expanded()[event.id]
            return (
              <article class="company-thread-event">
                <AgentAvatar id={event.agent} size="small" />
                <div>
                  <header>
                    <strong>{agent().name}</strong>
                    <time>{event.time}</time>
                  </header>
                  <p>{event.body}</p>
                  <Show when={event.detail}>
                    <button
                      type="button"
                      class="company-tool-row"
                      aria-expanded={open()}
                      onClick={() => setExpanded((current) => ({ ...current, [event.id]: !open() }))}
                    >
                      <Icon name={event.id.includes("test") ? "circle-check" : "chevron-down"} size="small" />
                      <span>{event.detail}</span>
                      <Show when={event.duration}>{(duration) => <small>{duration()}</small>}</Show>
                    </button>
                    <Show when={open()}>
                      <div class="company-tool-detail">执行完成，没有未处理的异常或警告。</div>
                    </Show>
                  </Show>
                </div>
              </article>
            )
          }}
        </For>
        <section class="company-final-decision">
          <span>最终决定</span>
          <strong>{approved() ? "已批准" : "需要批准"}</strong>
          <p>
            {approved()
              ? "合并授权已记录，正在进入主分支验证。"
              : `等待你的批准以合并到 ${data().delivery.targetBranch}。`}
          </p>
        </section>
      </div>
    </aside>
  )
}

function CompanyLiveWorkspace(props: {
  snapshot: Exclude<CompanyWorkspaceSnapshot, CompanyDemoSnapshot>
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
    return snapshot.status === "ready" ? (snapshot satisfies CompanyReadySnapshot) : undefined
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
      <Match when={ready()}>{(snapshot) => <CompanyReady snapshot={snapshot()} dataSource={props.dataSource} />}</Match>
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
  const initial = source.getSnapshot()
  const [snapshot, setSnapshot] = createSignal(initial)
  const [activeChannel, setActiveChannel] = createSignal(initial.status === "demo" ? initial.featuredChannelID : "")
  const [search, setSearch] = createSignal("")
  const [threadOpen, setThreadOpen] = createSignal(true)
  const [mobileChannelsOpen, setMobileChannelsOpen] = createSignal(false)
  const demo = createMemo(() => {
    const value = snapshot()
    return value.status === "demo" ? value : undefined
  })
  const state = createMemo<Exclude<CompanyWorkspaceSnapshot, CompanyDemoSnapshot>>(() => {
    const value = snapshot()
    if (value.status === "demo") return { status: "loading" }
    return value
  })

  onMount(() => {
    const unsubscribe = source.subscribe(setSnapshot)
    onCleanup(unsubscribe)
    void source.refresh()

    // Forward M2 conversation invalidation events to the data source
    const unsubEvent = source.handleEvent
      ? globalSDK.event.on("global", (event: Event) => {
          if (
            event.type === "company.channel.invalidated" ||
            event.type === "company.thread.invalidated" ||
            event.type === "company.conversation_run.updated"
          ) {
            source.handleEvent?.(event)
          }
        })
      : undefined
    if (unsubEvent) onCleanup(unsubEvent)
  })

  return (
    <Show
      when={demo()}
      fallback={
        <CompanyLiveWorkspace
          snapshot={state()}
          dataSource={source}
          serverUrl={server.current?.http.url ?? ""}
          onRefresh={() => void source.refresh()}
        />
      }
    >
      {(data) => (
        <CompanyDataContext.Provider value={data}>
          <div class="company-workspace" data-thread-open={threadOpen() ? "true" : "false"} data-state="demo">
            <CompanyRail onMessages={() => setMobileChannelsOpen((current) => !current)} />
            <Show when={mobileChannelsOpen()}>
              <button
                type="button"
                class="company-mobile-scrim"
                aria-label="关闭频道列表"
                onClick={() => setMobileChannelsOpen(false)}
              />
            </Show>
            <ChannelSidebar
              active={activeChannel()}
              search={search()}
              mobileOpen={mobileChannelsOpen()}
              onSearch={setSearch}
              onSelect={(channel) => {
                setActiveChannel(channel)
                setMobileChannelsOpen(false)
              }}
            />
            <Conversation
              channelID={activeChannel()}
              canApprove={source.approveDelivery !== undefined}
              canSend={source.sendMessage !== undefined}
              onApprove={() => void source.approveDelivery?.({ deliveryID: data().delivery.id })}
              onToggleThread={() => setThreadOpen(true)}
              onSend={(body) => void source.sendMessage?.({ channelID: activeChannel(), body })}
            />
            <Show when={threadOpen()}>
              <ThreadPanel onClose={() => setThreadOpen(false)} />
            </Show>
          </div>
        </CompanyDataContext.Provider>
      )}
    </Show>
  )
}
