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

const BOARD_FEED_NEAR_BOTTOM_PX = 48

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

export function projectResumeDescription(project: CompanyProjectExecutionState) {
  if (project.work_items.some((item) => item.work_type === "coding"))
    return "可以保留任务树、失败 Attempt、现有工作树与验证证据，并使用当前可用模型继续执行。"
  if (project.work_items.some((item) => item.kind === "worker" || item.kind === "reviewer"))
    return "可以保留任务树、失败 Attempt 和已接受产出，并从阻塞节点继续执行。"
  return "可以保留 Charter 和规划失败记录，重新生成动态任务树。"
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

export function latestExecutionProposal(items: BoardChatItem[]) {
  return items.findLast((item) => item.authorKind === "agent" && item.signalType === "plan")
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
  if (status === "planning") return "形成 Charter 与动态任务树"
  if (status === "executing") return "任务执行中"
  if (status === "reviewing") return "独立复核中"
  if (status === "awaiting_approval") return "等待高风险或合并审批"
  if (status === "completed") return "评审通过，已交付"
  if (status === "blocked") return "执行受阻"
  if (status === "rejected") return "项目已驳回"
  return "准备中"
}

function gateActionLabel(kind: CompanyProjectGate["kind"]) {
  if (kind === "risk_approval") return "批准高风险操作"
  return "批准交付并合并"
}

function projectAgent(agentID?: string) {
  if (!agentID) return { name: "Agent Company", role: "System", avatar: "/assets/company/product-lead.png" }
  return {
    name: agentID,
    role: "Dynamic role",
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

export function shouldAutoScrollBoardFeed(input: {
  initialized: boolean
  contentChanged: boolean
  wasNearBottom: boolean
}) {
  if (!input.contentChanged) return false
  if (!input.initialized) return true
  return input.wasNearBottom
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
  onOpenProject: () => void
}) {
  const members = createMemo(() => props.members().slice(0, 4))
  const timeline = createMemo(() => boardChatItems(props.entries(), props.messages(), members()))
  const executionProposal = createMemo(() => latestExecutionProposal(timeline()))
  const runState = createMemo(() => props.thread()?.run?.state)
  const running = createMemo(
    () => props.thread()?.status === "active" && ["queued", "running", "projecting"].includes(runState() ?? ""),
  )
  const completed = createMemo(() => props.thread()?.status === "completed")
  const awaitingNextMessage = createMemo(() => props.thread()?.status === "active" && runState() === "completed")
  const failed = createMemo(() => runState() === "failed")
  const projectTeamSize = createMemo(
    () => new Set(props.project()?.work_items.map((item) => item.owner_agent_id).filter(Boolean)).size,
  )
  const activeAgentID = createMemo(() => {
    if (!running()) return undefined
    return props.entries().find((entry) => entry.type === "agent_message")?.message.agentID
  })
  let feed: HTMLDivElement | undefined
  let feedContentKey: string | undefined
  let feedWasNearBottom = true

  createEffect(() => {
    const latestConversationID = timeline().at(-1)?.id
    const project = props.project()
    if (!latestConversationID && !project) return
    const nextContentKey = `${latestConversationID ?? ""}:${JSON.stringify(project)}`
    const shouldScroll = shouldAutoScrollBoardFeed({
      initialized: feedContentKey !== undefined,
      contentChanged: nextContentKey !== feedContentKey,
      wasNearBottom: feedWasNearBottom,
    })
    feedContentKey = nextContentKey
    if (!shouldScroll) return
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
              {running() ? "讨论中" : failed() ? "已失败" : awaitingNextMessage() ? "可继续对话" : completed() ? "已完成" : "待开始"}
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
            <button
              type="button"
              class="company-board-team-link"
              aria-label={`打开项目团队，共 ${projectTeamSize()} 位成员`}
              onClick={props.onOpenProject}
            >
              <Icon name="folder" size="small" />
              项目团队 {projectTeamSize()}
            </button>
          </Show>
        </div>
      </header>

      <div
        ref={feed}
        class="company-board-feed"
        role="log"
        aria-live="polite"
        onScroll={() => {
          if (!feed) return
          feedWasNearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight <= BOARD_FEED_NEAR_BOTTOM_PX
        }}
      >
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

        <Show when={executionProposal()} keyed>
          {(proposal) => (
            <Show when={!props.project()}>
              <article class="company-board-message company-project-action-message">
                <div class="company-board-message-avatar" aria-hidden="true">
                  <Show when={proposal.avatar} fallback={<span>{proposal.authorName.slice(0, 1)}</span>}>
                    {(avatar) => <img src={avatar()} alt="" />}
                  </Show>
                </div>
                <div class="company-board-message-main">
                  <header>
                    <strong>{proposal.authorName}</strong>
                    <span>{proposal.role}</span>
                    <time>{timeLabel(proposal.created)}</time>
                  </header>
                  <div class="company-board-message-card company-project-action-card">
                    <strong>董事会提出了执行提案</strong>
                    <p>这是可选提案，不会自动启动项目；你可以继续讨论，或基于此提案创建项目。</p>
                    <button type="button" disabled={props.projectBusy()} onClick={props.onStartProject}>
                      <Icon name="arrow-right" size="small" />
                      {props.projectBusy() ? "正在创建项目…" : "基于此提案创建项目"}
                    </button>
                  </div>
                </div>
              </article>
            </Show>
          )}
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
                    <button type="button" class="company-project-open" onClick={props.onOpenProject}>
                      <Icon name="folder" size="small" />
                      打开项目室
                    </button>
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

              <For each={project().gates}>
                {(gate) => {
                  const agent = () => projectAgent(gate.requested_by_agent_id)
                  return (
                    <article
                      class="company-board-message company-project-entry"
                      data-project-entry="gate"
                      data-status={gate.status}
                    >
                      <div class="company-board-message-avatar" aria-hidden="true">
                        <img src={agent().avatar} alt="" />
                      </div>
                      <div class="company-board-message-main">
                        <header>
                          <strong>{agent().name}</strong>
                          <span>{agent().role}</span>
                          <time>{timeLabel(gate.requested_at)}</time>
                        </header>
                        <div class="company-board-message-card company-project-gate-card">
                          <div class="company-project-entry-title">
                            <strong>{gate.title}</strong>
                            <span data-status={gate.status}>
                              {gate.status === "pending" ? "待审批" : gate.status === "approved" ? "已批准" : "已驳回"}
                            </span>
                          </div>
                          <Markdown text={gate.summary} cacheKey={gate.id} />
                          <Show when={gate.status === "pending"}>
                            <div class="company-project-gate-actions">
                              <button
                                type="button"
                                disabled={props.projectBusy()}
                                onClick={() => props.onResolveGate(gate.id, "approve")}
                              >
                                {gateActionLabel(gate.kind)}
                              </button>
                              <button
                                type="button"
                                class="secondary"
                                disabled={props.projectBusy()}
                                onClick={() => props.onResolveGate(gate.id, "reject")}
                              >
                                驳回
                              </button>
                            </div>
                          </Show>
                        </div>
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
                      <p>{projectResumeDescription(project())}</p>
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
