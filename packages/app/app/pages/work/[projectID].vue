<script setup lang="ts">
import type {
  AttentionItem,
  ExperienceWorkActionRequest,
  ExperienceWorkActionResult,
  GoalBriefProjectView,
} from "@agents-company/shared/experience"
import type {
  CompanyProjectDetail,
  CompanyProjectMessage,
  SeedGrowProjectExperience,
} from "../../../modules/agent-company/runtime/shared/company-contract"
import {
  availableContextPanels,
  contextPanelLabels,
  nextColumn,
  prevColumn,
  reconcileViewState,
  resolveActivePanel,
  viewStateFor,
  type ContextPanelKind,
  type WorkspaceColumn,
  type WorkspaceViewState,
} from "../../../modules/agent-company/runtime/shared/work-workspace"
import {
  canInvoke,
  toControlActions,
  type ControlAction,
} from "../../../modules/agent-company/runtime/shared/work-controls"
import {
  acceptanceChecklist,
  criterionVerdictLabels,
  deliveryPackageView,
} from "../../../modules/agent-company/runtime/shared/delivery-package"
import type { ComposerTarget } from "../../../modules/agent-company/runtime/shared/company-composer"
import { diagnosticsCount } from "../../../modules/agent-company/runtime/shared/seed-grow-view"

const route = useRoute()
const appConfig = useAppConfig()
const { data: snapshot, pending, refresh, signalVersion } = useCompanySnapshot()
const workID = computed(() =>
  Array.isArray(route.params.projectID) ? route.params.projectID[0] : route.params.projectID,
)
const available = computed(() => ["ready", "degraded"].includes(snapshot.value.connection))
const workUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("work") ?? false)
const work = computed(() =>
  snapshot.value.work.find(
    (item) => (item.availability === "available" ? item.summary.workId : item.workId) === workID.value,
  ),
)

const workList = computed(() =>
  snapshot.value.work.map((item) =>
    item.availability === "available"
      ? { id: item.summary.workId, title: item.summary.title, status: item.summary.userStatus, ok: true as const }
      : { id: item.workId, title: item.title, status: "unavailable", ok: false as const },
  ),
)

const {
  data: goalBriefResult,
  status: goalBriefStatus,
  error: goalBriefError,
  refresh: refreshGoalBrief,
} = useFetch<GoalBriefProjectView>(
  () => `/api/agent-company/projects/${encodeURIComponent(workID.value ?? "")}/goal-brief`,
)
const goalBrief = computed(() =>
  goalBriefResult.value && "kind" in goalBriefResult.value ? goalBriefResult.value : undefined,
)

const {
  data: detailResult,
  status: detailStatus,
  error: detailError,
  refresh: refreshDetail,
} = useFetch<CompanyProjectDetail>(
  () => `/api/agent-company/projects/${encodeURIComponent(workID.value ?? "")}`,
)
const detail = computed(() => detailResult.value ?? undefined)
const {
  data: seedGrowResult,
  status: seedGrowStatus,
  error: seedGrowError,
  refresh: refreshSeedGrow,
} = useFetch<SeedGrowProjectExperience>(
  () => `/api/agent-company/projects/${encodeURIComponent(workID.value ?? "")}/seed-grow`,
  { lazy: true },
)
const seedGrow = computed(() => seedGrowResult.value ?? undefined)
const {
  data: projectMessages,
  status: projectMessagesStatus,
  error: projectMessagesError,
  refresh: refreshProjectMessages,
} = useFetch<CompanyProjectMessage[]>(
  () => `/api/agent-company/projects/${encodeURIComponent(workID.value ?? "")}/messages`,
  { default: () => [] },
)
const seedProject = computed(() => detail.value?.project.executionStrategy === "seed_and_grow")
const seedGrowPending = computed(() => seedGrowStatus.value === "pending")
const coordinatedRefreshPendingProject = ref<string>()
const coordinatedRefreshDirty = ref<Record<string, boolean>>({})

function clearCoordinatedRefreshDirty(projectID: string) {
  const next = { ...coordinatedRefreshDirty.value }
  delete next[projectID]
  coordinatedRefreshDirty.value = next
}

async function refreshProjectExperience(projectID = workID.value) {
  if (!projectID) return
  if (coordinatedRefreshPendingProject.value) {
    coordinatedRefreshDirty.value = { ...coordinatedRefreshDirty.value, [projectID]: true }
    return
  }
  coordinatedRefreshPendingProject.value = projectID
  clearCoordinatedRefreshDirty(projectID)
  await Promise.all([
    refresh(),
    refreshGoalBrief(),
    refreshDetail(),
    refreshSeedGrow(),
    refreshProjectMessages(),
  ])
  coordinatedRefreshPendingProject.value = undefined
  const nextProjectID = workID.value
  if (!nextProjectID || !coordinatedRefreshDirty.value[nextProjectID]) return
  clearCoordinatedRefreshDirty(nextProjectID)
  await refreshProjectExperience(nextProjectID)
}

