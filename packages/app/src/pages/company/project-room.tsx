import { Icon } from "@agents-company/ui/icon"
import { Markdown } from "@agents-company/ui/markdown"
import { For, Show, createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import type {
  CompanyProjectArtifact,
  CompanyProjectExecutionState,
  CompanyProjectStatus,
  CompanyProjectWorkItem,
} from "./company-model"

const PROJECT_AGENT: Record<string, { name: string; role: string; avatar: string }> = {
  "board-ceo": { name: "CEO", role: "董事会终审", avatar: "/assets/company/product-lead.png" },
  "project-lead": { name: "项目负责人", role: "Project Lead", avatar: "/assets/company/product-lead.png" },
  "market-researcher": { name: "市场研究员", role: "Research", avatar: "/assets/company/ui-implementer.png" },
  "product-strategist": { name: "产品策略师", role: "Product", avatar: "/assets/company/ui-implementer.png" },
  "game-product-strategist": { name: "产品策略师", role: "Product", avatar: "/assets/company/ui-implementer.png" },
  "technical-researcher": { name: "技术研究员", role: "Engineering", avatar: "/assets/company/backend-engineer.png" },
  "product-manager": { name: "产品经理", role: "PM", avatar: "/assets/company/product-lead.png" },
  "software-architect": { name: "软件架构师", role: "Architecture", avatar: "/assets/company/backend-engineer.png" },
  "qa-engineer": { name: "QA 工程师", role: "Quality", avatar: "/assets/company/qa-agent.png" },
  "mvp-developer": { name: "开发负责人", role: "Engineering", avatar: "/assets/company/backend-engineer.png" },
  "repair-engineer": { name: "修复工程师", role: "Engineering", avatar: "/assets/company/backend-engineer.png" },
}

const STATUS_LABEL: Record<CompanyProjectStatus, string> = {
  intake: "正在建立章程",
  researching: "研究中",
  awaiting_project_approval: "等待立项审批",
  planning: "规划中",
  awaiting_development_approval: "等待开发审批",
  developing: "执行中",
  verifying: "验收中",
  completed: "已交付",
  rejected: "已驳回",
  blocked: "已阻塞",
}

const WORK_STATUS_LABEL: Record<CompanyProjectWorkItem["status"], string> = {
  pending: "等待前置任务",
  running: "进行中",
  blocked: "已阻塞",
  failed: "失败",
  completed: "已完成",
  cancelled: "已取消",
}

function projectAgent(agentID?: string) {
  if (!agentID) return { name: "待分配", role: "未指定负责人", avatar: "/assets/company/product-lead.png" }
  return PROJECT_AGENT[agentID] ?? {
    name: agentID,
    role: "动态成员",
    avatar: "/assets/company/product-lead.png",
  }
}

function artifactLabel(artifact: CompanyProjectArtifact) {
  if (artifact.kind === "project_proposal") return "立项建议"
  if (artifact.kind === "product_brief") return "产品定义"
  if (artifact.kind === "architecture") return "技术架构"
  if (artifact.kind === "qa_plan") return "QA 计划"
  return artifact.kind.replaceAll("_", " ")
}

function formatTime(value?: number) {
  if (!value) return "尚未开始"
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value)
}

