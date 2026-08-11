<script setup lang="ts">
import type {
  AttentionItem,
  DeliveryArtifactRef,
  ExperienceWorkActionRequest,
  ExperienceWorkActionResult,
  GoalBriefProjectView,
  WorkProjection,
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
  deliveryPackageView,
  type AcceptanceChecklistItem,
} from "../../../modules/agent-company/runtime/shared/delivery-package"
import type { ComposerTarget } from "../../../modules/agent-company/runtime/shared/company-composer"
import { diagnosticsCount } from "../../../modules/agent-company/runtime/shared/seed-grow-view"
import { safeExecutionSummary } from "../../../modules/agent-company/runtime/shared/execution-diagnostics"

const route = useRoute()
const appConfig = useAppConfig()
const { data: snapshot, pending, refresh, signalVersion } = useCompanySnapshot()
const workID = computed(() =>
  Array.isArray(route.params.projectID) ? route.params.projectID[0] : route.params.projectID,
)
const available = computed(() => ["ready", "degraded"].includes(snapshot.value.connection))
const workUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("work") ?? false)
const {
  data: archivedWork,
  refresh: refreshArchivedWork,
} = useFetch<WorkProjection[]>("/api/agent-company/archived-work", {
  default: () => [],
})
const restoringWork = ref(route.query.restored === "1")
const work = computed(() =>
  snapshot.value.work.find(
    (item) => (item.availability === "available" ? item.summary.workId : item.workId) === workID.value,
  ) ?? archivedWork.value.find(
    (item) => (item.availability === "available" ? item.summary.workId : item.workId) === workID.value,
  ),
)
const isArchivedWork = computed(() =>
  archivedWork.value.some(
    item => (item.availability === "available" ? item.summary.workId : item.workId) === workID.value,
  ),
)

const workList = computed(() =>
  snapshot.value.work.map((item) =>
    item.availability === "available"
      ? { id: item.summary.workId, title: item.summary.title, status: item.summary.userStatus, ok: true as const }
      : { id: item.workId, title: item.title, status: "unavailable", ok: false as const },
  ),
)
const currentWorkEntry = computed(() =>
  workList.value.find((entry) => entry.id === workID.value)
  ?? (work.value?.availability === "available"
    ? {
        id: work.value.summary.workId,
        title: work.value.summary.title,
        status: work.value.summary.userStatus,
        ok: true as const,
      }
    : undefined),
)
const historicalWorkList = computed(() => workList.value.filter((entry) => entry.id !== workID.value))

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
const recordedUserAnswers = computed(() =>
  goalBrief.value?.kind === "goal_brief"
    ? goalBrief.value.brief.assumptions.filter(item => item.id.startsWith("answer-"))
    : [],
)
const systemAssumptions = computed(() =>
  goalBrief.value?.kind === "goal_brief"
    ? goalBrief.value.brief.assumptions.filter(item => !item.id.startsWith("answer-"))
    : [],
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
const runtimeRefreshPending = ref(false)
const runtimeRefreshTimer = ref<ReturnType<typeof setInterval>>()

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
    refreshArchivedWork(),
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

function refreshRuntimeExperience() {
  if (runtimeRefreshPending.value) return
  runtimeRefreshPending.value = true
  void Promise.all([refresh(), refreshDetail()]).finally(() => {
    runtimeRefreshPending.value = false
  })
}

async function refreshRestoredProject() {
  restoringWork.value = true
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await refreshProjectExperience()
    if (work.value?.availability === "available") break
    await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
  }
  restoringWork.value = false
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
const deliveryArtifacts = computed(() =>
  work.value?.availability === "available" ? work.value.delivery?.artifacts ?? [] : [],
)
const currentDeliveryVersion = computed(() =>
  work.value?.availability === "available" ? work.value.delivery?.version : undefined,
)
const workspaceHeadline = computed(() => {
  if (work.value?.availability !== "available") return ""
  const projection = work.value
  const artifactCount = projection.delivery?.artifacts.length ?? 0
  if (projection.summary.userStatus === "accepted") return "交付已验收"
  if (projection.delivery && projection.summary.needsUserAction)
    return `${artifactCount} 项成果待你验收`
  if (projection.summary.needsUserAction) return "团队需要你的决定"
  if (projection.summary.userStatus === "paused") return "工作已暂停"
  if (projection.progress.totalItems)
    return `${projection.progress.completedItems} / ${projection.progress.totalItems} 项工作已完成`
  return humanLabel(projection.summary.phase)
})
const featuredDeliveryArtifacts = computed(() => {
  const prioritized = deliveryArtifacts.value.filter(artifact =>
    /视觉|设计|界面|画布|线框|原型|图稿|稿件/.test(artifact.title),
  )
  const seen = new Set<string>()
  return [...prioritized, ...deliveryArtifacts.value].filter((artifact) => {
    if (seen.has(artifact.id)) return false
    seen.add(artifact.id)
    return true
  }).slice(0, 3)
})
const workModelLabels = computed(() => [
  ...new Set((detail.value?.agentRuns ?? []).flatMap(run =>
    run.model ? [run.model.split("/").at(-1) ?? run.model] : [])),
])
const workUsageSummary = computed(() => {
  const usage = detail.value?.usage
  if (!usage) return "用量与费用暂不可见"
  const hasTokenUsage = usage.total > 0 || usage.input > 0 || usage.output > 0
  const tokens = hasTokenUsage ? `${usage.total.toLocaleString()} tokens` : "用量未返回"
  const cost = usage.cost > 0 ? `费用 ${usage.cost.toLocaleString()}` : "费用未返回，请以 Provider 账单为准"
  return `${usage.runCount} 次模型运行 · ${tokens} · ${cost}${hasTokenUsage || usage.cost > 0 ? "" : "，不能按 0 计算"}`
})
const formedTeamMembers = computed(() => {
  const seen = new Set<string>()
  return (detail.value?.recruitment.selections ?? []).flatMap((selection) => {
    if (selection.decision !== "selected" || seen.has(selection.agentID)) return []
    seen.add(selection.agentID)
    return [{
      id: selection.agentID,
      name: agentDisplayName(selection.agentID),
      role: detail.value?.recruitment.needs.find(need => need.id === selection.capabilityNeedID)?.role
        ?? "项目角色",
      reason: selection.reason.replace(/^入选[：:]\s*/, "").split("。")[0],
      released: selection.released,
      active: detail.value?.workItems.some(item =>
        item.ownerAgentID === selection.agentID
        && !["completed", "superseded", "cancelled"].includes(item.status),
      ) ?? false,
      responsibilities: detail.value?.workItems
        .filter(item => item.ownerAgentID === selection.agentID && item.kind !== "project_planning")
        .map(item => humanLabel(item.role || item.title))
        .filter((item, index, values) => values.indexOf(item) === index)
        .slice(0, 3) ?? [],
    }]
  })
})

function memberStatusLabel(member: { released: boolean; active: boolean }) {
  if (member.active) return "正在参与"
  if (work.value?.availability === "available" && work.value.delivery && !deliveryAccepted.value)
    return "任务已结束 · 等待你验收"
  if (member.released) return "任务已结束 · 执行分配已结束"
  return "任务已结束"
}

function artifactDeliverableIDs(artifact: DeliveryArtifactRef) {
  const persisted = detail.value?.artifacts.find(candidate => candidate.id === artifact.id)
  const item = detail.value?.workItems.find(candidate => candidate.id === persisted?.workItemID)
  return new Set([
    ...`${item?.sourceTaskKey ?? ""}`.matchAll(/D(?:10|[1-9])/gi),
    ...artifact.title.matchAll(/D(?:10|[1-9])/gi),
  ].map(match => match[0]!.toUpperCase()))
}

function acceptanceEvidenceArtifacts(item: AcceptanceChecklistItem) {
  const artifacts = deliveryArtifacts.value
  if (!artifacts.length) return []
  const criterion = `${item.description} ${item.verification}`
  if (
    /(?:全部|所有)(?:产出|成果|交付物)|汇编|全套成果|交付过程及内容|工作记录与交付内容|成果未涉及禁止/.test(criterion)
    || /禁用素材|禁止的外部行动|不包含真实 Logo|未发生.*(?:外部行动|发布|上传|外发|付款|采购)/.test(criterion)
  )
    return artifacts
  const deliverableIDs = new Set(
    [...criterion.matchAll(/\bD\d+\b/gi)].map(match => match[0].toUpperCase()),
  )
  const range = criterion.match(/\bD(\d+)\s*(?:至|到|-)\s*D(\d+)\b/i)
  if (range) {
    const start = Number(range[1])
    const end = Number(range[2])
    Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => `D${start + index}`)
      .forEach(id => deliverableIDs.add(id))
  }
  ;[
    { id: "D1", pattern: /竞品观察|观察框架/ },
    { id: "D2", pattern: /信息架构|模块顺序|信息层级/ },
    { id: "D3", pattern: /视觉方向|可视比较|版式.*色彩/ },
    { id: "D4", pattern: /中文首屏文案|文案不将|事实主张/ },
    { id: "D5", pattern: /风险与约束|风险边界/ },
    { id: "D6", pattern: /人工验收清单|评审项|逐项核验/ },
  ].filter(item => item.pattern.test(criterion)).forEach(item => deliverableIDs.add(item.id))
  const directMatches = artifacts.filter(artifact =>
    [...artifactDeliverableIDs(artifact)].some(id => deliverableIDs.has(id)),
  )
  if (directMatches.length) return directMatches
  if (/过程|台账|版本|失败记录|暂停|恢复|重试|动态组队|责任|加入理由/.test(criterion))
    return artifacts.filter((artifact) => {
      const persisted = detail.value?.artifacts.find(candidate => candidate.id === artifact.id)
      const workItem = detail.value?.workItems.find(candidate => candidate.id === persisted?.workItemID)
      return ["review-ledger", "d6-human-review-package"].includes(workItem?.sourceTaskKey ?? "")
        || artifactDeliverableIDs(artifact).has("D6")
        || /^d6-|human.*review/i.test(workItem?.sourceTaskKey ?? "")
        || /台账|执行状态模板|人工.*验收.*(?:清单|索引|包)/.test(artifact.title)
    })
  return []
}
const acceptanceCheckStore = useState<Record<string, Record<string, boolean>>>(
  "work-acceptance-checks",
  () => ({}),
)
const acceptanceCheckKey = computed(() => {
  const delivery = work.value?.availability === "available" ? work.value.delivery : undefined
  return workID.value && delivery ? `${workID.value}:${delivery.id}:${delivery.version}` : ""
})
const acceptanceChecks = computed(() =>
  acceptanceCheckKey.value ? acceptanceCheckStore.value[acceptanceCheckKey.value] ?? {} : {},
)
const deliveryAccepted = computed(
  () =>
    work.value?.availability === "available"
    && (
      work.value.summary.userStatus === "accepted"
      || work.value.delivery?.acceptanceState === "accepted"
    ),
)
const awaitingUserAcceptance = computed(
  () => work.value?.availability === "available" && Boolean(work.value.delivery) && !deliveryAccepted.value,
)
const acceptedCriterionIDs = computed(() =>
  acceptanceItems.value.filter((item) => acceptanceChecks.value[item.id]).map((item) => item.id),
)
const allAcceptanceCriteriaChecked = computed(
  () => acceptanceItems.value.length > 0 && acceptedCriterionIDs.value.length === acceptanceItems.value.length,
)