watch(signalVersion, (version, previous) => {
  if (version <= previous || !workID.value) return
  void refreshProjectExperience(workID.value)
})

// DELIV-05：区分 Delivered / Accepted，并用最初的验收标准构建核对清单（逐项状态待后端下发）。
const deliveryView = computed(() =>
  work.value?.availability === "available" && work.value.delivery
    ? deliveryPackageView(work.value.delivery)
    : undefined,
)
const acceptanceItems = computed(() =>
  goalBrief.value?.kind === "goal_brief" ? acceptanceChecklist(goalBrief.value.brief.acceptanceCriteria) : [],
)

const workDiagnostics = computed(() => work.value?.diagnostics ?? [])

// WORK-04：工作区 Composer 只在项目可用时挂载，发送目标固定为当前项目频道。
const composerTarget = computed<ComposerTarget | undefined>(() =>
  work.value?.availability === "available"
    ? { kind: "project", projectId: work.value.summary.workId, title: work.value.summary.title }
    : undefined,
)

// 右侧上下文面板只依据真实数据存在与否派生；Thread 明细需后端接线，此处不虚构。
// 目标摘要读取失败时仍保留“目标”面板入口，如实展示不可用状态而不是隐藏整个面板；404 表示本来就没有目标摘要，不制造面板。
const panels = computed(() =>
  availableContextPanels({
    hasGoalBrief:
      goalBriefStatus.value === "pending" ||
      (Boolean(goalBriefError.value) && goalBriefError.value?.statusCode !== 404) ||
      goalBrief.value?.kind === "goal_brief" ||
      goalBrief.value?.kind === "legacy_charter",
    gates: detail.value?.gates.length ?? 0,
    artifacts: detail.value?.artifacts.length ?? 0,
    agents: detail.value?.recruitment.candidates.length ?? 0,
    threadAvailable:
      projectMessagesStatus.value === "pending" ||
      projectMessagesStatus.value === "success" ||
      Boolean(projectMessagesError.value) ||
      projectMessages.value.length > 0,
    diagnostics:
      workDiagnostics.value.length +
      diagnosticsCount(seedGrow.value?.graph, seedGrow.value?.validation) +
      (seedProject.value ? 1 : 0),
  }),
)

// 每个项目独立保存视图状态，切换项目时校正以避免残留上一项目的上下文。
const viewStore = useState<Record<string, WorkspaceViewState>>("work-workspace-view", () => ({}))
const column = ref<WorkspaceColumn>("main")
const activePanel = ref<ContextPanelKind>()
const selectedArtifactID = ref<string>()
const selectedAgentID = ref<string>()

watch(
  [workID, panels, detail],
  () => {
    const id = workID.value
    if (!id) return
    const reconciled = reconcileViewState(viewStateFor(viewStore.value, id), panels.value, {
      artifacts: detail.value?.artifacts ?? [],
      agents: detail.value?.recruitment.candidates ?? [],
    })
    column.value = reconciled.column
    activePanel.value = reconciled.activePanel
    selectedArtifactID.value = reconciled.selectedArtifactID
    selectedAgentID.value = reconciled.selectedAgentID
  },
  { immediate: true },
)

function persist() {
  const id = workID.value
  if (!id) return
  viewStore.value = {
    ...viewStore.value,
    [id]: {
      column: column.value,
      activePanel: activePanel.value,
      selectedArtifactID: selectedArtifactID.value,
      selectedAgentID: selectedAgentID.value,
    },
  }
}

function selectPanel(kind: ContextPanelKind) {
  activePanel.value = resolveActivePanel(kind, panels.value)
  column.value = "context"
  persist()
}

function selectArtifact(id: string) {
  selectedArtifactID.value = id
  persist()
}

async function navigatePanel(event: KeyboardEvent, kind: ContextPanelKind) {
  const index = panels.value.indexOf(kind)
  const target =
    event.key === "Home"
      ? panels.value[0]
      : event.key === "End"
        ? panels.value.at(-1)
        : event.key === "ArrowRight"
          ? panels.value[(index + 1) % panels.value.length]
          : event.key === "ArrowLeft"
            ? panels.value[(index - 1 + panels.value.length) % panels.value.length]
            : undefined
  if (!target) return
  event.preventDefault()
  selectPanel(target)
  await nextTick()
  document.querySelector<HTMLElement>(`[data-context-panel="${target}"]`)?.focus()
}

