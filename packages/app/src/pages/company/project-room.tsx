import { Icon } from "@agents-company/ui/icon"
import { Markdown } from "@agents-company/ui/markdown"
import { For, Show, createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import type {
  CompanyProjectArtifact,
  CompanyProjectExecutionState,
  CompanyProjectStatus,
  CompanyProjectWorkItem,
} from "./company-model"

const STATUS_LABEL: Record<CompanyProjectStatus, string> = {
  intake: "正在建立章程",
  planning: "规划中",
  executing: "执行中",
  reviewing: "独立复核中",
  awaiting_approval: "等待治理审批",
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

const KIND_LABEL: Record<CompanyProjectWorkItem["kind"], string> = {
  planner: "Planner",
  worker: "Worker",
  reviewer: "Reviewer",
}

const REVIEW_LABEL: Record<CompanyProjectWorkItem["review_status"], string> = {
  pending: "等待复核",
  running: "复核中",
  accepted: "复核通过",
  rejected: "复核拒绝",
  not_required: "无需复核",
}

export function projectWorkTree(items: CompanyProjectWorkItem[]) {
  const children = new Map<string, CompanyProjectWorkItem[]>()
  items.forEach((item) => {
    const key = item.parent_id ?? "root"
    children.set(key, [...(children.get(key) ?? []), item])
  })
  const visited = new Set<string>()
  const rows: Array<{ item: CompanyProjectWorkItem; depth: number }> = []
  const visit = (item: CompanyProjectWorkItem, depth: number) => {
    if (visited.has(item.id)) return
    visited.add(item.id)
    rows.push({ item, depth })
    children.get(item.id)?.forEach((child) => visit(child, depth + 1))
  }
  children.get("root")?.forEach((item) => visit(item, 0))
  items.filter((item) => !visited.has(item.id)).forEach((item) => visit(item, 0))
  return rows
}

function artifactLabel(artifact: CompanyProjectArtifact) {
  if (artifact.kind === "project_charter") return "Project Charter"
  if (artifact.kind === "independent_review") return "独立复核"
  if (artifact.kind === "attempt_failure") return "失败 Attempt"
  if (artifact.kind === "merge_report") return "合并复验"
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

function formatCost(value: number) {
  if (!value) return "$0"
  return value < 0.01 ? `<$0.01` : `$${value.toFixed(2)}`
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
  const tree = createMemo(() => projectWorkTree(props.project()?.work_items ?? []))
  const selectedWorkItem = createMemo(() =>
    props.project()?.work_items.find((item) => item.id === selectedWorkItemID()),
  )
  const selectedArtifacts = createMemo(() =>
    props.project()?.artifacts.filter((artifact) => artifact.work_item_id === selectedWorkItem()?.id) ?? [],
  )
  const selectedArtifact = createMemo(() =>
    props.project()?.artifacts.find((artifact) => artifact.id === selectedArtifactID()),
  )
  const selectedUsage = createMemo(() =>
    props.project()?.usage?.workItems.find((item) => item.workItemID === selectedWorkItem()?.id),
  )
  const selectedRuns = createMemo(() =>
    props.project()?.agent_runs.filter((run) => run.workItemID === selectedWorkItem()?.id) ?? [],
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
            <p>创建项目后，这里会显示动态任务树、真实 Agent 活动和交付证据。</p>
            <button type="button" onClick={props.onOpenBoard}>返回董事会</button>
          </div>
        }
      >
        {(project) => (
          <>
            <header class="company-project-room-hero">
              <div class="company-project-room-heading">
                <span class="company-eyebrow">Project Room · Adaptive execution</span>
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
                <Show when={project().work_items.some((item) => item.status === "running")}>
                  <button type="button" disabled={props.busy()} onClick={props.onCancel}>
                    <Icon name="stop" size="small" /> {props.busy() ? "正在停止" : "停止本轮"}
                  </button>
                </Show>
              </div>
            </header>

            <section class="company-project-room-metrics" aria-label="项目摘要">
              <div><span>进度</span><strong>{progress()}%</strong><i><b style={{ width: `${progress()}%` }} /></i></div>
              <div><span>任务</span><strong>{completed()} / {project().work_items.length}</strong><small>已完成</small></div>
              <div><span>团队</span><strong>{teamSize()}</strong><small>动态角色</small></div>
              <div data-tone={active() ? "active" : "neutral"}>
                <span>模型成本</span><strong>{formatCost(project().usage?.observedTokens.cost ?? 0)}</strong>
                <small>{project().usage?.observedTokens.total.toLocaleString() ?? 0} tokens · {active()} 项需关注</small>
              </div>
            </section>

            <Show when={pendingGate()}>
              {(gate) => (
                <section class="company-project-room-gate" aria-label="待审批">
                  <span><Icon name="speech-bubble" size="small" /></span>
                  <div><strong>{gate().title}</strong><p>执行只会在高风险或不可逆操作前停下。</p></div>
                  <button type="button" onClick={props.onOpenBoard}>去董事会审批</button>
                </section>
              )}
            </Show>

            <div class="company-project-room-layout">
              <section class="company-project-workstream" aria-labelledby="company-project-workstream-title">
                <header>
                  <div><span class="company-eyebrow">Execution tree</span><h3 id="company-project-workstream-title">动态任务树</h3></div>
                  <span>{project().work_items.length} 项</span>
                </header>
                <div class="company-project-work-list">
                  <For each={tree()}>
                    {(row, index) => {
                      const item = () => row.item
                      const artifactCount = () => project().artifacts.filter((artifact) => artifact.work_item_id === item().id).length
                      return (
                        <button
                          type="button"
                          class="company-project-work-row"
                          classList={{ selected: selectedWorkItemID() === item().id }}
                          data-status={item().status}
                          data-kind={item().kind}
                          style={`--tree-depth:${row.depth}`}
                          aria-pressed={selectedWorkItemID() === item().id}
                          onClick={() => setSelectedWorkItemID(item().id)}
                        >
                          <span class="company-project-work-index">{String(index() + 1).padStart(2, "0")}</span>
                          <span class="company-project-work-avatar" aria-hidden="true">{item().role.slice(0, 1).toUpperCase()}</span>
                          <span class="company-project-work-copy">
                            <span><strong>{item().title}</strong><small>{WORK_STATUS_LABEL[item().status]}</small></span>
                            <span>{KIND_LABEL[item().kind]} · {item().role} · {item().model_group}</span>
                          </span>
                          <span class="company-project-work-artifact-count">
                            {artifactCount() ? `${artifactCount()} 个记录` : formatTime(item().started_at)}
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
                  fallback={<p class="company-project-inspector-empty">选择一个节点查看角色、模型、失败和交付证据。</p>}
                >
                  {(item) => (
                    <>
                      <header>
                        <span class="company-eyebrow">{KIND_LABEL[item().kind]} · {item().work_type}</span>
                        <span class="company-project-state" data-status={item().status}>{WORK_STATUS_LABEL[item().status]}</span>
                        <h3>{item().title}</h3>
                        <p>{item().description}</p>
                      </header>
                      <dl class="company-project-work-facts">
                        <div><dt>负责人</dt><dd>{item().owner_agent_id ?? "待分配"}</dd></div>
                        <div><dt>临时角色</dt><dd>{item().role}</dd></div>
                        <div><dt>模型路由</dt><dd>{item().model_group} · {selectedUsage()?.models.join("、") || selectedRuns().at(0)?.model || "尚未运行"}</dd></div>
                        <div><dt>成本</dt><dd>{formatCost(selectedUsage()?.observedTokens.cost ?? 0)} · {selectedUsage()?.observedTokens.total.toLocaleString() ?? 0} tokens</dd></div>
                        <div><dt>复核</dt><dd>{REVIEW_LABEL[item().review_status]}</dd></div>
                        <div><dt>Attempt</dt><dd>{item().attempt} / {item().max_attempts}</dd></div>
                        <div><dt>开始</dt><dd>{formatTime(item().started_at)}</dd></div>
                        <div><dt>更新</dt><dd>{formatTime(item().updated_at)}</dd></div>
                      </dl>
                      <section class="company-project-work-contract">
                        <div><strong>验收条件</strong><For each={item().acceptance_criteria}>{(value) => <span>{value}</span>}</For></div>
                        <div><strong>决策范围</strong><For each={item().decision_scope}>{(value) => <span>{value}</span>}</For></div>
                        <div><strong>资源范围</strong><For each={item().resource_scope}>{(value) => <span>{value}</span>}</For></div>
                        <div><strong>能力包</strong><For each={item().capability_packs}>{(value) => <span>{value}</span>}</For></div>
                      </section>
                      <Show when={item().error}>
                        <section class="company-project-work-error" role="alert">
                          <strong>最近失败</strong><p>{item().error}</p>
                        </section>
                      </Show>
                      <section class="company-project-artifact-panel">
                        <header><strong>Attempt 与产出物</strong><span>{selectedArtifacts().length}</span></header>
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
                                <Show when={artifact().content} fallback={<p>该记录只有元数据，当前没有可安全预览的正文。</p>}>
                                  {(content) => (
                                    <Show when={!content().trimStart().startsWith("{")} fallback={<pre><code>{content()}</code></pre>}>
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
                  )}
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