function updateAcceptanceCheck(itemID: string, event: Event) {
  if (deliveryAccepted.value) return
  const key = acceptanceCheckKey.value
  if (!key) return
  const checked = (event.currentTarget as HTMLInputElement).checked
  acceptanceCheckStore.value = {
    ...acceptanceCheckStore.value,
    [key]: {
      ...(acceptanceCheckStore.value[key] ?? {}),
      [itemID]: checked,
    },
  }
}

const remainingWorkItems = computed(() =>
  detail.value?.workItems.filter(
    (item) => !["completed", "cancelled", "superseded"].includes(item.status),
  ) ?? [],
)
const currentPlanWorkItems = computed(() => {
  const items = detail.value?.workItems ?? []
  const activePlanVersion = detail.value?.project.activePlanVersion
  if (!activePlanVersion || !items.some((item) => item.planVersion))
    return items.filter((item) => item.status !== "superseded")
  return items.filter((item) => item.planVersion === activePlanVersion)
})
const historicalPlanWorkItems = computed(() => {
  const items = detail.value?.workItems ?? []
  const current = new Set(currentPlanWorkItems.value.map((item) => item.id))
  return items.filter((item) => !current.has(item.id))
})
const executionEvidenceKinds = new Set([
  "attempt_failure",
  "system_verification",
  "independent_review",
  "project_charter",
])
const currentPlanArtifacts = computed(() => {
  const artifacts = detail.value?.artifacts ?? []
  const activePlanVersion = detail.value?.project.activePlanVersion
  return artifacts
    .filter(artifact =>
      !activePlanVersion || artifact.planVersion === undefined || artifact.planVersion === activePlanVersion)
    .toSorted((left, right) => right.createdAt - left.createdAt)
})
const currentDeliveryArtifactIDs = computed(() =>
  new Set(deliveryArtifacts.value.map(artifact => artifact.id)),
)
const planDeliveryArtifacts = computed(() =>
  currentPlanArtifacts.value.filter(artifact => !executionEvidenceKinds.has(artifact.kind)),
)
const currentDeliveryArtifacts = computed(() =>
  currentDeliveryArtifactIDs.value.size
    ? planDeliveryArtifacts.value.filter(artifact => currentDeliveryArtifactIDs.value.has(artifact.id))
    : planDeliveryArtifacts.value,
)
const previousDeliveryArtifacts = computed(() =>
  currentDeliveryArtifactIDs.value.size
    ? planDeliveryArtifacts.value.filter(artifact => !currentDeliveryArtifactIDs.value.has(artifact.id))
    : [],
)
const currentExecutionEvidence = computed(() =>
  currentPlanArtifacts.value.filter(artifact => executionEvidenceKinds.has(artifact.kind)),
)
const historicalPlanArtifacts = computed(() => {
  const activePlanVersion = detail.value?.project.activePlanVersion
  if (!activePlanVersion) return []
  return (detail.value?.artifacts ?? [])
    .filter(artifact => artifact.planVersion !== undefined && artifact.planVersion !== activePlanVersion)
    .toSorted((left, right) => right.createdAt - left.createdAt)
})
const executionEstimate = computed(() => {
  if (work.value?.availability !== "available") return
  if (!["running", "reviewing"].includes(work.value.summary.userStatus)) return
  if (!remainingWorkItems.value.length) return
  const completedAttempts =
    detail.value?.workAttempts.filter(
      (attempt) => attempt.status === "completed" && attempt.finishedAt && attempt.finishedAt > attempt.startedAt,
    ) ?? []
  const completedWorkItems = new Set(completedAttempts.map((attempt) => attempt.workItemID)).size
  const startedAt = Math.min(...completedAttempts.map((attempt) => attempt.startedAt))
  const finishedAt = Math.max(...completedAttempts.map((attempt) => attempt.finishedAt ?? attempt.startedAt))
  const elapsedMinutes = (finishedAt - startedAt) / 60_000
  if (completedWorkItems < 2 || elapsedMinutes < 0.5)
    return "当前完成样本不足，暂不显示分钟级预计时间；执行会并行推进，复核返工时会延长。"
  const minutesPerCompletedItem = elapsedMinutes / completedWorkItems
  const estimate = minutesPerCompletedItem * remainingWorkItems.value.length
  const lower = Math.max(1, Math.floor(estimate * 0.75))
  const upper = Math.max(lower + 1, Math.ceil(estimate * 1.5))
  return `按本项目实际完成速度估算，还需约 ${lower}–${upper} 分钟；并行度变化或复核返工时会调整。`
})
const recoveredFailureCount = computed(() =>
  detail.value?.workAttempts.filter((attempt) => attempt.status === "failed").length ?? 0,
)