export function ProjectRoom(props: {
  project: Accessor<CompanyProjectExecutionState | null>
  busy: Accessor<boolean>
  error: Accessor<string | null>
  onOpenBoard: () => void
  onCancel: () => void
}) {
  const [selectedWorkItemID, setSelectedWorkItemID] = createSignal<string | null>(null)
  const [selectedArtifactID, setSelectedArtifactID] = createSignal<string | null>(null)
  const completed = createMemo(() => props.project()?.work_items.filter((item) => item.status === "completed").length ?? 0)
  const active = createMemo(() =>
    props.project()?.work_items.filter((item) => ["running", "blocked", "failed"].includes(item.status)).length ?? 0,
  )
  const teamSize = createMemo(
    () => new Set(props.project()?.work_items.map((item) => item.owner_agent_id).filter(Boolean)).size,
  )
  const progress = createMemo(() => {
    const total = props.project()?.work_items.length ?? 0
    return total ? Math.round((completed() / total) * 100) : 0
  })
  const selectedWorkItem = createMemo(() =>
    props.project()?.work_items.find((item) => item.id === selectedWorkItemID()),
  )
  const selectedArtifacts = createMemo(() =>
    props.project()?.artifacts.filter((artifact) => artifact.work_item_id === selectedWorkItem()?.id) ?? [],
  )
  const selectedArtifact = createMemo(() =>
    props.project()?.artifacts.find((artifact) => artifact.id === selectedArtifactID()),
  )
  const pendingGate = createMemo(() => props.project()?.gates.find((gate) => gate.status === "pending"))

  createEffect(() => {
    const project = props.project()
    if (!project?.work_items.length) {
      setSelectedWorkItemID(null)
      return
    }
    if (project.work_items.some((item) => item.id === selectedWorkItemID())) return
    setSelectedWorkItemID(
      project.work_items.find((item) => ["running", "blocked", "failed"].includes(item.status))?.id ??
        project.work_items[0].id,
    )
  })

  createEffect(() => {
    if (selectedArtifacts().some((artifact) => artifact.id === selectedArtifactID())) return
    setSelectedArtifactID(selectedArtifacts().at(0)?.id ?? null)
  })

  return (
    <section class="company-project-room" aria-label="项目室">
      <Show
        when={props.project()}
        fallback={
          <div class="company-project-room-empty" role="status">
            <Icon name="folder" size="small" />
            <strong>项目尚未建立</strong>
            <p>董事会批准 Charter 后，这里会出现真实项目、团队和任务。</p>
            <button type="button" onClick={props.onOpenBoard}>返回董事会</button>
          </div>
        }
      >
        {(project) => (
          <>
            <header class="company-project-room-hero">
              <div class="company-project-room-heading">
                <span class="company-eyebrow">Project Room · {project().project.owner_agent_id ?? "project-lead"}</span>
                <div>
                  <h2>{project().project.title}</h2>
                  <span class="company-project-state" data-status={project().project.status}>
                    {STATUS_LABEL[project().project.status]}
                  </span>
                </div>
                <p>{project().project.goal}</p>
              </div>
              <div class="company-project-room-actions">
                <button type="button" class="secondary" onClick={props.onOpenBoard}>
                  <Icon name="speech-bubble" size="small" /> 返回董事会
                </button>
                <Show when={project().project.active_run_id}>
                  <button type="button" disabled={props.busy()} onClick={props.onCancel}>
                    <Icon name="stop" size="small" /> {props.busy() ? "正在停止" : "停止本轮"}
                  </button>
                </Show>
              </div>
            </header>

            <section class="company-project-room-metrics" aria-label="项目摘要">
              <div><span>进度</span><strong>{progress()}%</strong><i><b style={{ width: `${progress()}%` }} /></i></div>
              <div><span>任务</span><strong>{completed()} / {project().work_items.length}</strong><small>已完成</small></div>
              <div><span>团队</span><strong>{teamSize()}</strong><small>动态成员</small></div>
              <div data-tone={active() ? "active" : "neutral"}><span>当前</span><strong>{active()}</strong><small>运行或需关注</small></div>
            </section>

            <Show when={pendingGate()}>
              {(gate) => (
                <section class="company-project-room-gate" aria-label="待审批">
                  <span><Icon name="speech-bubble" size="small" /></span>
                  <div><strong>{gate().title}</strong><p>执行已停在治理门，审批决定只在董事会处理。</p></div>
                  <button type="button" onClick={props.onOpenBoard}>去董事会审批</button>
                </section>
              )}
            </Show>

            <div class="company-project-room-layout">
              <section class="company-project-workstream" aria-labelledby="company-project-workstream-title">
                <header>
                  <div><span class="company-eyebrow">Execution map</span><h3 id="company-project-workstream-title">任务与负责人</h3></div>
                  <span>{project().work_items.length} 项</span>
                </header>
                <div class="company-project-work-list">
                  <For each={project().work_items}>
                    {(item, index) => {
                      const agent = () => projectAgent(item.owner_agent_id)
                      const artifactCount = () => project().artifacts.filter((artifact) => artifact.work_item_id === item.id).length
                      return (
                        <button
                          type="button"
                          class="company-project-work-row"
                          classList={{ selected: selectedWorkItemID() === item.id }}
                          data-status={item.status}
                          aria-pressed={selectedWorkItemID() === item.id}
                          onClick={() => setSelectedWorkItemID(item.id)}
                        >
                          <span class="company-project-work-index">{String(index() + 1).padStart(2, "0")}</span>
                          <img src={agent().avatar} alt="" />
                          <span class="company-project-work-copy">
                            <span><strong>{item.title}</strong><small>{WORK_STATUS_LABEL[item.status]}</small></span>
                            <span>{agent().name} · {agent().role}</span>
                          </span>
                          <span class="company-project-work-artifact-count">
                            {artifactCount() ? `${artifactCount()} 个产出` : formatTime(item.started_at)}
                          </span>
                          <Icon name="arrow-right" size="small" />
                        </button>
                      )
                    }}
                  </For>
                </div>
              </section>

              <aside class="company-project-inspector" aria-label="任务详情">
                <Show
                  when={selectedWorkItem()}
                  fallback={<p class="company-project-inspector-empty">选择一个任务查看责任、失败和产出物。</p>}
                >
                  {(item) => {
                    const agent = () => projectAgent(item().owner_agent_id)
                    return (
                      <>
                        <header>
                          <span class="company-eyebrow">Work item</span>
                          <span class="company-project-state" data-status={item().status}>{WORK_STATUS_LABEL[item().status]}</span>
                          <h3>{item().title}</h3>
                          <p>{item().description}</p>
                        </header>
                        <dl class="company-project-work-facts">
                          <div><dt>负责人</dt><dd><img src={agent().avatar} alt="" /> {agent().name}</dd></div>
                          <div><dt>开始</dt><dd>{formatTime(item().started_at)}</dd></div>
                          <div><dt>更新</dt><dd>{formatTime(item().updated_at)}</dd></div>
                          <div><dt>类型</dt><dd>{item().kind}</dd></div>
                        </dl>
                        <Show when={item().error}>
                          <section class="company-project-work-error" role="alert">
                            <strong>最近失败</strong><p>{item().error}</p>
                          </section>
                        </Show>
                        <section class="company-project-artifact-panel">
                          <header><strong>产出物</strong><span>{selectedArtifacts().length}</span></header>
                          <Show
                            when={selectedArtifacts().length > 0}
                            fallback={<p class="company-project-artifact-empty">此任务还没有可验证产出。</p>}
                          >
                            <div class="company-project-artifact-tabs" role="tablist" aria-label="任务产出物">
                              <For each={selectedArtifacts()}>
                                {(artifact) => (
                                  <button
                                    type="button"
                                    role="tab"
                                    aria-selected={selectedArtifactID() === artifact.id}
                                    onClick={() => setSelectedArtifactID(artifact.id)}
                                  >
                                    <Icon name="folder" size="small" />
                                    <span>{artifact.title}</span>
                                  </button>
                                )}
                              </For>
                            </div>
                            <Show when={selectedArtifact()}>
                              {(artifact) => (
                                <article class="company-project-artifact-preview" role="tabpanel">
                                  <header>
                                    <div><strong>{artifact().title}</strong><span>{artifactLabel(artifact())}</span></div>
                                    <time>{formatTime(artifact().created_at)}</time>
                                  </header>
                                  <Show
                                    when={artifact().content}
                                    fallback={<p>该产出物只有元数据，当前没有可安全预览的正文。</p>}
                                  >
                                    {(content) => (
                                      <Show
                                        when={!content().trimStart().startsWith("{")}
                                        fallback={<pre><code>{content()}</code></pre>}
                                      >
                                        <Markdown text={content()} cacheKey={artifact().id} />
                                      </Show>
                                    )}
                                  </Show>
                                </article>
                              )}
                            </Show>
                          </Show>
                        </section>
                      </>
                    )
                  }}
                </Show>
              </aside>
            </div>

            <Show when={props.error()}><div class="company-project-inline-error" role="alert">{props.error()}</div></Show>
          </>
        )}
      </Show>
    </section>
  )
}
