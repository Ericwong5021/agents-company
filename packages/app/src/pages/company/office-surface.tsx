import { createMemo, type Accessor } from "solid-js"
import type { CompanyReadyWorkspaceSnapshot, ConversationSnapshot, ConversationThreadDetail } from "./company-model"

function statusLabel(status: ConversationThreadDetail | null) {
  if (!status) return "空闲中"
  if (status.run?.state === "completed") return "已完成"
  if (status.run?.state === "failed") return "已失败"
  if (status.run?.state === "interrupted") return "已中断"
  if (status.status === "completed") return "已完成"
  if (status.status === "interrupted") return "已中断"
  return "进行中"
}

export function OfficeSurface(props: {
  snapshot: Accessor<CompanyReadyWorkspaceSnapshot>
  conversation: Accessor<ConversationSnapshot>
}) {
  const thread = createMemo(() => props.conversation().thread)
  const running = createMemo(() =>
    thread()?.status === "active" && ["queued", "running", "projecting"].includes(thread()?.run?.state ?? "") ? 1 : 0,
  )
  const completed = createMemo(() => (thread()?.status === "completed" || thread()?.run?.state === "completed" ? 1 : 0))
  const total = createMemo(() => (thread() ? 1 : 0))
  const activeTitle = createMemo(
    () =>
      props.conversation().channels.find((channel) => channel.id === props.conversation().activeChannelID)?.title ??
      "董事会圆桌会议",
  )

  return (
    <main class="company-office" aria-label="Agent Company 办公室">
      <h1>{props.snapshot().company.name} 办公室</h1>
      <section class="company-office-stage" aria-label="办公室动画区域" />
      <aside class="company-office-metrics">
        <div class="company-office-metric">
          <span>今日消耗 Token</span>
          <strong>—</strong>
          <small>本地运行</small>
        </div>
        <div class="company-office-metric">
          <span>今日节省 Token</span>
          <strong>—</strong>
          <small>等待运行数据</small>
        </div>

        <div class="company-office-detail-heading">
          <span>对话明细</span>
          <span>全部</span>
        </div>
        <div class="company-office-summary">
          <div><strong>{running()}</strong><span>进行中</span></div>
          <div><strong>{completed()}</strong><span>已完成</span></div>
          <div><strong>{total()}</strong><span>总计</span></div>
        </div>
        <article class="company-office-conversation">
          <header>
            <strong>{activeTitle()}</strong>
            <span>{statusLabel(thread())}</span>
          </header>
          <footer>
            <span>累计协作事件 {props.conversation().threadEntries.length}</span>
            <time>{thread() ? new Date(thread()!.time.updated).toLocaleString() : "—"}</time>
          </footer>
        </article>
        <p class="company-office-end">没有更多了</p>
      </aside>
    </main>
  )
}