const workDiagnostics = computed(() => work.value?.diagnostics ?? [])
const diagnosticGroups = computed(() =>
  Object.values(
    workDiagnostics.value.reduce<Record<string, { id: string; message: string; count: number }>>((groups, item) => {
      const current = groups[item.message]
      groups[item.message] = current
        ? { ...current, count: current.count + 1 }
        : { id: item.id, message: item.message, count: 1 }
      return groups
    }, {}),
  ),
)

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
      (detail.value?.workAttempts.length ?? 0) +
      diagnosticsCount(seedGrow.value?.graph, seedGrow.value?.validation) +
      (seedGrow.value?.acceptance.availability === "available" ? seedGrow.value.acceptance.trackedWorkItemCount : 0) +
      (seedProject.value ? 1 : 0),
  }),
)

// 每个项目独立保存视图状态，切换项目时校正以避免残留上一项目的上下文。
const viewStore = useState<Record<string, WorkspaceViewState>>("work-workspace-view", () => ({}))
const column = ref<WorkspaceColumn>("main")
const activePanel = ref<ContextPanelKind>()
const hydrated = ref(false)
const selectedArtifactID = ref<string>()
const selectedAgentID = ref<string>()
const renderedActivePanel = computed(() => hydrated.value ? activePanel.value : panels.value[0])

onMounted(() => {
  hydrated.value = true
  if (route.query.restored === "1") void refreshRestoredProject()
  runtimeRefreshTimer.value = setInterval(() => {
    if (
      work.value?.availability === "available"
      && ["running", "reviewing", "revision"].includes(work.value.summary.userStatus)
    )
      refreshRuntimeExperience()
  }, 5_000)
})

onBeforeUnmount(() => {
  if (runtimeRefreshTimer.value) clearInterval(runtimeRefreshTimer.value)
})

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
const revisionImpactPreview = computed(() => {
  const reason = actionNote.value.trim()
  const activePlanVersion = detail.value?.project.activePlanVersion
  const items = detail.value?.workItems.filter(item =>
    !activePlanVersion || item.planVersion === undefined || item.planVersion === activePlanVersion) ?? []
  if (!reason || !items.length || !controlActions.value.some(action => action.id === "request_change" && action.enabled))
    return
  const focused = reason.match(
    /(?:重点|仅|只)(?:需要|需)?(?:更新|修改|调整|重做|重写|修订)?([^。；;\n]+)/i,
  )?.[1]
  const focusedReferences = new Set(
    [...(focused ?? "").matchAll(/D(?:10|[1-9])/gi)].map(match => match[0]!.toUpperCase()),
  )
  const references = focusedReferences.size
    ? focusedReferences
    : new Set([...reason.matchAll(/D(?:10|[1-9])/gi)].map(match => match[0]!.toUpperCase()))
  const itemReferences = (item: typeof items[number]) => {
    const sourceReferences = [...`${item.sourceTaskKey ?? ""}`.matchAll(/D(?:10|[1-9])/gi)]
      .map(match => match[0]!.toUpperCase())
    if (sourceReferences.length) return new Set(sourceReferences)
    const titleReference = item.title.match(/D(?:10|[1-9])/i)?.[0]
    return new Set(titleReference ? [titleReference.toUpperCase()] : [])
  }
  const runBudget = (item: typeof items[number]) =>
    Math.max(item.maxAttempts, item.attempt + 1) - item.attempt
  const direct = items.filter(item => [...itemReferences(item)].some(reference => references.has(reference)))
  if (!direct.length)
    return {
      direct: [],
      dependent: [],
      total: items.length,
      totalItems: items.length,
      maxModelRuns: items.reduce((total, item) => total + runBudget(item), 0),
      uncertain: true,
    }
  const expand = (ids: Set<string>): Set<string> => {
    const next = new Set([
      ...ids,
      ...items.filter(item => item.dependsOn.some(id => ids.has(id))).map(item => item.id),
    ])
    return next.size === ids.size ? next : expand(next)
  }
  const directIDs = new Set(direct.map(item => item.id))
  const affectedIDs = expand(directIDs)
  const affected = items.filter(item => affectedIDs.has(item.id))
  const label = (item: typeof items[number]) => {
    const id = `${item.sourceTaskKey ?? ""}\n${item.title}`.match(/D(?:10|[1-9])/i)?.[0]?.toUpperCase()
    if (!id) return humanLabel(item.title)
    return `${id}${/独立复核/.test(item.title) ? "（独立复核）" : ""}`
  }
  return {
    direct: direct.map(label),
    dependent: affected.filter(item => !directIDs.has(item.id)).map(label),
    total: affectedIDs.size,
    totalItems: items.length,
    maxModelRuns: affected.reduce((total, item) => total + runBudget(item), 0),
    uncertain: false,
  }
})
const pendingActionIntents = useState<Record<string, ExperienceWorkActionRequest>>(
  "work-pending-action-intents",
  () => ({}),
)

function canInvokeFromUI(action: ControlAction) {
  if (!canInvoke(action)) return false
  if (action.id === "accept_delivery") return allAcceptanceCriteriaChecked.value
  if (action.id === "request_change") return Boolean(actionNote.value.trim())
  return true
}

function actionTitle(action: ControlAction) {
  if (action.disabledReason) return action.disabledReason
  if (action.id === "accept_delivery" && !allAcceptanceCriteriaChecked.value) return "请先逐项核对全部验收标准。"
  if (action.id === "request_change" && !actionNote.value.trim()) return "请先填写需要修改的内容。"
}

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
    const directionSummary = `方向调整（目标摘要版本 ${goalBrief.value.brief.version + 1}）：${goal}`
    const retainedGoalLength = Math.max(0, 8_000 - directionSummary.length - 2)
    const mergedGoal = `${brief.goal.slice(0, retainedGoalLength)}\n\n${directionSummary}`.trim()
    const directionID = `current-direction-v${goalBrief.value.brief.version + 1}`
    const directionConstraint = "当前方向与既有结构化字段冲突时，以当前方向为准"
    const alignedBrief = {
      ...brief,
      goal: mergedGoal,
      deliverables: [
        { id: directionID, title: "当前方向", description: goal },
        ...brief.deliverables.filter((item) => !item.id.startsWith("current-direction-v")).slice(0, 99),
      ],
      acceptanceCriteria: [
        {
          id: directionID,
          description: `最终交付必须完整满足当前方向：${goal}`,
          verification: "逐项核对最终成果与当前方向的一致性",
        },
        ...brief.acceptanceCriteria.filter((item) => !item.id.startsWith("current-direction-v")).slice(0, 199),
      ],
      constraints: [
        directionConstraint,
        ...brief.constraints.filter((item) => item !== directionConstraint).slice(0, 99),
      ],
      recommendedPlan: {
        ...brief.recommendedPlan,
        summary: `根据当前方向重建执行计划：${goal}`.slice(0, 8_000),
      },
    }
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
          brief: alignedBrief,
          changeReason: `在现有目标上追加当前方向：「${goal}」`.slice(0, 8_000),
      },
    }
  }
  if (action.id === "accept_delivery") {
    const delivery = work.value?.availability === "available" ? work.value.delivery : undefined
    if (!delivery || !allAcceptanceCriteriaChecked.value) return
    const key = actionIntentKey(action)
    return {
      key,
      body:
        pendingActionIntents.value[key] ?? {
          idempotencyKey: crypto.randomUUID(),
          expectedGraphRevision: graphRevision,
          action: "accept_delivery",
          deliveryId: delivery.id,
          acceptedCriterionIds: acceptedCriterionIDs.value,
          note: actionNote.value.trim() || undefined,
        },
    }
  }
  if (action.id === "request_change") {
    const delivery = work.value?.availability === "available" ? work.value.delivery : undefined
    const reason = actionNote.value.trim()
    if (!delivery || !reason) return
    const key = actionIntentKey(action)
    return {
      key,
      body:
        pendingActionIntents.value[key] ?? {
          idempotencyKey: crypto.randomUUID(),
          expectedGraphRevision: graphRevision,
          action: "request_change",
          deliveryId: delivery.id,
          reason,
      },
    }
  }
  if (action.id === "archive" || action.id === "restore") {
    const key = actionIntentKey(action)
    return {
      key,
      body:
        pendingActionIntents.value[key] ?? {
          idempotencyKey: crypto.randomUUID(),
          expectedGraphRevision: graphRevision,
          action: action.id,
        },
    }
  }
  const key = actionIntentKey(action, action.id === "retry" ? attention?.id : undefined)
  const idempotencyKey = crypto.randomUUID()
  const reason = actionNote.value.trim() || undefined
  if (action.id === "pause_work")
    return {
      key,
      body: pendingActionIntents.value[key] ?? {
        idempotencyKey,
        expectedGraphRevision: graphRevision,
        action: "pause_work",
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
        workItemIds: attention?.id.startsWith("work-item:") ? [attention.id.slice("work-item:".length)] : undefined,
        reason,
      },
    }
}