function goColumn(direction: "next" | "prev") {
  column.value = direction === "next" ? nextColumn(column.value) : prevColumn(column.value)
  persist()
}

const selectedArtifact = computed(() => detail.value?.artifacts.find((item) => item.id === selectedArtifactID.value))
const selectedAgent = computed(() =>
  detail.value?.recruitment.candidates.find((item) => item.id === selectedAgentID.value),
)

// WORK-07 — 运行控制：只渲染投影下发的 allowedActions，保留真实 enabled/disabledReason，
// 仅在客户端有真实处理器且投影允许时才可点击（retry 走真实代理，导航类在客户端处理）。
const controlActions = computed<ControlAction[]>(() =>
  work.value?.availability === "available" ? toControlActions(work.value.summary.allowedActions) : [],
)
const nextActionID = computed(() =>
  work.value?.availability === "available" && work.value.summary.nextAction
    ? work.value.summary.nextAction.id
    : undefined,
)

// DELIV-04 — 审批决策动作：从投影 allowedActions 中筛出批准/拒绝/请求修改，按真实 enabled/disabledReason 展示。
// R0 治理契约未解除时这些变更类动作恒为禁用；说明文本由用户填写但在动作可用前不提交。
const decisionActionIDs = new Set(["approve", "reject", "request_change"])
const decisionActions = computed(() => controlActions.value.filter((action) => decisionActionIDs.has(action.id)))
const decisionNote = ref("")

const actionPending = ref<string>()
const actionNote = ref("")
const actionError = ref("")
const pendingActionIntents = useState<Record<string, ExperienceWorkActionRequest>>(
  "work-pending-action-intents",
  () => ({}),
)

function currentBriefDraft() {
  if (goalBrief.value?.kind !== "goal_brief") return
  return {
    goal: goalBrief.value.brief.goal,
    deliverables: goalBrief.value.brief.deliverables,
    acceptanceCriteria: goalBrief.value.brief.acceptanceCriteria,
    constraints: goalBrief.value.brief.constraints,
    nonGoals: goalBrief.value.brief.nonGoals,
    assumptions: goalBrief.value.brief.assumptions,
    openQuestions: goalBrief.value.brief.openQuestions,
    riskLevel: goalBrief.value.brief.riskLevel,
    recommendedPlan: goalBrief.value.brief.recommendedPlan,
    approvalMode: goalBrief.value.brief.approvalMode,
    sourceRefs: goalBrief.value.brief.sourceRefs,
  }
}

function actionIntentKey(action: ControlAction, attentionID?: string) {
  return `${workID.value ?? ""}:${action.id}:${attentionID ?? ""}`
}

function actionPayload(
  action: ControlAction,
  attention?: AttentionItem,
): { key: string; body: ExperienceWorkActionRequest } | undefined {
  const graphRevision = detail.value?.project.graphRevision
  if (graphRevision === undefined) return
  if (action.id === "resolve_blocker") {
    const target =
      attention ??
      (work.value?.availability === "available"
        ? work.value.attentionItems.find((item) =>
            item.allowedActions.some((allowed) => allowed.id === "resolve_blocker" && allowed.enabled),
          )
        : undefined)
    if (!target || !actionNote.value.trim()) return
    const key = actionIntentKey(action, target.id)
    return {
      key,
      body:
        pendingActionIntents.value[key] ?? {
          idempotencyKey: crypto.randomUUID(),
          expectedGraphRevision: graphRevision,
          action: "resolve_blocker",
          attentionId: target.id,
          resolution: actionNote.value.trim(),
        },
    }
  }
  if (action.id === "adjust_brief") {
    const brief = currentBriefDraft()
    const planVersion = detail.value?.project.activePlanVersion
    if (!brief || !planVersion || goalBrief.value?.kind !== "goal_brief" || !actionNote.value.trim()) return
    const goal = actionNote.value.trim()
    const key = actionIntentKey(action, attention?.id)
    return {
      key,
      body:
        pendingActionIntents.value[key] ?? {
          idempotencyKey: crypto.randomUUID(),
          expectedGraphRevision: graphRevision,
          action: "adjust_brief",
          attentionId: attention?.id,
          briefId: goalBrief.value.brief.id,
          expectedBriefVersion: goalBrief.value.brief.version,
          expectedPlanVersion: planVersion,
          source: "user_confirmation",
          brief: { ...brief, goal },
          changeReason: `目标从「${brief.goal}」调整为「${goal}」`.slice(0, 8_000),
        },
    }
  }
  const key = actionIntentKey(action)
  const idempotencyKey = crypto.randomUUID()
  const reason = actionNote.value.trim() || undefined
  if (action.id === "pause_work")
    return {
      key,
      body: pendingActionIntents.value[key] ?? {
        idempotencyKey,
        expectedGraphRevision: graphRevision,
        action: "pause_work",
        reason,
      },
    }
  if (action.id === "resume_work")
    return {
      key,
      body: pendingActionIntents.value[key] ?? {
        idempotencyKey,
        expectedGraphRevision: graphRevision,
        action: "resume_work",
        reason,
      },
    }
  if (action.id === "stop_work")
    return {
      key,
      body: pendingActionIntents.value[key] ?? {
        idempotencyKey,
        expectedGraphRevision: graphRevision,
        action: "stop_work",
        reason,
      },
    }
  if (action.id === "retry")
    return {
      key,
      body: pendingActionIntents.value[key] ?? {
        idempotencyKey,
        expectedGraphRevision: graphRevision,
        action: "retry",
        reason,
      },
    }
}

