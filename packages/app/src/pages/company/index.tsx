import { Avatar } from "@agents-company/ui/avatar"
import { Icon, type IconProps } from "@agents-company/ui/icon"
import { Mark } from "@agents-company/ui/logo"
import { For, Show, createMemo, createSignal } from "solid-js"
import { companyAgents, companyChannels, deliveryEvidence, deliveryFiles, threadEvents } from "./company-model"
import "./workspace.css"

type WorkspaceIcon = IconProps["name"]

const sections = ["公司", "项目", "Direct"] as const

function AgentAvatar(props: { id: keyof typeof companyAgents; size?: "small" | "normal" | "large"; class?: string }) {
  const agent = () => companyAgents[props.id]
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
        <AgentAvatar id="product-lead" size="small" />
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
  const filtered = createMemo(() => {
    const query = props.search.trim().toLowerCase()
    if (!query) return companyChannels
    return companyChannels.filter((channel) => `${channel.name} ${channel.preview ?? ""}`.toLowerCase().includes(query))
  })

  return (
    <aside class="company-channels" classList={{ "mobile-open": props.mobileOpen }} aria-label="频道">
      <div class="company-channels-header">
        <strong>Agent Company</strong>
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
          <strong>Agent Company</strong>
          <small>本地优先 · v1.0.0</small>
        </span>
        <Icon name="chevron-down" size="small" />
      </button>
    </aside>
  )
}