async function invokeAction(action: ControlAction, attention?: AttentionItem) {
  if (!canInvoke(action)) return
  if (action.id === "accept_delivery" && !allAcceptanceCriteriaChecked.value) {
    actionError.value = "请先逐项核对全部验收标准，再验收交付。"
    return
  }
  if (action.id === "request_change" && !actionNote.value.trim()) {
    actionError.value = "请先填写需要修改的具体内容。"
    return
  }
  if (action.handler === "navigate_progress" || action.handler === "open_delivery") {
    column.value = "main"
    persist()
    return
  }
  if (action.handler === "open_diagnostics") return selectPanel("diagnostics")
  if (action.handler === "open_evidence") return selectPanel("goal_brief")
  if (!["action", "retry"].includes(action.handler) || actionPending.value) return
  if (
    action.id === "stop_work" &&
    !window.confirm("停止后，未完成工作会立即取消，已完成成果与执行记录仍会保留。确认停止这项工作吗？")
  )
    return
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
        ? "请填写希望系统如何处理，例如“保留现有目标并重试一次”。系统会按当前目标版本提交；版本已变化时会安全拒绝，不会覆盖新状态。"
        : "当前工作结构版本不可用，不能提交运行时动作。"
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
    if (outcome.value.status === "applied") {
      if (action.id !== "pause_work") actionNote.value = ""
      if (action.id === "archive") {
        await Promise.all([refresh(), refreshArchivedWork()])
        actionPending.value = undefined
        await navigateTo({ path: "/work", query: { archived: workID.value } })
        return
      }
      if (action.id === "restore") {
        await Promise.all([refresh(), refreshArchivedWork()])
        await navigateTo({ path: `/work/${encodeURIComponent(workID.value ?? "")}`, query: { restored: "1" } })
        await nextTick()
        await refreshRestoredProject()
        actionPending.value = undefined
        return
      }
    }
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
  return "旧项目范围"
}
function briefApprovalLabel(mode: string) {
  if (mode === "autonomous") return "自主推进"
  if (mode === "strict") return "严格审批"
  return "平衡审批"
}
function artifactKindLabel(kind: string) {
  if (kind === "analysis") return "分析成果"
  if (kind === "independent_review") return "独立复核"
  if (kind === "system_verification") return "系统核验"
  if (kind === "attempt_failure") return "未完成尝试"
  if (kind === "project_charter") return "项目范围与计划"
  if (kind === "report") return "报告"
  if (kind === "file") return "文件"
  if (kind === "link") return "链接"
  return "成果"
}
function agentLifecycleLabel(lifecycle: string) {
  return ({
    employee: "正式员工",
    candidate: "项目候选角色",
    temporary: "项目临时角色",
    released: "执行责任已结束",
  } as Record<string, string>)[lifecycle] ?? lifecycle
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
    superseded: "已由新计划替代",
    cancelled: "已取消",
  }
  return labels[status] ?? status
}
function attemptStatusLabel(status: string) {
  const labels: Record<string, string> = {
    running: "进行中",
    completed: "已完成",
    failed: "未通过",
    interrupted: "已中断",
    cancelled: "已取消",
  }
  return labels[status] ?? status
}
function attemptsForWorkItem(workItemID: string) {
  return (detail.value?.workAttempts ?? [])
    .filter((attempt) => attempt.workItemID === workItemID)
    .toSorted((left, right) => left.ordinal - right.ordinal)
}
function failedAttemptsForWorkItem(workItemID: string) {
  return attemptsForWorkItem(workItemID).filter((attempt) => attempt.status === "failed")
}
function humanLabel(value: string) {
  const labels: Record<string, string> = {
    CEO: "首席执行官",
    ceo: "首席执行官",
    CTO: "技术负责人",
    cto: "技术负责人",
    "Product Lead": "产品负责人",
    product_lead: "产品负责人",
    "board-product-lead": "产品负责人",
    "project-planner": "项目规划负责人",
    "project-wayfinder": "项目边界负责人",
    "project-builder": "项目执行负责人",
    blocked: "受阻",
    superseded: "已由新计划替代",
  }
  return (labels[value] ?? value)
    .replace(/\s+independent reviewer\b/gi, "（独立复核）")
    .replace(/\bParent(?:\s+delivery)?\s+artifacts? bytes are persisted\b/gi, "上游交付成果已持久保存")
    .replace(/\bSuperseded by active plan\s+cpln_[A-Za-z0-9]+\b/gi, "已由当前计划替代")
    .replace(/\bcpln_[A-Za-z0-9]+\b/g, "当前计划")
    .replace(/\bsuperseded\b/gi, "已由新计划替代")
    .replace(/本次闭环的董事会决策记录人/g, "项目规划负责人")
    .replace(/跨项目候选证据分析执行人/g, "方案分析负责人")
    .replace(/执行角色/g, "负责人")
    .replace(/执行人/g, "负责人")
    .replace(/\bControl Plane Verification\b/gi, "系统核验")
    .replace(/\bDelivery Ready\b/gi, "交付就绪")
    .replace(/\bDelivery Accepted\b/gi, "交付验收")
    .replace(/\bDelivery Revision\b/gi, "交付返修")
    .replace(/\bdelivery\.ready\b/gi, "交付就绪")
    .replace(/\bDelivery v(\d+)\b/gi, "交付版本 $1")
    .replace(/\bAttempt\s*(\d+)/gi, "第 $1 次尝试")
    .replace(/\bProject Charter\b/gi, "项目章程")
    .replace(/\bCharter\b/gi, "工作章程")
    .replace(/\bDelivery\b/gi, "交付")
    .replace(/\bArtifacts?\b/gi, "成果")
    .replace(/\bcompleted\b/gi, "完成")
    .replace(/\bSections\b/gi, "章节")
    .replace(/\bWordCount\b/gi, "字数")
    .replace(/持久化\s+成果/g, "持久化成果")
    .replace(/定义\s+工作章程\s+与任务树/g, "定义工作章程与任务树")
    .replace(/项目章程\s+与动态任务计划/g, "项目章程与动态任务计划")
}
function agentDisplayName(agentID?: string) {
  if (!agentID) return "待分配"
  const observed = snapshot.value.agents.find((agent) => agent.id === agentID)?.name
    ?? detail.value?.recruitment.candidates.find((agent) => agent.id === agentID)?.name
  if (observed && observed !== agentID) return humanLabel(observed)
  const labels: Record<string, string> = {
    "board-product-lead": "产品负责人",
    "project-planner": "项目规划负责人",
    "project-wayfinder": "项目边界负责人",
    "project-builder": "项目执行负责人",
  }
  return humanLabel(labels[agentID] ?? agentID)
}
function lifecycleLabel(lifecycle: string) {
  const labels: Record<string, string> = {
    candidate: "候选角色",
    assigned: "已分配",
    employee: "正式成员",
    archived: "已归档",
  }
  return labels[lifecycle] ?? lifecycle
}
function signalTypeLabel(signalType: string) {
  const labels: Record<string, string> = {
    conclusion: "结论",
    decision: "决定",
    plan: "计划",
    status: "进展",
    risk: "风险与恢复",
    approval: "审批",
    delivery: "交付",
    intervention: "人工介入",
  }
  return labels[signalType] ?? signalType
}