async function invokeAction(action: ControlAction, attention?: AttentionItem) {
  if (!canInvoke(action)) return
  if (action.handler === "navigate_progress" || action.handler === "open_delivery") {
    column.value = "main"
    persist()
    return
  }
  if (action.handler === "open_diagnostics") return selectPanel("diagnostics")
  if (action.handler === "open_evidence") return selectPanel("goal_brief")
  if (action.handler !== "action" || actionPending.value) return
  if (
    action.id === "adjust_brief" &&
    goalBrief.value?.kind === "goal_brief" &&
    actionNote.value.trim() === goalBrief.value.brief.goal.trim()
  ) {
    actionError.value = "新目标与当前目标相同，不会生成新的目标摘要与计划版本。"
    return
  }
  const intent = actionPayload(action, attention)
  if (!intent) {
    actionError.value =
      action.id === "resolve_blocker" || action.id === "adjust_brief"
        ? "请填写处理说明，并确认目标摘要与版本信息可用。"
        : "当前 Graph 版本不可用，不能提交运行时动作。"
    return
  }
  pendingActionIntents.value = { ...pendingActionIntents.value, [intent.key]: intent.body }
  actionPending.value = action.id
  actionError.value = ""
  const outcome = await $fetch<ExperienceWorkActionResult>(
    `/api/agent-company/projects/${encodeURIComponent(workID.value ?? "")}/actions`,
    {
      method: "POST",
      body: intent.body,
    },
  ).then(
    (value) => ({ status: "settled" as const, value }),
    () => ({ status: "uncertain" as const }),
  )
  if (outcome.status === "settled") {
    const next = { ...pendingActionIntents.value }
    delete next[intent.key]
    pendingActionIntents.value = next
    if (outcome.value.status === "applied") actionNote.value = ""
    if (outcome.value.status === "rejected")
      actionError.value = outcome.value.error ?? "动作被本地服务拒绝，请刷新状态后重试。"
  }
  if (outcome.status === "uncertain")
    actionError.value = "动作结果暂不确定；再次提交将复用同一请求，不会重复执行业务动作。"
  actionPending.value = undefined
  await refreshProjectExperience()
}

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

function briefSourceLabel(source: string) {
  if (source === "user_confirmation") return "用户确认"
  if (source === "user_input") return "用户输入"
  if (source === "system_suggestion") return "系统建议"
  return "旧项目 Charter"
}
function briefApprovalLabel(mode: string) {
  if (mode === "autonomous") return "自主推进"
  if (mode === "strict") return "严格审批"
  return "平衡审批"
}
function artifactKindLabel(kind: string) {
  if (kind === "report") return "报告"
  if (kind === "file") return "文件"
  if (kind === "link") return "链接"
  return "成果"
}
// DELIV-02 — 步骤与审批的原始状态是后端自由字符串，映射为用户可读标签；未知值原样显示，不猜测。
function workItemStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "待开始",
    queued: "排队中",
    running: "进行中",
    in_progress: "进行中",
    blocked: "受阻",
    review: "验收中",
    reviewing: "验收中",
    done: "已完成",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  }
  return labels[status] ?? status
}
function gateStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "待决策",
    open: "待决策",
    approved: "已批准",
    rejected: "已拒绝",
    resolved: "已处理",
    expired: "已过期",
    cancelled: "已取消",
  }
  return labels[status] ?? status
}
function artifactRoute(projectID: string, artifactID: string) {
  return `/library/artifacts/${encodeURIComponent(projectID)}/${encodeURIComponent(artifactID)}`
}
</script>

