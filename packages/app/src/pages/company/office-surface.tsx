import { For, Show, createMemo, type Accessor } from "solid-js"
import { Icon } from "@agents-company/ui/icon"
import type { AgentActivityProjection } from "@agents-company/sdk/v2/client"
import type { CompanyProjectExecutionState, CompanyReadyWorkspaceSnapshot, ConversationSnapshot } from "./company-model"

const ACTIVITY_LABEL: Record<AgentActivityProjection["activity"], string> = {
  idle: "空闲",
  waiting: "等待中",
  working: "工作中",
  recovering: "恢复中",
  completed: "刚完成",
  failed: "失败待恢复",
  interrupted: "已中断",
}

const ATTENTION_LABEL: Record<AgentActivityProjection["attention"], string> = {
  none: "无需关注",
  available: "可响应",
  focused: "已聚焦",
  urgent: "需关注",
}

const INTERRUPTIBILITY_LABEL: Record<AgentActivityProjection["interruptibility"], string> = {
  interruptible: "可随时联系",
  coordinate_first: "建议先查看证据",
  needs_intervention: "需要介入",
}

function relativeTime(since: number) {
  const elapsed = Math.max(0, Date.now() - since)
  if (elapsed < 60_000) return "刚刚"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(since)
}

const PROJECT_ROLE_LABEL: Record<string, string> = {
  "project-lead": "项目负责人",
  "market-researcher": "市场研究员",
  "product-strategist": "产品策略师",
  "game-product-strategist": "产品策略师",
  "technical-researcher": "技术研究员",
  "product-manager": "产品经理",
  "software-architect": "软件架构师",
  "qa-engineer": "QA 工程师",
  "mvp-developer": "开发负责人",
  "repair-engineer": "修复工程师",
}