function Message(props: {
  agent: keyof typeof companyAgents
  time: string
  children: import("solid-js").JSX.Element
  bubble?: boolean
}) {
  const agent = () => companyAgents[props.agent]
  return (
    <article class="company-message" classList={{ bubble: props.bubble }}>
      <AgentAvatar id={props.agent} size="large" />
      <div class="company-message-body">
        <header>
          <strong>{agent().name}</strong>
          <Show when={props.agent === "product-lead"}>
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

function ApprovalCard(props: { approved: boolean; onApprove: () => void; onEvidence: () => void }) {
  return (
    <article class="company-approval" data-approved={props.approved ? "true" : undefined}>
      <header class="company-approval-header">
        <span class="company-approval-symbol">
          <Icon name={props.approved ? "circle-check" : "fork"} />
        </span>
        <h2>{props.approved ? "已批准合并到 main" : "准备合并到 main"}</h2>
        <span class="company-approval-status">{props.approved ? "已批准" : "需要批准"}</span>
      </header>
      <div class="company-approval-grid">
        <dl>
          <div>
            <dt>请求人</dt>
            <dd class="company-requester">
              <AgentAvatar id="product-lead" size="small" /> Product Lead（你）
            </dd>
          </div>
          <div>
            <dt>影响仓库</dt>
            <dd>agent-company/web</dd>
          </div>
          <div>
            <dt>为什么现在</dt>
            <dd>功能完整、验收通过，进入发布候选窗口。</dd>
          </div>
        </dl>
        <dl>
          <div>
            <dt>风险评估</dt>
            <dd>低（向后兼容，无破坏性变更）</dd>
          </div>
          <div>
            <dt>可逆性</dt>
            <dd>可回滚（回滚脚本已验证）</dd>
          </div>
          <div>
            <dt>验证摘要</dt>
            <dd class="company-inline-checks">
              <span>
                <Icon name="check-small" size="small" /> 测试通过 142/142
              </span>
              <span>
                <Icon name="check-small" size="small" /> 评审通过 2/2
              </span>
              <span>
                <Icon name="check-small" size="small" /> 构建通过 #1287
              </span>
            </dd>
          </div>
        </dl>
      </div>
      <div class="company-approval-actions">
        <button type="button" class="company-primary-action" disabled={props.approved} onClick={props.onApprove}>
          <Icon name={props.approved ? "check" : "branch"} size="small" />
          {props.approved ? "已批准" : "批准合并"}
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
        <img src="/assets/company/delivery-preview.png" alt="交付验收界面预览" />
        <div class="company-delivery-checklist">
          <span class="company-delivery-label">验收清单</span>
          <ul>
            <For each={deliveryEvidence}>{(item) => <CheckLine {...item} />}</For>
          </ul>
        </div>
        <div class="company-delivery-files">
          <span class="company-delivery-label">交付文件</span>
          <For each={deliveryFiles}>
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
          <Icon name="models" size="small" /> 来自 Thread · 交付验收
        </button>
        <button type="button" onClick={props.onEvidence}>
          查看完整 Thread <Icon name="arrow-right" size="small" />
        </button>
      </footer>
    </article>
  )
}

function Composer(props: { onSend: (value: string) => void }) {
  const [value, setValue] = createSignal("")

  function send() {
    const message = value().trim()
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
        onInput={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return
          event.preventDefault()
          send()
        }}
      />
      <div class="company-composer-actions">
        <div>
          <button type="button" aria-label="添加附件">
            <Icon name="plus" />
          </button>
          <button type="button" aria-label="提及成员">@</button>
          <button type="button" aria-label="执行动作">/</button>
        </div>
        <button type="button" class="company-send" aria-label="发送" disabled={!value().trim()} onClick={send}>
          <Icon name="arrow-up" />
        </button>
      </div>
    </div>
  )
}

function Conversation(props: {
  channelID: string
  approved: boolean
  userMessages: string[]
  onApprove: () => void
  onToggleThread: () => void
  onSend: (value: string) => void
}) {
  const channel = createMemo(() => companyChannels.find((item) => item.id === props.channelID) ?? companyChannels[2])
  const project = createMemo(() => channel().id === "pre-public-webui")

  return (
    <main class="company-conversation">
      <header class="company-conversation-header">
        <div class="company-title-copy">
          <div class="company-title-row">
            <h1>{channel().name}</h1>
            <Show when={project()}>
              <span class="company-title-status" data-approved={props.approved ? "true" : undefined}>
                {props.approved ? "已批准" : "需要批准"}
              </span>
            </Show>
          </div>
          <span>{project() ? "Pre-public Web UI for the agent company OS" : channel().preview}</span>
        </div>
        <div class="company-header-actions">
          <div class="company-participants" aria-label="参与者">
            <AgentAvatar id="ui-implementer" size="small" />
            <AgentAvatar id="backend-engineer" size="small" />
            <AgentAvatar id="qa-agent" size="small" />
            <span>8</span>
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
          <div class="company-feed-date">2026年7月13日</div>
          <Message agent="product-lead" time="今天 10:28" bubble>
            <p>各位，Pre-Public WebUI 的实现已完成，所有验收项通过，准备合并到 main。</p>
            <p>请查阅交付物与证据，如无异议请批准合并。</p>
          </Message>
          <Message agent="ui-implementer" time="今天 10:31">
            <p>前端已完成全部需求与响应式适配，组件库更新完毕，文档与 Storybook 已同步。</p>
            <p>验证清单全绿，建议合并。</p>
          </Message>
          <Message agent="backend-engineer" time="今天 10:33">
            <p>后端接口、权限与审计日志已实现并通过测试。</p>
            <p>回滚脚本与数据兼容处理已验证，风险可控。</p>
          </Message>
          <ApprovalCard approved={props.approved} onApprove={props.onApprove} onEvidence={props.onToggleThread} />
          <For each={props.userMessages}>
            {(message) => (
              <Message agent="product-lead" time="刚刚" bubble>
                <p>{message}</p>
              </Message>
            )}
          </For>
        </Show>
      </div>
      <Composer onSend={props.onSend} />
    </main>
  )
}

function ThreadPanel(props: { approved: boolean; onClose: () => void }) {
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})

  return (
    <aside class="company-thread" aria-label="交付验收 Thread">
      <header class="company-thread-header">
        <strong>来自 Thread · 交付验收</strong>
        <button type="button" class="company-icon-button" aria-label="关闭 Thread" onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div class="company-thread-scroll">
        <For each={threadEvents}>
          {(event) => {
            const agent = () => companyAgents[event.agent]
            const open = () => !!expanded()[event.id]
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
                      <Show when={event.duration}>
                        {(duration) => <small>{duration()}</small>}
                      </Show>
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
          <strong>{props.approved ? "已批准" : "需要批准"}</strong>
          <p>{props.approved ? "合并授权已记录，正在进入主分支验证。" : "等待你的批准以合并到 main。"}</p>
        </section>
      </div>
    </aside>
  )
}

export default function CompanyWorkspace() {
  const [activeChannel, setActiveChannel] = createSignal("pre-public-webui")
  const [search, setSearch] = createSignal("")
  const [threadOpen, setThreadOpen] = createSignal(true)
  const [approved, setApproved] = createSignal(false)
  const [userMessages, setUserMessages] = createSignal<string[]>([])
  const [mobileChannelsOpen, setMobileChannelsOpen] = createSignal(false)

  return (
    <div class="company-workspace" data-thread-open={threadOpen() ? "true" : "false"}>
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
        approved={approved()}
        userMessages={userMessages()}
        onApprove={() => setApproved(true)}
        onToggleThread={() => setThreadOpen(true)}
        onSend={(message) => setUserMessages((current) => [...current, message])}
      />
      <Show when={threadOpen()}>
        <ThreadPanel approved={approved()} onClose={() => setThreadOpen(false)} />
      </Show>
    </div>
  )
}
