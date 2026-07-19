import { Icon } from "@agents-company/ui/icon"
import { Markdown } from "@agents-company/ui/markdown"
import { For, Show, createEffect, createMemo, type Accessor } from "solid-js"
import type {
  CompanyProjectExecutionState,
  CompanyProjectGate,
  CompanyProjectWorkItem,
  CompanyReadyWorkspaceSnapshot,
  ConversationMessageItem,
  ConversationThreadDetail,
  ConversationThreadEntryItem,
  SignalType,
} from "./company-model"

const ROLE_AVATAR: Record<string, string> = {
  ceo: "/assets/company/product-lead.png",
  cto: "/assets/company/backend-engineer.png",
  product_lead: "/assets/company/ui-implementer.png",
  qa: "/assets/company/qa-agent.png",
}

const FALLBACK_AVATARS = [
  "/assets/company/product-lead.png",
  "/assets/company/backend-engineer.png",
  "/assets/company/ui-implementer.png",
  "/assets/company/qa-agent.png",
] as const

const PROJECT_AGENT: Record<string, { name: string; role: string; avatar: string }> = {
  "board-ceo": { name: "CEO", role: "董事会终审", avatar: "/assets/company/product-lead.png" },
  "project-lead": { name: "项目负责人", role: "Project Lead", avatar: "/assets/company/product-lead.png" },
  "market-researcher": { name: "市场研究员", role: "Research", avatar: "/assets/company/research-analyst.png" },
  "product-strategist": { name: "产品策略师", role: "Product", avatar: "/assets/company/ui-implementer.png" },
  "game-product-strategist": { name: "产品策略师", role: "Product", avatar: "/assets/company/ui-implementer.png" },
  "technical-researcher": { name: "技术研究员", role: "Engineering", avatar: "/assets/company/backend-engineer.png" },
  "product-manager": { name: "产品经理", role: "PM", avatar: "/assets/company/product-lead.png" },
  "software-architect": { name: "软件架构师", role: "Architecture", avatar: "/assets/company/backend-engineer.png" },
  "qa-engineer": { name: "QA 工程师", role: "Quality", avatar: "/assets/company/qa-agent.png" },
  "mvp-developer": { name: "开发负责人", role: "Engineering", avatar: "/assets/company/backend-engineer.png" },
  "repair-engineer": { name: "修复工程师", role: "Engineering", avatar: "/assets/company/backend-engineer.png" },
}

type BoardMember = CompanyReadyWorkspaceSnapshot["company"]["board"][number]

export type BoardChatItem = {
  id: string
  authorKind: "user" | "agent" | "system"
  authorID: string
  authorName: string
  role: string
  body: string
  created: number
  avatar?: string
  signalType?: SignalType
}

export type ProjectChatItem =
  | { type: "work_item"; id: string; created: number; item: CompanyProjectWorkItem }
  | { type: "gate"; id: string; created: number; gate: CompanyProjectGate }

export function projectChatItems(project: CompanyProjectExecutionState) {
  return [
    ...project.work_items.map(
      (item): ProjectChatItem => ({ type: "work_item", id: item.id, created: item.created_at, item }),
    ),
    ...project.gates.map(
      (gate): ProjectChatItem => ({ type: "gate", id: gate.id, created: gate.requested_at, gate }),
    ),
  ].sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))
}

function memberFor(authorID: string, members: BoardMember[]) {
  return members.find((member) => member.id === authorID || member.role === authorID)
}

function fromMessage(message: ConversationMessageItem, members: BoardMember[]): BoardChatItem {
  const member = message.author.kind === "agent" ? memberFor(message.author.id, members) : undefined
  return {
    id: message.id,
    authorKind: message.author.kind,
    authorID: message.author.id,
    authorName: message.author.kind === "user" ? "你" : member?.name ?? (message.author.kind === "system" ? "系统" : message.author.id),
    role: message.author.kind === "user" ? "Owner" : member?.role ?? message.author.kind,
    body: message.body,
    created: message.time.created,
    avatar: member ? ROLE_AVATAR[member.role] : undefined,
    signalType: message.signalType,
  }
}