<template>
  <UDashboardPanel id="work-detail" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div
        class="ac-work3"
        :data-column="column"
        :data-detail-project-id="detail?.project.id"
        :data-organization-watermark="seedGrow?.organization.sourceWatermark"
        :data-graph-watermark="seedGrow?.graph.sourceWatermark"
        :data-validation-watermark="seedGrow?.validation.sourceWatermark"
        :data-message-watermark="projectMessages.map((message) => message.id).join(',')"
      >
        <!-- 左栏：选择工作与 Thread -->
        <aside class="ac-work3__col ac-work3__list" aria-label="工作列表">
          <div class="ac-work3__list-head">
            <NuxtLink to="/work" class="ac-back-link">
              <UIcon name="i-lucide-arrow-left" />
              全部 Work
            </NuxtLink>
          </div>
          <nav class="ac-work3__list-items">
            <NuxtLink
              v-for="entry in workList"
              :key="entry.id"
              :to="`/work/${encodeURIComponent(entry.id)}`"
              class="ac-work3__list-item"
              :data-active="entry.id === workID"
            >
              <span class="ac-work3__list-title">{{ entry.title }}</span>
              <span class="ac-status-badge" :data-status="entry.ok ? entry.status : 'unavailable'">
                {{ entry.ok ? appConfig.experience.statusLabels[entry.status] : "状态不可用" }}
              </span>
            </NuxtLink>
          </nav>
        </aside>

        <!-- 中栏：高信号目标、进展、需处理、交付 -->
        <section class="ac-work3__col ac-work3__main" aria-label="高信号工作流">
          <div class="ac-work3__mobile-bar">
            <button type="button" class="ac-work3__mobile-btn" @click="goColumn('prev')">
              <UIcon name="i-lucide-panel-left" /> 列表
            </button>
            <button v-if="panels.length" type="button" class="ac-work3__mobile-btn" @click="goColumn('next')">
              上下文 <UIcon name="i-lucide-panel-right" />
            </button>
          </div>

          <CompanyConnectionState
            v-if="!available || workUnavailable"
            :connection="snapshot.connection"
            :issue="snapshot.issue"
            :pending="pending"
            show-settings
            @retry="refresh()"
          />

          <template v-else-if="work?.availability === 'available'">
            <header class="ac-workspace-header">
              <div>
                <p class="ac-workspace-eyebrow">{{ work.summary.phase }}</p>
                <h1 class="ac-workspace-title">{{ work.summary.title }}</h1>
                <p class="ac-workspace-lede">{{ work.summary.reason.text }}</p>
                <!-- DELIV-02 — 首屏直接回答“谁负责 / 下一里程碑 / 是否需用户行动” -->
                <div class="ac-work-meta">
                  <span v-if="work.summary.owner">负责人：{{ work.summary.owner.name ?? work.summary.owner.id }}</span>
                  <span v-if="work.summary.nextMilestone">
                    下一里程碑：{{ work.summary.nextMilestone.title }}
                    <small v-if="work.summary.nextMilestone.completed">（已完成）</small>
                  </span>
                  <span v-if="work.summary.needsUserAction" class="ac-work-meta__flag">需要你的行动</span>
                </div>
              </div>
              <span class="ac-status-badge" :data-status="work.summary.userStatus">
                {{ appConfig.experience.statusLabels[work.summary.userStatus] }}
              </span>
            </header>

            <!-- WORK-07 — 运行控制：按投影的 allowedActions 如实展示，禁用态显示原因，不伪装可用 -->
            <div v-if="controlActions.length" class="ac-work3__actions" role="group" aria-label="运行控制">
              <button
                v-for="action in controlActions"
                :key="action.id"
                type="button"
                class="ac-work3__action"
                :data-primary="action.id === nextActionID"
                :disabled="!canInvoke(action) || Boolean(actionPending)"
                :title="action.disabledReason"
                :aria-disabled="!canInvoke(action)"
                @click="invokeAction(action)"
              >
                {{ action.label }}<template v-if="actionPending === action.id">…</template>
              </button>
            </div>
            <div
              v-if="controlActions.some((action) => action.handler === 'action' && action.enabled)"
              class="ac-approval-decision"
            >
              <label for="runtime-action-note">动作说明 / 新目标方向</label>
              <textarea
                id="runtime-action-note"
                v-model="actionNote"
                rows="3"
                maxlength="8000"
                placeholder="点击“调整方向”时，此处内容将作为新目标；暂停、停止、重试时作为可选说明。"
              />
              <p v-if="actionError" class="ac-brief-state ac-brief-state--error" role="alert">{{ actionError }}</p>
            </div>

            <div class="ac-detail-stack">
              <p v-if="detailStatus === 'pending' && !detail" class="ac-brief-state" role="status">
                正在读取项目详情…
              </p>
              <div v-else-if="detailError" class="ac-brief-state ac-brief-state--error" role="alert">
                <h2>项目详情暂时不可用</h2>
                <p>工作摘要仍可查看，但计划、运行记录和诊断证据可能不完整。</p>
                <UButton color="neutral" variant="outline" @click="refreshProjectExperience()">重新读取</UButton>
              </div>
              <section class="ac-detail-panel">
                <div class="ac-detail-heading">
                  <div>
                    <p class="ac-card-kicker">Progress</p>
                    <h2>当前进展</h2>
                  </div>
                  <strong v-if="work.progress.percent !== undefined">{{ work.progress.percent }}%</strong>
                </div>
                <div
                  class="ac-progress"
                  :aria-label="`${work.progress.completedItems} / ${work.progress.totalItems} 已完成`"
                >
                  <span :style="{ width: `${work.progress.percent ?? 0}%` }" />
                </div>
                <p class="ac-card-reason">{{ work.progress.reason.text }}</p>
                <div class="ac-card-footer">
                  <span>{{ work.progress.completedItems }} / {{ work.progress.totalItems }} 项完成</span>
                  <time :datetime="work.progress.updatedAt">
                    {{ dateTime.format(new Date(work.progress.updatedAt)) }}
                  </time>
                </div>
              </section>

              <SeedGrowOverview
                v-if="seedProject"
                :mode="detail?.project.seedMode"
                :organization="seedGrow?.organization"
                :graph="seedGrow?.graph"
                :validation="seedGrow?.validation"
                :discoveries="seedGrow?.discoveries ?? []"
                :work-items="detail?.workItems ?? []"
                :pending="seedGrowPending"
                :failed="Boolean(seedGrowError)"
              />

              <section v-if="detail?.workItems.length" class="ac-detail-panel">
                <div class="ac-detail-heading">
                  <div>
                    <p class="ac-card-kicker">Plan</p>
                    <h2>工作项与决定</h2>
                  </div>
                  <strong>{{ detail.workItems.length }}</strong>
                </div>
                <article v-for="item in detail.workItems" :key="item.id" class="ac-inline-item">
                  <h3>{{ item.title }}</h3>
                  <p v-if="item.error">{{ item.error }}</p>
                  <span>{{ workItemStatusLabel(item.status) }}</span>
                </article>
              </section>

              <section v-if="work.attentionItems.length" class="ac-detail-panel">
                <div class="ac-detail-heading">
                  <div>
                    <p class="ac-card-kicker">Attention</p>
                    <h2>需要处理</h2>
                  </div>
                  <strong>{{ work.attentionItems.length }}</strong>
                </div>
                <article v-for="item in work.attentionItems" :key="item.id" class="ac-inline-item">
                  <h3>{{ item.title }}</h3>
                  <p>{{ item.reason.text }}</p>
                  <div class="ac-work3__actions" role="group" :aria-label="`${item.title} 可用动作`">
                    <button
                      v-for="action in toControlActions(item.allowedActions)"
                      :key="action.id"
                      type="button"
                      class="ac-work3__action"
                      :disabled="!canInvoke(action) || Boolean(actionPending)"
                      :title="action.disabledReason"
                      :aria-disabled="!canInvoke(action)"
                      @click="invokeAction(action, item)"
                    >
                      {{ action.label }}<template v-if="actionPending === action.id">…</template>
                    </button>
                  </div>
                </article>
              </section>

              <section v-if="work.delivery" class="ac-detail-panel">
                <div class="ac-detail-heading">
                  <div>
                    <p class="ac-card-kicker">Delivery</p>
                    <h2>交付版本 {{ work.delivery.version }}</h2>
                  </div>
                  <span v-if="deliveryView" class="ac-status-badge" :data-stage="deliveryView.stage">{{
                    deliveryView.stateLabel
                  }}</span>
                </div>
                <p class="ac-card-reason">{{ work.delivery.reason.text }}</p>
                <p v-if="deliveryView?.awaitingUserDecision" class="ac-delivery-hint">
                  已交付但尚未验收：请在下方核对最初的验收标准后决定接受或请求修改。
                </p>
                <div v-if="work.delivery.artifacts.length" class="ac-artifact-list">
                  <NuxtLink
                    v-for="artifact in work.delivery.artifacts"
                    :key="artifact.id"
                    class="ac-artifact-link"
                    :to="artifactRoute(artifact.projectId, artifact.id)"
                  >
                    <span>
                      <strong>{{ artifact.title }}</strong>
                      <small>{{ artifactKindLabel(artifact.kind) }}</small>
                    </span>
                    <UIcon name="i-lucide-arrow-up-right" />
                  </NuxtLink>
                </div>

                <div v-if="acceptanceItems.length" class="ac-acceptance">
                  <p class="ac-card-kicker">验收标准核对</p>
                  <ul class="ac-acceptance__list">
                    <li v-for="item in acceptanceItems" :key="item.id" class="ac-acceptance__item">
                      <span class="ac-acceptance__verdict" :data-verdict="item.verdict">{{
                        criterionVerdictLabels[item.verdict]
                      }}</span>
                      <span class="ac-acceptance__text">
                        <strong>{{ item.description }}</strong>
                        <small>验证方式：{{ item.verification }}</small>
                      </span>
                    </li>
                  </ul>
                  <p class="ac-delivery-hint">
                    逐项通过 / 未通过结论需本地服务下发核对结果，当前统一标记为“未逐项核对”，不代替后端下结论。
                  </p>
                </div>
              </section>
            </div>

            <CompanyComposer
              v-if="composerTarget"
              :target="composerTarget"
              :agents="snapshot.agents"
              @sent="refreshProjectExperience()"
            />
          </template>

          <template v-else-if="work?.availability === 'unavailable'">
            <header class="ac-workspace-header">
              <div>
                <p class="ac-workspace-eyebrow">Status diagnostics</p>
                <h1 class="ac-workspace-title">{{ work.title }}</h1>
                <p class="ac-workspace-lede">{{ work.reason.text }}</p>
              </div>
              <span class="ac-status-badge" data-status="unavailable">状态不可用</span>
            </header>
          </template>

          <section v-else class="ac-empty-state">
            <div class="ac-empty-state__content">
              <span class="ac-empty-state__icon" aria-hidden="true">
                <UIcon name="i-lucide-file-question" />
              </span>
              <h1>没有找到这项工作</h1>
              <p>当前真实工作状态中没有对应记录，页面不会用临时项目数据代替。</p>
              <UButton class="ac-empty-state__action" color="neutral" to="/work">返回 Work</UButton>
            </div>
          </section>
        </section>

        <!-- 右栏：上下文面板 -->
        <aside class="ac-work3__col ac-work3__context" aria-label="上下文面板">
          <div v-if="panels.length" class="ac-work3__tabs" role="tablist">
            <button
              v-for="kind in panels"
              :key="kind"
              type="button"
              role="tab"
              class="ac-work3__tab"
              :id="`work-context-tab-${kind}`"
              :data-context-panel="kind"
              :data-active="kind === activePanel"
              :aria-selected="kind === activePanel"
              aria-controls="work-context-panel"
              :tabindex="kind === activePanel ? 0 : -1"
              @click="selectPanel(kind)"
              @keydown="navigatePanel($event, kind)"
            >
              {{ contextPanelLabels[kind] }}
            </button>
          </div>

          <div
            class="ac-work3__panel"
            role="tabpanel"
            id="work-context-panel"
            :aria-labelledby="activePanel ? `work-context-tab-${activePanel}` : undefined"
            tabindex="0"
          >
            <!-- Goal Brief -->
            <template v-if="activePanel === 'goal_brief'">
              <div v-if="goalBriefStatus === 'pending'" class="ac-brief-state">正在读取目标摘要…</div>
              <div v-else-if="goalBriefError" class="ac-brief-state ac-brief-state--error">
                <h3>目标摘要暂时不可用</h3>
                <p>未能从本地服务读取经过验证的目标信息，页面不会根据工作标题猜测。</p>
                <UButton color="neutral" variant="outline" @click="refreshGoalBrief()">重新读取</UButton>
              </div>
              <template v-else-if="goalBrief?.kind === 'goal_brief' || goalBrief?.kind === 'legacy_charter'">
                <p class="ac-brief-goal">{{ goalBrief.brief.goal }}</p>
                <dl class="ac-brief-meta">
                  <div>
                    <dt>来源</dt>
                    <dd>{{ briefSourceLabel(goalBrief.brief.source) }}</dd>
                  </div>
                  <div>
                    <dt>版本</dt>
                    <dd>{{ goalBrief.brief.version }}</dd>
                  </div>
                </dl>
                <div class="ac-brief-constraints" v-if="goalBrief.brief.constraints.length">
                  <h3>约束</h3>
                  <ul>
                    <li v-for="constraint in goalBrief.brief.constraints" :key="constraint">{{ constraint }}</li>
                  </ul>
                </div>
              </template>
            </template>

            <!-- DELIV-04 决策闭环：审批状态可读化 + 按投影如实展示的决策动作 -->
            <template v-else-if="activePanel === 'approval'">
              <article v-for="approval in detail?.gates ?? []" :key="approval.id" class="ac-inline-item">
                <h3>{{ approval.title }}</h3>
                <span class="ac-status-badge" :data-status="approval.status">{{
                  gateStatusLabel(approval.status)
                }}</span>
              </article>

              <div v-if="decisionActions.length" class="ac-approval-decision">
                <label for="approval-decision-note">决策说明（可选）</label>
                <textarea
                  id="approval-decision-note"
                  v-model="decisionNote"
                  rows="3"
                  maxlength="2000"
                  placeholder="说明批准 / 拒绝 / 请求修改的理由，便于事后追溯。"
                />
                <div class="ac-work3__actions" role="group" aria-label="审批决策">
                  <button
                    v-for="action in decisionActions"
                    :key="action.id"
                    type="button"
                    class="ac-work3__action"
                    :disabled="!canInvoke(action)"
                    :title="action.disabledReason"
                    :aria-disabled="!canInvoke(action)"
                    @click="invokeAction(action)"
                  >
                    {{ action.label }}
                  </button>
                </div>
                <p class="ac-approval-decision__boundary">
                  批准 / 拒绝 / 请求修改需在治理契约解除后开放，当前按投影如实显示禁用原因，不伪装可提交。
                </p>
              </div>
            </template>

            <!-- Artifact -->
            <template v-else-if="activePanel === 'artifact'">
              <div class="ac-artifact-list">
                <button
                  v-for="artifact in detail?.artifacts ?? []"
                  :key="artifact.id"
                  type="button"
                  class="ac-artifact-link"
                  :data-active="artifact.id === selectedArtifactID"
                  @click="selectArtifact(artifact.id)"
                >
                  <span>
                    <strong>{{ artifact.title }}</strong>
                    <small>{{ artifactKindLabel(artifact.kind) }}</small>
                  </span>
                </button>
              </div>
              <NuxtLink
                v-if="selectedArtifact && detail"
                class="ac-artifact-download"
                :to="artifactRoute(detail.project.id, selectedArtifact.id)"
              >
                <UIcon name="i-lucide-arrow-up-right" /> 打开制品
              </NuxtLink>
            </template>

            <!-- Agent -->
            <template v-else-if="activePanel === 'agent'">
              <article v-for="agent in detail?.recruitment.candidates ?? []" :key="agent.id" class="ac-inline-item">
                <h3>{{ agent.name }}</h3>
                <span>{{ agent.lifecycle }}</span>
              </article>
            </template>

            <template v-else-if="activePanel === 'thread'">
              <p v-if="projectMessagesStatus === 'pending'" class="ac-brief-state" role="status">
                正在读取项目讨论…
              </p>
              <div v-else-if="projectMessagesError" class="ac-brief-state ac-brief-state--error" role="alert">
                <h3>项目讨论暂时不可用</h3>
                <p>发送入口仍会如实返回本地服务结果，读取失败不会显示为真实空讨论。</p>
                <UButton color="neutral" variant="outline" @click="refreshProjectMessages()">重新读取</UButton>
              </div>
              <template v-else>
                <article
                  v-for="message in projectMessages"
                  :key="message.id"
                  class="ac-inline-item"
                >
                  <div class="ac-card-footer">
                    <strong>{{ message.author }}</strong>
                    <time :datetime="new Date(message.createdAt).toISOString()">
                      {{ dateTime.format(new Date(message.createdAt)) }}
                    </time>
                  </div>
                  <p>{{ message.body }}</p>
                  <span v-if="message.signalType">{{ message.signalType }}</span>
                </article>
              </template>
              <p
                v-if="projectMessagesStatus !== 'pending' && !projectMessagesError && !projectMessages.length"
                class="ac-brief-state"
              >
                当前项目频道还没有消息。
              </p>
            </template>

            <!-- Diagnostics -->
            <template v-else-if="activePanel === 'diagnostics'">
              <SeedGrowDiagnostics
                v-if="seedProject"
                :graph="seedGrow?.graph"
                :validation="seedGrow?.validation"
                :discoveries="seedGrow?.discoveries ?? []"
                :organization="seedGrow?.organization"
                :detail="detail"
                :diagnostics="workDiagnostics"
                :pending="seedGrowPending"
                :failed="Boolean(seedGrowError)"
              />
              <ul v-else class="ac-diagnostic-list">
                <li v-for="diagnostic in workDiagnostics" :key="diagnostic.id">{{ diagnostic.message }}</li>
              </ul>
            </template>

            <p v-else class="ac-brief-state">当前工作还没有可显示的上下文。</p>
          </div>
        </aside>
      </div>
    </template>
  </UDashboardPanel>
</template>