function projectMessageAuthor(author: string) {
  if (author === "你" || author === "系统") return author
  return humanLabel(detail.value?.recruitment.candidates.find((candidate) => candidate.id === author)?.name
    ?? snapshot.value.agents.find((agent) => agent.id === author)?.name
    ?? "项目成员")
}
function workItemReviewLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "待复核",
    running: "复核中",
    accepted: "复核通过",
    rejected: "复核退回",
    not_required: "无需复核",
  }
  return labels[status] ?? status
}
function workItemErrorMessage(error: string) {
  if (/SQLiteError|constraint failed|Cause\(\[Die\(/i.test(error))
    return "本次执行未能保存完整运行记录。现有目标与成果不会因此被删除；请先刷新状态，若问题仍在，再填写处理说明后重试一次。"
  if (/(?:Seed project|Project) has exhausted a work-item retry budget/i.test(error))
    return "该工作项要求当前本地团队无法取得的现实世界证据，并已用尽重试次数。请补齐外部证据后重试，或停止后以“本地准备包 + 人工检查点”为边界重新开始。"
  if (/Research is not cross-validated/i.test(error))
    return "研究结论缺少至少两个独立来源的交叉验证。请补充可核验来源，并明确哪些结论仍是假设。"
  return safeExecutionSummary(humanLabel(error))
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
              全部工作
            </NuxtLink>
          </div>
          <nav class="ac-work3__list-items">
            <p class="ac-card-kicker">{{ isArchivedWork ? "已归档工作" : "当前工作" }}</p>
            <NuxtLink
              v-if="currentWorkEntry"
              :to="`/work/${encodeURIComponent(currentWorkEntry.id)}`"
              class="ac-work3__list-item"
              data-active="true"
            >
              <span class="ac-work3__list-title">{{ currentWorkEntry.title }}</span>
              <span class="ac-status-badge" :data-status="currentWorkEntry.ok ? currentWorkEntry.status : 'unavailable'">
                {{ currentWorkEntry.ok ? appConfig.experience.statusLabels[currentWorkEntry.status] : "状态不可用" }}
              </span>
            </NuxtLink>
            <details v-if="historicalWorkList.length" class="ac-source-trace">
              <summary>历史工作（{{ historicalWorkList.length }}）</summary>
              <NuxtLink
                v-for="entry in historicalWorkList"
                :key="entry.id"
                :to="`/work/${encodeURIComponent(entry.id)}`"
                class="ac-work3__list-item"
              >
                <span class="ac-work3__list-title">{{ entry.title }}</span>
                <span class="ac-status-badge" :data-status="entry.ok ? entry.status : 'unavailable'">
                  {{ entry.ok ? appConfig.experience.statusLabels[entry.status] : "状态不可用" }}
                </span>
              </NuxtLink>
            </details>
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

          <div v-else-if="restoringWork" class="ac-empty-state" role="status">
            <div class="ac-empty-state__content">
              <span class="ac-empty-state__icon" aria-hidden="true">
                <UIcon name="i-lucide-refresh-cw" />
              </span>
              <h1>正在恢复这项工作</h1>
              <p>正在重新读取目标、讨论、执行记录与成果，恢复完成前不会显示为空项目。</p>
            </div>
          </div>

          <template v-else-if="work?.availability === 'available'">
            <header class="ac-workspace-header">
              <div>
                <p class="ac-workspace-eyebrow">{{ work.summary.phase }}</p>
                <h1 class="ac-workspace-title">{{ workspaceHeadline }}</h1>
                <p class="ac-workspace-goal" :title="humanLabel(work.summary.title)">
                  {{ humanLabel(work.summary.title) }}
                </p>
                <p class="ac-workspace-lede">{{ humanLabel(work.summary.reason.text) }}</p>
                <!-- DELIV-02 — 首屏直接回答“谁负责 / 下一里程碑 / 是否需用户行动” -->
                <div class="ac-work-meta">
                  <span>工作 #{{ work.summary.workId.slice(-8) }}</span>
                  <span v-if="work.summary.owner">负责人：{{ agentDisplayName(work.summary.owner.id) }}</span>
                  <span v-if="work.summary.nextMilestone">
                    下一里程碑：{{ humanLabel(work.summary.nextMilestone.title) }}
                    <small v-if="work.summary.nextMilestone.completed">（已完成）</small>
                  </span>
                  <span v-if="work.summary.needsUserAction" class="ac-work-meta__flag">需要你的行动</span>
                </div>
              </div>
              <span class="ac-status-badge" :data-status="isArchivedWork ? 'archived' : work.summary.userStatus">
                {{ isArchivedWork ? "已归档" : appConfig.experience.statusLabels[work.summary.userStatus] }}
              </span>
            </header>

            <section class="ac-runtime-boundary" aria-label="数据与模型边界">
              <div>
                <span>公司记录</span>
                <strong>保存在本机</strong>
              </div>
              <div>
                <span>模型处理</span>
                <strong>{{ workModelLabels.join("、") || snapshot.company.provider || "已连接模型服务" }}</strong>
              </div>
              <div>
                <span>运行与费用</span>
                <strong>{{ workUsageSummary }}</strong>
              </div>
              <p>
                “本地工作区”不等于“仅在本机推理”：生成与执行内容会发送给已连接的模型服务。
                若 NDA 禁止该传输，请先停止工作并切换到符合要求的本地模型。
              </p>
            </section>

            <section v-if="formedTeamMembers.length" class="ac-formed-team" aria-label="本项目动态团队">
              <div class="ac-formed-team__heading">
                <div>
                  <p class="ac-card-kicker">动态团队</p>
                  <strong>围绕这项工作形成了 {{ formedTeamMembers.length }} 个角色</strong>
                </div>
                <button type="button" @click="selectPanel('agent')">查看项目成员</button>
              </div>
              <ul>
                <li v-for="member in formedTeamMembers.slice(0, 6)" :key="member.id">
                  <span aria-hidden="true">{{ member.name.slice(0, 1) }}</span>
                  <div>
                    <strong>{{ member.name }}</strong>
                    <small>{{ humanLabel(member.role) }} · {{ memberStatusLabel(member) }}</small>
                  </div>
                </li>
              </ul>
            </section>

            <section v-if="work.delivery" class="ac-delivery-focus" aria-labelledby="delivery-focus-title">
              <div>
                <p class="ac-card-kicker">本轮结果</p>
                <h2 id="delivery-focus-title">{{ work.delivery.artifacts.length }} 项成果已经形成</h2>
                <p>先看最能代表结果的成果，再决定验收或请求修改。</p>
              </div>
              <nav aria-label="重点成果">
                <NuxtLink
                  v-for="artifact in featuredDeliveryArtifacts"
                  :key="artifact.id"
                  :to="artifactRoute(artifact.projectId, artifact.id)"
                >
                  <span>{{ artifactKindLabel(artifact.kind) }}</span>
                  <strong>{{ humanLabel(artifact.title) }}</strong>
                  <UIcon name="i-lucide-arrow-up-right" />
                </NuxtLink>
              </nav>
              <a href="#delivery-package">查看完整交付与验收清单</a>
            </section>

            <p v-if="isArchivedWork" class="ac-brief-state" role="status">
              这项工作已归档，成果与执行记录仍保留。点击“恢复到当前工作”即可重新放回当前列表。
            </p>
            <p v-else-if="route.query.restored === '1'" class="ac-brief-state" role="status">
              工作已恢复到当前列表，成果与执行记录保持不变。
            </p>
            <p
              v-if="!isArchivedWork && work.summary.userStatus === 'paused'"
              class="ac-brief-state"
              role="status"
            >
              已暂停新任务派发；已在运行的工作会继续到安全停点。如需调整方向，系统会先安全停止在途工作。
            </p>

            <nav class="ac-work3__actions" aria-label="当前工作快速入口">
              <button
                v-if="panels.includes('thread')"
                type="button"
                class="ac-work3__action"
                @click="selectPanel('thread')"
              >
                项目讨论
              </button>
              <NuxtLink
                class="ac-work3__action"
                :to="`/company/board?project=${encodeURIComponent(work.summary.workId)}`"
              >
                董事会
              </NuxtLink>
            </nav>

            <!-- WORK-07 — 运行控制：按投影的 allowedActions 如实展示，禁用态显示原因，不伪装可用 -->
            <div v-if="controlActions.length" class="ac-work3__actions" role="group" aria-label="运行控制">
              <button
                v-for="action in controlActions"
                :key="action.id"
                type="button"
                class="ac-work3__action"
                :data-primary="action.id === nextActionID"
                :disabled="!canInvokeFromUI(action) || Boolean(actionPending)"
                :title="actionTitle(action)"
                :aria-disabled="!canInvokeFromUI(action)"
                @click="invokeAction(action)"
              >
                {{
                  action.id === "request_change" && revisionImpactPreview
                    ? `请求修改 · 预计重跑 ${revisionImpactPreview.total} 项`
                    : action.label
                }}<template v-if="actionPending === action.id">…</template>
              </button>
            </div>
            <div
              v-if="controlActions.some((action) => ['action', 'retry'].includes(action.handler) && action.enabled && !['archive', 'restore'].includes(action.id))"
              class="ac-approval-decision"
            >
              <label for="runtime-action-note">方向调整 / 修改要求</label>
              <textarea
                id="runtime-action-note"
                v-model="actionNote"
                rows="3"
                maxlength="8000"
                placeholder="可先填写新方向再点暂停；暂停不会清空内容。请求修改时请写明问题与期望结果。"
              />
              <section v-if="revisionImpactPreview" class="ac-revision-preview" aria-live="polite">
                <p class="ac-card-kicker">提交前预告</p>
                <strong v-if="revisionImpactPreview.uncertain">
                  当前输入未定位到具体编号，可能重新执行全部 {{ revisionImpactPreview.totalItems }} 项工作
                </strong>
                <strong v-else>
                  预计重新执行 {{ revisionImpactPreview.total }} / {{ revisionImpactPreview.totalItems }} 项工作
                </strong>
                <p v-if="revisionImpactPreview.direct.length">
                  直接修改：{{ revisionImpactPreview.direct.join("、") }}
                </p>
                <p v-if="revisionImpactPreview.dependent.length">
                  依赖复核：{{ revisionImpactPreview.dependent.join("、") }}
                </p>
                <small>
                  旧版成果会保留。按当前重试预算最多再触发 {{ revisionImpactPreview.maxModelRuns }}
                  次模型运行，实际通常更少；费用仍以 Provider 账单为准，缺失费用不会按 0 计算。
                </small>
              </section>
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
                    <p class="ac-card-kicker">执行</p>
                    <h2>执行进度</h2>
                  </div>
                  <strong v-if="work.progress.percent !== undefined">{{ work.progress.percent }}%</strong>
                </div>
                <div
                  class="ac-progress"
                  :aria-label="`${work.progress.completedItems} / ${work.progress.totalItems} 已完成`"
                >
                  <span :style="{ width: `${work.progress.percent ?? 0}%` }" />
                </div>
                <p class="ac-card-reason">{{ humanLabel(work.progress.reason.text) }}</p>
                <p v-if="executionEstimate" class="ac-delivery-hint">
                  {{ executionEstimate }} 你可以先离开此页面，稍后回到“工作”继续查看。
                </p>
                <div class="ac-card-footer">
                  <span>{{ work.progress.completedItems }} / {{ work.progress.totalItems }} 个执行工作项已完成</span>
                  <time :datetime="work.progress.updatedAt">
                    {{ dateTime.format(new Date(work.progress.updatedAt)) }}
                  </time>
                </div>
              </section>

              <SeedGrowOverview
                v-if="seedProject"
                :mode="detail?.project.seedMode"
                :acceptance="seedGrow?.acceptance"
                :organization="seedGrow?.organization"
                :graph="seedGrow?.graph"
                :validation="seedGrow?.validation"
                :discoveries="seedGrow?.discoveries ?? []"
                :work-items="detail?.workItems ?? []"
                :pending="seedGrowPending"
                :failed="Boolean(seedGrowError)"
                :awaiting-user-acceptance="awaitingUserAcceptance"
              />

              <section v-if="currentPlanWorkItems.length" class="ac-detail-panel">
                <div class="ac-detail-heading">
                  <div>
                    <p class="ac-card-kicker">计划</p>
                    <h2>工作项与决定</h2>
                  </div>
                  <strong>{{ currentPlanWorkItems.length }}</strong>
                </div>
                <article v-for="item in currentPlanWorkItems" :key="item.id" class="ac-inline-item">
                  <h3>{{ humanLabel(item.title) }}</h3>
                  <p>
                    负责人：{{ agentDisplayName(item.ownerAgentID) }} · 第 {{ item.attempt }} / {{ item.maxAttempts }} 次尝试 ·
                    {{ workItemReviewLabel(item.reviewStatus) }}
                  </p>
                  <p v-if="item.error">{{ workItemErrorMessage(item.error) }}</p>
                  <details v-if="failedAttemptsForWorkItem(item.id).length" class="ac-source-trace">
                    <summary>
                      已自动恢复 {{ failedAttemptsForWorkItem(item.id).length }} 次未通过尝试
                    </summary>
                    <ul>
                      <li v-for="attempt in failedAttemptsForWorkItem(item.id)" :key="attempt.id">
                        第 {{ attempt.ordinal }} 次：{{ attemptStatusLabel(attempt.status) }} ·
                        {{ workItemErrorMessage(attempt.summary ?? attempt.failureKind ?? "未提供失败原因") }}
                      </li>
                    </ul>
                  </details>
                  <span>{{ workItemStatusLabel(item.status) }}</span>
                </article>
              </section>

              <details v-if="historicalPlanWorkItems.length" class="ac-detail-panel">
                <summary>查看已由旧计划替代的工作项（{{ historicalPlanWorkItems.length }}）</summary>
                <article v-for="item in historicalPlanWorkItems" :key="item.id" class="ac-inline-item">
                  <h3>{{ humanLabel(item.title) }}</h3>
                  <span>{{ workItemStatusLabel(item.status) }}</span>
                </article>
              </details>

              <section v-if="work.attentionItems.length" class="ac-detail-panel">
                <div class="ac-detail-heading">
                  <div>
                    <p class="ac-card-kicker">待处理</p>
                    <h2>需要处理</h2>
                  </div>
                  <strong>{{ work.attentionItems.length }}</strong>
                </div>
                <article v-for="item in work.attentionItems" :key="item.id" class="ac-inline-item">
                  <h3>{{ humanLabel(item.title) }}</h3>
                  <p>{{ humanLabel(item.reason.text) }}</p>
                  <div class="ac-work3__actions" role="group" :aria-label="`${humanLabel(item.title)} 可用动作`">
                    <button
                      v-for="action in toControlActions(item.allowedActions)"
                      :key="action.id"
                      type="button"
                      class="ac-work3__action"
                      :disabled="!canInvokeFromUI(action) || Boolean(actionPending)"
                      :title="actionTitle(action)"
                      :aria-disabled="!canInvokeFromUI(action)"
                      @click="invokeAction(action, item)"
                    >
                      {{ action.label }}<template v-if="actionPending === action.id">…</template>
                    </button>
                  </div>
                </article>
              </section>

              <section v-if="work.delivery" id="delivery-package" class="ac-detail-panel">
                <div class="ac-detail-heading">
                  <div>
                    <p class="ac-card-kicker">交付</p>
                    <h2>交付版本 {{ work.delivery.version }}</h2>
                  </div>
                  <span v-if="deliveryView" class="ac-status-badge" :data-stage="deliveryView.stage">{{
                    deliveryView.stateLabel
                  }}</span>
                </div>
                <p class="ac-card-reason">{{ humanLabel(work.delivery.reason.text) }}</p>
                <p v-if="deliveryView">
                  {{ deliveryView.artifactCount }} 项成果 · 已核对
                  {{ deliveryAccepted ? acceptanceItems.length : acceptedCriterionIDs.length }} /
                  {{ acceptanceItems.length }} 项验收标准
                  <template v-if="recoveredFailureCount">
                    · 系统共记录并恢复 {{ recoveredFailureCount }} 次未通过尝试（执行与独立复核分别计数）
                  </template>
                </p>
                <p v-if="deliveryView?.awaitingUserDecision" class="ac-delivery-hint">
                  执行工作项已完成，成果仍待你逐项核对；只有验收后才算最终完成。
                </p>
                <div v-if="deliveryView" class="ac-acceptance">
                  <p class="ac-card-kicker">逐项验收导航</p>
                  <p>
                    当前共有 {{ deliveryView.artifactCount }} 项成果，对应
                    {{ acceptanceItems.length }} 项验收标准。按下方每条标准打开对应证据成果核对；
                    系统不会因篇幅或“已完成”状态替你判定通过。
                  </p>
                </div>
                <div v-if="work.delivery.artifacts.length" class="ac-artifact-list">
                  <NuxtLink
                    v-for="artifact in work.delivery.artifacts"
                    :key="artifact.id"
                    class="ac-artifact-link"
                    :to="artifactRoute(artifact.projectId, artifact.id)"
                  >
                    <span>
                      <strong>{{ humanLabel(artifact.title) }}</strong>
                      <small>{{ artifactKindLabel(artifact.kind) }}</small>
                    </span>
                    <UIcon name="i-lucide-arrow-up-right" />
                  </NuxtLink>
                </div>

                <div v-if="acceptanceItems.length" class="ac-acceptance">
                  <p class="ac-card-kicker">验收标准核对</p>
                  <ul class="ac-acceptance__list">
                    <li v-for="item in acceptanceItems" :key="item.id" class="ac-acceptance__item">
                      <label
                        class="ac-acceptance__verdict"
                        :data-verdict="deliveryAccepted || acceptanceChecks[item.id] ? 'pass' : 'unverified'"
                      >
                        <input
                          type="checkbox"
                          :checked="deliveryAccepted || Boolean(acceptanceChecks[item.id])"
                          :disabled="deliveryAccepted"
                          @change="updateAcceptanceCheck(item.id, $event)"
                        />
                        {{ deliveryAccepted ? "已验收" : acceptanceChecks[item.id] ? "已核对" : "待你核对" }}
                      </label>
                      <span class="ac-acceptance__text">
                        <strong>{{ item.description }}</strong>
                        <small>
                          验证方式：{{ item.verification }}
                        </small>
                        <small>
                          证据成果：
                          <template v-if="acceptanceEvidenceArtifacts(item).length">
                            <NuxtLink
                              v-for="(artifact, evidenceIndex) in acceptanceEvidenceArtifacts(item)"
                              :key="`${item.id}:${artifact.id}`"
                              :to="artifactRoute(artifact.projectId, artifact.id)"
                            >
                              {{ evidenceIndex ? "、" : "" }}{{ humanLabel(artifact.title) }}
                            </NuxtLink>
                          </template>
                          <span v-else>尚未建立逐项证据映射，请从上方成果中人工核对</span>
                        </small>
                      </span>
                    </li>
                  </ul>
                  <p class="ac-delivery-hint">
                    请打开上方成果并逐项核对。全部符合后可验收；如有一项不符合，请填写修改要求并请求修改。
                  </p>
                </div>
              </section>
            </div>

            <CompanyComposer
              v-if="composerTarget"
              :target="composerTarget"
              :agents="snapshot.agents"
              @sent="refreshProjectMessages()"
            />
          </template>

          <template v-else-if="work?.availability === 'unavailable'">
            <header class="ac-workspace-header">
              <div>
                <p class="ac-workspace-eyebrow">状态诊断</p>
                <h1 class="ac-workspace-title">{{ humanLabel(work.title) }}</h1>
                <p class="ac-workspace-lede">{{ humanLabel(work.reason.text) }}</p>
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
              <UButton class="ac-empty-state__action" color="neutral" to="/work">返回工作列表</UButton>
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
              :data-active="kind === renderedActivePanel"
              :aria-selected="kind === renderedActivePanel"
              aria-controls="work-context-panel"
              :tabindex="kind === renderedActivePanel ? 0 : -1"
              :disabled="!hydrated"
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
            :aria-labelledby="renderedActivePanel ? `work-context-tab-${renderedActivePanel}` : undefined"
            tabindex="0"
          >
            <!-- Goal Brief -->
            <template v-if="renderedActivePanel === 'goal_brief'">
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
                    <dt>目标摘要版本</dt>
                    <dd>{{ goalBrief.brief.version }}</dd>
                  </div>
                </dl>
                <p class="ac-brief-state">
                  目标摘要与执行计划分别计数；问答保存和方向调整都会形成新的目标摘要版本。
                </p>
                <details v-if="goalBrief.brief.constraints.length" class="ac-brief-constraints ac-brief-disclosure">
                  <summary><span>约束</span><small>{{ goalBrief.brief.constraints.length }}</small></summary>
                  <ul>
                    <li v-for="constraint in goalBrief.brief.constraints" :key="constraint">{{ constraint }}</li>
                  </ul>
                </details>
                <details v-if="recordedUserAnswers.length" class="ac-brief-constraints ac-brief-disclosure">
                  <summary><span>用户已回答</span><small>{{ recordedUserAnswers.length }}</small></summary>
                  <p>回答已记录；“未知”或“未核实”仍表示事实尚未确认。</p>
                  <ul>
                    <li v-for="assumption in recordedUserAnswers" :key="assumption.id">
                      {{ assumption.description }}
                      <small>回答已记录</small>
                    </li>
                  </ul>
                </details>
                <details v-if="systemAssumptions.length" class="ac-brief-constraints ac-brief-disclosure">
                  <summary><span>系统假设（不阻塞当前执行）</span><small>{{ systemAssumptions.length }}</small></summary>
                  <ul>
                    <li v-for="assumption in systemAssumptions" :key="assumption.id">
                      {{ assumption.description }}
                      <small>系统暂定 · 不阻塞</small>
                    </li>
                  </ul>
                </details>
              </template>
            </template>

            <!-- DELIV-04 决策闭环：审批状态可读化 + 按投影如实展示的决策动作 -->
            <template v-else-if="renderedActivePanel === 'approval'">
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
                    :disabled="!canInvokeFromUI(action)"
                    :title="actionTitle(action)"
                    :aria-disabled="!canInvokeFromUI(action)"
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
            <template v-else-if="renderedActivePanel === 'artifact'">
              <div v-if="currentDeliveryArtifacts.length" class="ac-detail-heading">
                <div>
                  <p class="ac-card-kicker">{{ currentDeliveryVersion ? "当前交付" : "进行中成果" }}</p>
                  <h2>{{ currentDeliveryVersion ? `交付版本 ${currentDeliveryVersion}` : "本轮成果" }}</h2>
                </div>
                <strong>{{ currentDeliveryArtifacts.length }}</strong>
              </div>
              <div v-if="currentDeliveryArtifacts.length" class="ac-artifact-list">
                <NuxtLink
                  v-for="artifact in currentDeliveryArtifacts"
                  :key="artifact.id"
                  class="ac-artifact-link"
                  :data-active="artifact.id === selectedArtifactID"
                  :to="artifactRoute(detail?.project.id ?? workID ?? '', artifact.id)"
                  @click="selectArtifact(artifact.id)"
                >
                  <span>
                    <strong>{{ humanLabel(artifact.title) }}</strong>
                    <small>{{ artifactKindLabel(artifact.kind) }}</small>
                  </span>
                  <UIcon name="i-lucide-arrow-up-right" />
                </NuxtLink>
              </div>
              <p v-else class="ac-brief-state">当前计划还没有可交付成果。</p>
              <details v-if="currentExecutionEvidence.length" class="ac-detail-panel">
                <summary>查看当前计划的核验与执行记录（{{ currentExecutionEvidence.length }}）</summary>
                <div class="ac-artifact-list">
                  <NuxtLink
                    v-for="artifact in currentExecutionEvidence"
                    :key="artifact.id"
                    class="ac-artifact-link"
                    :to="artifactRoute(detail?.project.id ?? workID ?? '', artifact.id)"
                  >
                    <span>
                      <strong>{{ humanLabel(artifact.title) }}</strong>
                      <small>{{ artifactKindLabel(artifact.kind) }}</small>
                    </span>
                    <UIcon name="i-lucide-arrow-up-right" />
                  </NuxtLink>
                </div>
              </details>
              <details v-if="previousDeliveryArtifacts.length" class="ac-detail-panel">
                <summary>查看之前轮次成果（{{ previousDeliveryArtifacts.length }}）</summary>
                <div class="ac-artifact-list">
                  <NuxtLink
                    v-for="artifact in previousDeliveryArtifacts"
                    :key="artifact.id"
                    class="ac-artifact-link"
                    :to="artifactRoute(detail?.project.id ?? workID ?? '', artifact.id)"
                  >
                    <span>
                      <strong>{{ humanLabel(artifact.title) }}</strong>
                      <small>{{ artifactKindLabel(artifact.kind) }}</small>
                    </span>
                    <UIcon name="i-lucide-arrow-up-right" />
                  </NuxtLink>
                </div>
              </details>
              <details v-if="historicalPlanArtifacts.length" class="ac-detail-panel">
                <summary>查看旧计划成果与记录（{{ historicalPlanArtifacts.length }}）</summary>
                <div class="ac-artifact-list">
                  <NuxtLink
                    v-for="artifact in historicalPlanArtifacts"
                    :key="artifact.id"
                    class="ac-artifact-link"
                    :to="artifactRoute(detail?.project.id ?? workID ?? '', artifact.id)"
                  >
                    <span>
                      <strong>{{ humanLabel(artifact.title) }}</strong>
                      <small>计划 {{ artifact.planVersion }} · {{ artifactKindLabel(artifact.kind) }}</small>
                    </span>
                    <UIcon name="i-lucide-arrow-up-right" />
                  </NuxtLink>
                </div>
              </details>
            </template>

            <!-- Agent -->
            <template v-else-if="renderedActivePanel === 'agent'">
              <article v-for="member in formedTeamMembers" :key="member.id" class="ac-team-member">
                <header>
                  <div>
                    <h3>{{ member.name }}</h3>
                    <p>{{ humanLabel(member.role) }}</p>
                  </div>
                  <span>{{ memberStatusLabel(member) }}</span>
                </header>
                <p><strong>为什么加入：</strong>{{ member.reason || "按当前任务所需能力完成选择。" }}</p>
                <p v-if="member.responsibilities.length">
                  <strong>负责：</strong>{{ member.responsibilities.join("、") }}
                </p>
              </article>
            </template>

            <template v-else-if="renderedActivePanel === 'thread'">
              <p v-if="projectMessagesStatus === 'pending'" class="ac-brief-state" role="status">
                正在读取项目讨论…
              </p>
              <div v-else-if="projectMessagesError" class="ac-brief-state ac-brief-state--error" role="alert">
                <template v-if="projectMessagesError.statusCode === 404">
                  <template v-if="restoringWork">
                    <h3>项目讨论正在恢复</h3>
                    <p>正在重新连接这项工作的讨论记录，请稍候或重新读取。</p>
                    <UButton color="neutral" variant="outline" @click="refreshRestoredProject()">重新读取</UButton>
                  </template>
                  <template v-else>
                    <h3>这项历史工作没有项目讨论记录</h3>
                    <p>该工作创建时没有建立项目频道，因此无法补显示协作消息；现有目标、运行记录和成果仍可查看。</p>
                  </template>
                </template>
                <template v-else>
                  <h3>项目讨论暂时不可用</h3>
                  <p>发送入口仍会如实返回本地服务结果，读取失败不会显示为真实空讨论。</p>
                  <UButton color="neutral" variant="outline" @click="refreshProjectMessages()">重新读取</UButton>
                </template>
              </div>
              <template v-else>
                <article
                  v-for="message in projectMessages"
                  :key="message.id"
                  class="ac-inline-item"
                >
                  <div class="ac-card-footer">
                    <strong>{{ projectMessageAuthor(message.author) }}</strong>
                    <time :datetime="new Date(message.createdAt).toISOString()">
                      {{ dateTime.format(new Date(message.createdAt)) }}
                    </time>
                  </div>
                  <p>{{ humanLabel(message.body) }}</p>
                  <span v-if="message.signalType">{{ signalTypeLabel(message.signalType) }}</span>
                  <details v-if="message.detail" class="ac-source-trace">
                    <summary>查看完整执行记录</summary>
                    <p>{{ humanLabel(message.detail) }}</p>
                  </details>
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
            <template v-else-if="renderedActivePanel === 'diagnostics'">
              <SeedGrowDiagnostics
                :acceptance="seedGrow?.acceptance"
                :graph="seedGrow?.graph"
                :validation="seedGrow?.validation"
                :discoveries="seedGrow?.discoveries ?? []"
                :organization="seedGrow?.organization"
                :detail="detail"
                :diagnostics="diagnosticGroups"
                :pending="seedProject && seedGrowPending"
                :failed="seedProject && Boolean(seedGrowError)"
                :awaiting-user-acceptance="awaitingUserAcceptance"
              />
            </template>

            <p v-else class="ac-brief-state">当前工作还没有可显示的上下文。</p>
          </div>
        </aside>
      </div>
    </template>
  </UDashboardPanel>
</template>