export function boardChatItems(
  entries: ConversationThreadEntryItem[],
  messages: ConversationMessageItem[],
  members: BoardMember[],
) {
  const items = entries.length
    ? entries.map((entry): BoardChatItem => {
        if (entry.type === "message") return fromMessage(entry.message, members)
        const member = memberFor(entry.message.agentID, members)
        return {
          id: entry.message.id,
          authorKind: "agent",
          authorID: entry.message.agentID,
          authorName: member?.name ?? entry.message.agentID,
          role: member?.role ?? "agent",
          body: entry.message.body,
          created: entry.message.time.created,
          avatar: member ? ROLE_AVATAR[member.role] : undefined,
        }
      })
    : messages.map((message) => fromMessage(message, members))

  return [...new Map(items.map((item) => [item.id, item])).values()].sort(
    (a, b) => a.created - b.created || a.id.localeCompare(b.id),
  )
}

function timeLabel(created: number) {
  return new Date(created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function dateLabel(created: number) {
  return new Date(created).toLocaleDateString([], { month: "numeric", day: "numeric" })
}

function sameDay(left: number, right: number) {
  const a = new Date(left)
  const b = new Date(right)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function projectStatusLabel(status: CompanyProjectExecutionState["project"]["status"]) {
  if (status === "researching") return "立项调研中"
  if (status === "awaiting_project_approval") return "等待董事会批准立项"
  if (status === "planning") return "组建团队与拆解任务"
  if (status === "awaiting_development_approval") return "等待批准开始执行"
  if (status === "developing") return "任务执行中"
  if (status === "verifying") return "董事会终审中"
  if (status === "completed") return "评审通过，已交付"
  if (status === "blocked") return "执行受阻"
  if (status === "rejected") return "项目已驳回"
  return "准备中"
}

function workStatusLabel(status: CompanyProjectWorkItem["status"]) {
  if (status === "running") return "进行中"
  if (status === "completed") return "已完成"
  if (status === "blocked") return "已阻塞"
  if (status === "failed") return "失败"
  if (status === "cancelled") return "已取消"
  return "等待前置任务"
}

function gateActionLabel(kind: CompanyProjectGate["kind"]) {
  if (kind === "project_approval") return "董事会批准立项"
  if (kind === "development_approval") return "批准团队开始执行"
  return "批准交付并合并"
}

function projectAgent(agentID?: string) {
  if (!agentID) return { name: "Agent Company", role: "System", avatar: "/assets/company/product-lead.png" }
  return PROJECT_AGENT[agentID] ?? {
    name: agentID,
    role: "Agent",
    avatar: "/assets/company/product-lead.png",
  }
}

export function boardMemberStatus(state: { active: boolean; running: boolean; completed: boolean; failed: boolean }) {
  if (state.active) return "发言中"
  if (state.completed) return "已完成"
  if (state.failed) return "已结束"
  if (state.running) return "倾听中"
  return "待命中"
}

export function BoardRoundtable(props: {
  members: Accessor<CompanyReadyWorkspaceSnapshot["company"]["board"]>
  thread: Accessor<ConversationThreadDetail | null>
  entries: Accessor<ConversationThreadEntryItem[]>
  messages: Accessor<ConversationMessageItem[]>
  project: Accessor<CompanyProjectExecutionState | null>
  projectBusy: Accessor<boolean>
  projectError: Accessor<string | null>
  onStartProject: () => void
  onRetryProject: () => void
  onCancelProject: () => void
  retryModels: Accessor<Array<{ provider_id: string; model_id: string; label: string }>>
  retryModelValue: Accessor<string>
  onRetryModelChange: (value: string) => void
  onResolveGate: (gateID: string, decision: "approve" | "reject") => void
  onOpenThread?: (threadID: string) => void
}) {
  const members = createMemo(() => props.members().slice(0, 4))
  const timeline = createMemo(() => boardChatItems(props.entries(), props.messages(), members()))
  const runState = createMemo(() => props.thread()?.run?.state)
  const running = createMemo(
    () => props.thread()?.status === "active" && ["queued", "running", "projecting"].includes(runState() ?? ""),
  )
  const completed = createMemo(() => props.thread()?.status === "completed" || runState() === "completed")
  const failed = createMemo(() => runState() === "failed")
  const projectTimeline = createMemo(() => (props.project() ? projectChatItems(props.project()!) : []))
  const projectTeamSize = createMemo(
    () => new Set(props.project()?.work_items.map((item) => item.owner_agent_id).filter(Boolean)).size,
  )
  const activeAgentID = createMemo(() => {
    if (!running()) return undefined
    return props.entries().find((entry) => entry.type === "agent_message")?.message.agentID
  })
  let feed: HTMLDivElement | undefined

  createEffect(() => {
    const latestID = projectTimeline().at(-1)?.id ?? timeline().at(-1)?.id
    const projectStatus = props.project()?.project.status
    if (!latestID && !projectStatus) return
    queueMicrotask(() => {
      if (feed) feed.scrollTop = feed.scrollHeight
    })
  })

  return (
    <section class="company-board" aria-label="董事会圆桌会议" data-running={running() ? "true" : "false"}>
      <header class="company-board-chat-header">
        <div class="company-board-topic">
          <div>
            <strong>{props.thread()?.title ?? "董事会群聊"}</strong>
            <span class="company-board-status" data-running={running() ? "true" : "false"}>
              <span aria-hidden="true" />
              {running() ? "讨论中" : completed() ? "已完成" : failed() ? "已失败" : "待开始"}
            </span>
          </div>
          <p>
            {members()
              .map((member) => `${member.name} · ${member.responsibilities.at(0) ?? member.role}`)
              .join("  /  ")}
          </p>
        </div>
        <div class="company-board-participants" aria-label={`${members().length + 1} 位参与者`}>
          <For each={members()}>
            {(member, index) => (
              <span
                class="company-board-participant"
                data-active={activeAgentID() === member.id ? "true" : "false"}
                title={`${member.name} · ${boardMemberStatus({
                  active: activeAgentID() === member.id,
                  running: running(),
                  completed: completed(),
                  failed: failed(),
                })}`}
              >
                <img src={ROLE_AVATAR[member.role] ?? FALLBACK_AVATARS[index() % FALLBACK_AVATARS.length]} alt="" />
              </span>
            )}
          </For>
          <span class="company-board-participant company-board-owner" title="你 · Owner">你</span>
          <Show when={projectTeamSize() > 0}>
            <span class="company-board-team-count" title={`${projectTeamSize()} 位项目成员`}>
              +{projectTeamSize()}
            </span>
          </Show>
        </div>
      </header>

      <div ref={feed} class="company-board-feed" role="log" aria-live="polite">
        <Show
          when={timeline().length > 0}
          fallback={
            <div class="company-board-empty">
              <strong>向董事会提出一个目标</strong>
              <p>CEO、CTO 与 Product Lead 会在这里公开讨论、组队和评审。</p>
            </div>
          }
        >
          <For each={timeline()}>
            {(item, index) => (
              <>
                <Show when={index() === 0 || !sameDay(timeline()[index() - 1].created, item.created)}>
                  <div class="company-board-date"><span>{dateLabel(item.created)}</span></div>
                </Show>
                <article
                  class="company-board-message"
                  classList={{
                    "is-user": item.authorKind === "user",
                    "is-signal": Boolean(item.signalType),
                    "is-system": item.authorKind === "system",
                  }}
                  data-author={item.authorID}
                >
                  <div class="company-board-message-avatar" aria-hidden="true">
                    <Show when={item.avatar} fallback={<span>{item.authorKind === "user" ? "你" : item.authorName.slice(0, 1)}</span>}>
                      {(avatar) => <img src={avatar()} alt="" />}
                    </Show>
                  </div>
                  <div class="company-board-message-main">
                    <header>
                      <strong>{item.authorName}</strong>
                      <span>{item.role}</span>
                      <Show when={item.signalType}>
                        <span class="company-board-message-signal">董事会结论</span>
                      </Show>
                      <time>{timeLabel(item.created)}</time>
                    </header>
                    <div class="company-board-message-card">
                      <Markdown text={item.body} cacheKey={item.id} />
                    </div>
                    <Show when={item.signalType && props.thread()?.id && props.onOpenThread}>
                      <button
                        type="button"
                        class="company-board-thread-link"
                        onClick={() => props.onOpenThread?.(props.thread()!.id)}
                      >
                        <Icon name="models" size="small" />
                        查看工作日志与依据
                      </button>
                    </Show>
                  </div>
                </article>
              </>
            )}
          </For>
        </Show>

        <Show when={running()}>
          <div class="company-board-typing" role="status">
            <span aria-hidden="true"><i /><i /><i /></span>
            董事会正在形成下一步
          </div>
        </Show>

        <Show when={completed() && !props.project()}>
          <article class="company-board-message company-project-action-message">
            <div class="company-board-message-avatar" aria-hidden="true">
              <img src="/assets/company/product-lead.png" alt="" />
            </div>
            <div class="company-board-message-main">
              <header>
                <strong>项目负责人</strong>
                <span>Project Lead</span>
                <time>{timeLabel(Date.now())}</time>
              </header>
              <div class="company-board-message-card company-project-action-card">
                <strong>董事会结论已经具备执行条件</strong>
                <p>进入执行后会创建项目章程、组建临时团队、拆分可验收任务，并在关键节点回到群里申请批准。</p>
                <button type="button" disabled={props.projectBusy()} onClick={props.onStartProject}>
                  <Icon name="arrow-right" size="small" />
                  {props.projectBusy() ? "正在创建项目…" : "进入执行并组建团队"}
                </button>
              </div>
            </div>
          </article>
        </Show>

        <Show when={props.project()}>
          {(project) => (
            <>
              <div class="company-board-date company-project-phase"><span>项目执行</span></div>
              <article class="company-board-message company-project-summary-message">
                <div class="company-board-message-avatar" aria-hidden="true">
                  <img src="/assets/company/product-lead.png" alt="" />
                </div>
                <div class="company-board-message-main">
                  <header>
                    <strong>项目负责人</strong>
                    <span>Project Lead</span>
                    <span class="company-project-state" data-status={project().project.status}>
                      {projectStatusLabel(project().project.status)}
                    </span>
                    <time>{timeLabel(project().project.created_at)}</time>
                  </header>
                  <div class="company-board-message-card company-project-summary-card">
                    <strong>{project().project.title}</strong>
                    <p>{project().project.goal}</p>
                    <Show when={project().project.provider_id && project().project.model_id}>
                      <span class="company-project-model">
                        {project().project.provider_id} / {project().project.model_id}
                      </span>
                    </Show>
                    <Show when={project().project.active_run_id}>
                      <button
                        type="button"
                        class="company-project-cancel"
                        disabled={props.projectBusy()}
                        onClick={props.onCancelProject}
                      >
                        <Icon name="stop" size="small" />
                        {props.projectBusy() ? "正在停止…" : "停止本轮执行"}
                      </button>
                    </Show>
                    <Show when={project().charter}>
                      {(charter) => (
                        <div class="company-project-charter">
                          <span>成功标准</span>
                          <ul>
                            <For each={charter().success_criteria}>{(item) => <li>{item}</li>}</For>
                          </ul>
                        </div>
                      )}
                    </Show>
                  </div>
                </div>
              </article>

              <For each={projectTimeline()}>
                {(entry) => {
                  const agent = () => projectAgent(entry.type === "work_item" ? entry.item.owner_agent_id : entry.gate.requested_by_agent_id)
                  return (
                    <article
                      class="company-board-message company-project-entry"
                      data-project-entry={entry.type}
                      data-status={entry.type === "work_item" ? entry.item.status : entry.gate.status}
                    >
                      <div class="company-board-message-avatar" aria-hidden="true">
                        <img src={agent().avatar} alt="" />
                      </div>
                      <div class="company-board-message-main">
                        <header>
                          <strong>{agent().name}</strong>
                          <span>{agent().role}</span>
                          <time>{timeLabel(entry.created)}</time>
                        </header>
                        <Show
                          when={entry.type === "work_item" ? entry.item : undefined}
                          fallback={
                            <div class="company-board-message-card company-project-gate-card">
                              <div class="company-project-entry-title">
                                <strong>{entry.type === "gate" ? entry.gate.title : "审批"}</strong>
                                <span data-status={entry.type === "gate" ? entry.gate.status : undefined}>
                                  {entry.type === "gate" && entry.gate.status === "pending"
                                    ? "待审批"
                                    : entry.type === "gate" && entry.gate.status === "approved"
                                      ? "已批准"
                                      : "已驳回"}
                                </span>
                              </div>
                              <Show when={entry.type === "gate"}>
                                <Markdown text={entry.type === "gate" ? entry.gate.summary : ""} cacheKey={entry.id} />
                              </Show>
                              <Show when={entry.type === "gate" && entry.gate.status === "pending"}>
                                <div class="company-project-gate-actions">
                                  <button
                                    type="button"
                                    disabled={props.projectBusy()}
                                    onClick={() => entry.type === "gate" && props.onResolveGate(entry.gate.id, "approve")}
                                  >
                                    {entry.type === "gate" ? gateActionLabel(entry.gate.kind) : "批准"}
                                  </button>
                                  <button
                                    type="button"
                                    class="secondary"
                                    disabled={props.projectBusy()}
                                    onClick={() => entry.type === "gate" && props.onResolveGate(entry.gate.id, "reject")}
                                  >
                                    驳回
                                  </button>
                                </div>
                              </Show>
                            </div>
                          }
                        >
                          {(item) => (
                            <div class="company-board-message-card company-project-work-card">
                              <div class="company-project-entry-title">
                                <strong>{item().title}</strong>
                                <span data-status={item().status}>{workStatusLabel(item().status)}</span>
                              </div>
                              <p>{item().description}</p>
                              <Show when={item().error}><p class="company-project-error">{item().error}</p></Show>
                              <Show when={project().artifacts.some((artifact) => artifact.work_item_id === item().id)}>
                                <div class="company-project-artifacts">
                                  <For each={project().artifacts.filter((artifact) => artifact.work_item_id === item().id)}>
                                    {(artifact) => <span><Icon name="folder" size="small" />{artifact.title}</span>}
                                  </For>
                                </div>
                              </Show>
                            </div>
                          )}
                        </Show>
                      </div>
                    </article>
                  )
                }}
              </For>

              <Show when={project().project.status === "blocked"}>
                <article class="company-board-message company-project-action-message">
                  <div class="company-board-message-avatar" aria-hidden="true">
                    <img src="/assets/company/product-lead.png" alt="" />
                  </div>
                  <div class="company-board-message-main">
                    <header>
                      <strong>项目负责人</strong>
                      <span>Project Lead</span>
                      <time>{timeLabel(project().project.updated_at)}</time>
                    </header>
                    <div class="company-board-message-card company-project-action-card">
                      <strong>本轮执行已停止</strong>
                      <p>可以保留失败记录、已批准计划和现有仓库，并使用当前可用模型继续执行。</p>
                      <label class="company-project-retry-model">
                        <span>执行模型</span>
                        <select
                          value={props.retryModelValue()}
                          onChange={(event) => props.onRetryModelChange(event.currentTarget.value)}
                        >
                          <option value="">自动选择未失败模型</option>
                          <For each={props.retryModels()}>
                            {(model) => (
                              <option value={`${model.provider_id}:${model.model_id}`}>{model.label}</option>
                            )}
                          </For>
                        </select>
                      </label>
                      <button type="button" disabled={props.projectBusy()} onClick={props.onRetryProject}>
                        <Icon name="reset" size="small" />
                        {props.projectBusy() ? "正在重试…" : "更换可用模型重试"}
                      </button>
                    </div>
                  </div>
                </article>
              </Show>
            </>
          )}
        </Show>

        <Show when={props.projectError()}>
          <div class="company-project-inline-error" role="alert">{props.projectError()}</div>
        </Show>
      </div>
    </section>
  )
}