export function OfficeSurface(props: {
  snapshot: Accessor<CompanyReadyWorkspaceSnapshot>
  conversation: Accessor<ConversationSnapshot>
  project: Accessor<CompanyProjectExecutionState | null>
  onOpenProject: () => void
  onOpenThread: (threadID: string) => void
}) {
  const cards = createMemo(() => props.snapshot().agents ?? [])
  const projectMembers = createMemo(() =>
    Object.values(
      (props.project()?.work_items ?? []).reduce<Record<string, { agentID: string; items: CompanyProjectExecutionState["work_items"] }>>(
        (members, item) => {
          if (!item.owner_agent_id) return members
          return {
            ...members,
            [item.owner_agent_id]: {
              agentID: item.owner_agent_id,
              items: [...(members[item.owner_agent_id]?.items ?? []), item],
            },
          }
        },
        {},
      ),
    ),
  )
  const running = createMemo(() => cards().filter((card) => ["working", "waiting", "recovering"].includes(card.activity)).length)
  const needsAttention = createMemo(() => cards().filter((card) => card.attention === "urgent").length)

  return (
    <main id="company-main-content" class="company-office" aria-labelledby="company-office-title" tabindex="-1">
      <header class="company-office-header">
        <div>
          <span class="company-eyebrow">实时公司视图</span>
          <h1 id="company-office-title">{props.snapshot().company.name} 办公室</h1>
          <p>员工状态来自公开 Agent Run 投影。没有 Evidence 时只显示可证明的空闲状态。</p>
        </div>
        <div class="company-office-summary" aria-label="办公室摘要">
          <div><strong>{cards().length}</strong><span>真实员工</span></div>
          <div><strong>{running()}</strong><span>运行或等待</span></div>
          <div data-tone={needsAttention() ? "danger" : "neutral"}><strong>{needsAttention()}</strong><span>需关注</span></div>
          <div><strong>{props.conversation().threadEntries.length}</strong><span>当前 Thread 事件</span></div>
        </div>
      </header>

      <Show
        when={cards().length > 0}
        fallback={
          <section class="company-office-empty" role="status">
            <Icon name="prompt" size="small" />
            <strong>还没有可展示的真实员工</strong>
            <p>员工入职并产生公开活动事实后，这里会自动出现状态卡片。</p>
          </section>
        }
      >
        <section class="company-employee-grid" aria-label="员工活动卡片">
          <For each={cards()}>
            {(card) => (
              <article class="company-employee-card" data-activity={card.activity}>
                <header>
                  <span class="company-employee-avatar" aria-hidden="true">{card.agent.name.slice(0, 2)}</span>
                  <div>
                    <strong>{card.agent.name}</strong>
                    <span>{card.agent.role ?? "动态成员"}</span>
                  </div>
                  <span class="company-activity-badge" data-activity={card.activity}>{ACTIVITY_LABEL[card.activity]}</span>
                </header>
                <dl>
                  <div><dt>当前责任</dt><dd>{card.agent.responsibilities.join("、") || "暂无公开临时责任"}</dd></div>
                  <div><dt>团队</dt><dd>{card.agent.department ?? "动态组织"}</dd></div>
                  <div><dt>Presence</dt><dd>{card.presence === "online" ? "在线" : "离线"}</dd></div>
                  <div><dt>位置</dt><dd>{card.location}</dd></div>
                  <div><dt>正在关注</dt><dd>{card.subject ?? "暂无有证据支撑的具体活动"}</dd></div>
                  <div><dt>开始于</dt><dd>{relativeTime(card.since)}</dd></div>
                  <div><dt>可打断性</dt><dd>{INTERRUPTIBILITY_LABEL[card.interruptibility]}</dd></div>
                  <Show when={card.risk}><div data-tone="danger"><dt>风险</dt><dd>{card.risk}</dd></div></Show>
                  <Show when={card.collaborators.length > 0}>
                    <div><dt>协作者</dt><dd>{card.collaborators.join("、")}</dd></div>
                  </Show>
                </dl>
                <footer>
                  <span data-attention={card.attention}>{ATTENTION_LABEL[card.attention]}</span>
                  <Show when={card.evidence?.threadID}>
                    {(threadID) => (
                      <button type="button" onClick={() => props.onOpenThread(threadID())}>
                        查看证据 <Icon name="arrow-right" size="small" />
                      </button>
                    )}
                  </Show>
                </footer>
              </article>
            )}
          </For>
        </section>
      </Show>

      <Show when={projectMembers().length > 0}>
        <section class="company-project-team" aria-labelledby="company-project-team-title">
          <header>
            <div>
              <span class="company-eyebrow">项目分工投影</span>
              <h2 id="company-project-team-title">当前项目团队</h2>
              <p>这些角色来自真实 Work Item 分配。运行状态仍以 Agent Run Evidence 为准。</p>
            </div>
            <button type="button" onClick={props.onOpenProject}>打开项目室 <Icon name="arrow-right" size="small" /></button>
          </header>
          <div class="company-project-team-grid">
            <For each={projectMembers()}>
              {(member) => {
                const current = () =>
                  member.items.find((item) => item.status === "running") ??
                  member.items.find((item) => ["blocked", "failed"].includes(item.status)) ??
                  member.items.at(-1)
                return (
                  <button type="button" class="company-project-member-card" onClick={props.onOpenProject}>
                    <span class="company-project-member-mark" aria-hidden="true">
                      {(PROJECT_ROLE_LABEL[member.agentID] ?? member.agentID).slice(0, 2)}
                    </span>
                    <span>
                      <strong>{PROJECT_ROLE_LABEL[member.agentID] ?? member.agentID}</strong>
                      <small>{current()?.title ?? "等待任务"}</small>
                    </span>
                    <span class="company-project-state" data-status={current()?.status ?? "pending"}>
                      {current()?.status === "running"
                        ? "工作中"
                        : current()?.status === "completed"
                          ? "已完成"
                          : current()?.status === "blocked" || current()?.status === "failed"
                            ? "需关注"
                            : "等待中"}
                    </span>
                  </button>
                )
              }}
            </For>
          </div>
        </section>
      </Show>

      <aside class="company-ambient-contract" aria-label="未来 Ambient 状态说明">
        <Icon name="prompt" size="small" />
        <div>
          <strong>闲逛会创造真实价值，但不会被伪造</strong>
          <p>roaming、socializing、reflecting、dreaming 已进入后续状态契约。只有产生可审计事件后，员工卡片和未来 2D/3D 办公室才会显示。</p>
        </div>
      </aside>
    </main>
  )
}
