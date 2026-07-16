import { For, Show, createMemo, type Accessor } from "solid-js"
import type {
  CompanyReadyWorkspaceSnapshot,
  ConversationMessageItem,
  ConversationThreadDetail,
  ConversationThreadEntryItem,
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

function latestEntry(entries: ConversationThreadEntryItem[]) {
  return entries.at(0)
}

function entryBody(entry: ConversationThreadEntryItem | undefined) {
  if (!entry) return undefined
  return entry.message.body
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
}) {
  const members = createMemo(() => props.members().slice(0, 4))
  const agentEntries = createMemo(() => props.entries().filter((entry) => entry.type === "agent_message"))
  const latestUserMessage = createMemo(() => props.messages().find((message) => message.author.kind === "user"))
  const runState = createMemo(() => props.thread()?.run?.state)
  const running = createMemo(
    () => props.thread()?.status === "active" && ["queued", "running", "projecting"].includes(runState() ?? ""),
  )
  const completed = createMemo(() => props.thread()?.status === "completed" || runState() === "completed")
  const failed = createMemo(() => runState() === "failed")
  const active = createMemo(() => {
    if (!running() || members().length === 0) return -1
    const last = agentEntries().at(0)
    const exact = last ? members().findIndex((member) => member.id === last.message.agentID) : -1
    if (exact >= 0) return exact
    return agentEntries().length % members().length
  })
  const currentSpeech = createMemo(
    () =>
      entryBody(latestEntry(props.entries())) ??
      latestUserMessage()?.body ??
      "提交一个议题后，董事会成员会按顺序讨论并收敛决策。",
  )
  const round = createMemo(() => agentEntries().at(0)?.message.roundNum ?? 0)
  const progress = createMemo(
    () =>
      new Set(
        props.entries().flatMap((entry) => {
          if (entry.type === "agent_message") return [entry.message.agentID]
          if (entry.message.author.kind === "agent") return [entry.message.author.id]
          return []
        }),
      ).size,
  )

  return (
    <section class="company-board" aria-label="董事会圆桌会议" data-running={running() ? "true" : "false"}>
      <div class="company-board-meta">
        <span class="company-board-status" data-running={running() ? "true" : "false"}>
          <span aria-hidden="true" />
          {running() ? "执行中" : completed() ? "已完成" : failed() ? "已失败" : "空闲中"}
        </span>
        <span>第 {round()} 轮</span>
        <span>
          {new Date(props.thread()?.time.updated ?? Date.now()).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>

      <div class="company-board-stage">
        <For each={members()}>
          {(member, index) => (
            <article
              class="company-board-member"
              data-slot={index()}
              data-active={active() === index() ? "true" : "false"}
            >
              <div class="company-board-avatar">
                <img src={ROLE_AVATAR[member.role] ?? FALLBACK_AVATARS[index() % FALLBACK_AVATARS.length]} alt="" />
              </div>
              <strong>{member.name}</strong>
              <span>{member.role}</span>
              <small data-active={active() === index() ? "true" : "false"}>
                <span aria-hidden="true" />
                {boardMemberStatus({
                  active: active() === index(),
                  running: running(),
                  completed: completed(),
                  failed: failed(),
                })}
              </small>
            </article>
          )}
        </For>

        <div class="company-board-agenda">
          <header>
            <strong>议题 · {props.thread()?.title ?? latestUserMessage()?.body ?? "等待新议题"}</strong>
            <span>{running() ? "执行中" : completed() ? "已完成" : failed() ? "已失败" : "待开始"}</span>
          </header>
          <p>{currentSpeech()}</p>
          <footer>
            <span>
              共识 {Math.min(progress(), members().length)} / {members().length}
            </span>
            <span>{props.thread()?.run?.state ?? "等待讨论"}</span>
          </footer>
        </div>
      </div>

      <Show when={members().length === 0}>
        <p class="company-board-empty">董事会成员配置尚未完成</p>
      </Show>
    </section>
  )
}
