<script setup lang="ts">
import type { GoalBriefProjectView } from "@agents-company/shared/experience";
import type {
  CompanyProjectDetail,
  SeedGrowProjectExperience,
} from "../../../modules/agent-company/runtime/shared/company-contract";
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
} from "../../../modules/agent-company/runtime/shared/work-workspace";
import {
  canInvoke,
  toControlActions,
  type ControlAction,
} from "../../../modules/agent-company/runtime/shared/work-controls";
import {
  acceptanceChecklist,
  criterionVerdictLabels,
  deliveryPackageView,
} from "../../../modules/agent-company/runtime/shared/delivery-package";
import type { ComposerTarget } from "../../../modules/agent-company/runtime/shared/company-composer";
import { diagnosticsCount } from "../../../modules/agent-company/runtime/shared/seed-grow-view";

const route = useRoute();
const appConfig = useAppConfig();
const { data: snapshot, pending, refresh } = useCompanySnapshot();
const workID = computed(() => Array.isArray(route.params.projectID)
  ? route.params.projectID[0]
  : route.params.projectID);
const available = computed(() => ["ready", "degraded"].includes(snapshot.value.connection));
const workUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("work") ?? false);
const work = computed(() => snapshot.value.work.find(item =>
  (item.availability === "available" ? item.summary.workId : item.workId) === workID.value));

const workList = computed(() => snapshot.value.work.map(item => item.availability === "available"
  ? { id: item.summary.workId, title: item.summary.title, status: item.summary.userStatus, ok: true as const }
  : { id: item.workId, title: item.title, status: "unavailable", ok: false as const }));

const {
  data: goalBriefResult,
  status: goalBriefStatus,
  error: goalBriefError,
  refresh: refreshGoalBrief,
} = useFetch<GoalBriefProjectView>(() =>
  `/api/agent-company/projects/${encodeURIComponent(workID.value ?? "")}/goal-brief`);
const goalBrief = computed(() => goalBriefResult.value && "kind" in goalBriefResult.value
  ? goalBriefResult.value
  : undefined);

const { data: detailResult, error: detailError } = useFetch<CompanyProjectDetail>(() =>
  `/api/agent-company/projects/${encodeURIComponent(workID.value ?? "")}`);
const detail = computed(() => detailResult.value ?? undefined);
const {
  data: seedGrowResult,
  status: seedGrowStatus,
  error: seedGrowError,
  refresh: refreshSeedGrow,
} = useFetch<SeedGrowProjectExperience>(() =>
  `/api/agent-company/projects/${encodeURIComponent(workID.value ?? "")}/seed-grow`);
const seedGrow = computed(() => seedGrowResult.value ?? undefined);
const seedProject = computed(() => detail.value?.project.executionStrategy === "seed_and_grow");
const seedGrowPending = computed(() => seedGrowStatus.value === "pending");

// DELIV-05：区分 Delivered / Accepted，并用最初的验收标准构建核对清单（逐项状态待后端下发）。
const deliveryView = computed(() => work.value?.availability === "available" && work.value.delivery
  ? deliveryPackageView(work.value.delivery)
  : undefined);
const acceptanceItems = computed(() => goalBrief.value?.kind === "goal_brief"
  ? acceptanceChecklist(goalBrief.value.brief.acceptanceCriteria)
  : []);

const workDiagnostics = computed(() => work.value?.availability === "available"
  ? work.value.diagnostics
  : work.value?.availability === "unavailable"
    ? work.value.diagnostics
    : []);

// WORK-04：工作区 Composer 只在项目可用时挂载，发送目标固定为当前项目频道。
const composerTarget = computed<ComposerTarget | undefined>(() => work.value?.availability === "available"
  ? { kind: "project", projectId: work.value.summary.workId, title: work.value.summary.title }
  : undefined);

// 右侧上下文面板只依据真实数据存在与否派生；Thread 明细需后端接线，此处不虚构。
const panels = computed(() => availableContextPanels({
  hasGoalBrief:
    goalBriefStatus.value === "pending"
    || Boolean(goalBriefError.value)
    || goalBrief.value?.kind === "goal_brief"
    || goalBrief.value?.kind === "legacy_charter",
  gates: detail.value?.gates.length ?? 0,
  artifacts: detail.value?.artifacts.length ?? 0,
  agents: detail.value?.recruitment.candidates.length ?? 0,
  threadAvailable: false,
  diagnostics: workDiagnostics.value.length + diagnosticsCount(
    seedGrow.value?.graph,
    seedGrow.value?.validation,
  ) + (seedProject.value ? 1 : 0),
}));

// 每个项目独立保存视图状态，切换项目时校正以避免残留上一项目的上下文。
const viewStore = useState<Record<string, WorkspaceViewState>>("work-workspace-view", () => ({}));
const column = ref<WorkspaceColumn>("main");
const activePanel = ref<ContextPanelKind>();
const selectedArtifactID = ref<string>();
const selectedAgentID = ref<string>();

watch([workID, panels, detail], () => {
  const id = workID.value;
  if (!id) return;
  const reconciled = reconcileViewState(viewStateFor(viewStore.value, id), panels.value, {
    artifacts: detail.value?.artifacts ?? [],
    agents: detail.value?.recruitment.candidates ?? [],
  });
  column.value = reconciled.column;
  activePanel.value = reconciled.activePanel;
  selectedArtifactID.value = reconciled.selectedArtifactID;
  selectedAgentID.value = reconciled.selectedAgentID;
}, { immediate: true });

function persist() {
  const id = workID.value;
  if (!id) return;
  viewStore.value = {
    ...viewStore.value,
    [id]: {
      column: column.value,
      activePanel: activePanel.value,
      selectedArtifactID: selectedArtifactID.value,
      selectedAgentID: selectedAgentID.value,
    },
  };
}

function selectPanel(kind: ContextPanelKind) {
  activePanel.value = resolveActivePanel(kind, panels.value);
  column.value = "context";
  persist();
}

async function navigatePanel(event: KeyboardEvent, kind: ContextPanelKind) {
  const index = panels.value.indexOf(kind);
  const target =
    event.key === "Home"
      ? panels.value[0]
      : event.key === "End"
        ? panels.value.at(-1)
        : event.key === "ArrowRight"
          ? panels.value[(index + 1) % panels.value.length]
          : event.key === "ArrowLeft"
            ? panels.value[(index - 1 + panels.value.length) % panels.value.length]
            : undefined;
  if (!target) return;
  event.preventDefault();
  selectPanel(target);
  await nextTick();
  document.querySelector<HTMLElement>(`[data-context-panel="${target}"]`)?.focus();
}

function goColumn(direction: "next" | "prev") {
  column.value = direction === "next" ? nextColumn(column.value) : prevColumn(column.value);
  persist();
}

const selectedArtifact = computed(() => detail.value?.artifacts.find(item => item.id === selectedArtifactID.value));
const selectedAgent = computed(() => detail.value?.recruitment.candidates.find(item => item.id === selectedAgentID.value));

// WORK-07 — 运行控制：只渲染投影下发的 allowedActions，保留真实 enabled/disabledReason，
// 仅在客户端有真实处理器且投影允许时才可点击（retry 走真实代理，导航类在客户端处理）。
const controlActions = computed<ControlAction[]>(() => work.value?.availability === "available"
  ? toControlActions(work.value.summary.allowedActions)
  : []);
const nextActionID = computed(() => work.value?.availability === "available" && work.value.summary.nextAction
  ? work.value.summary.nextAction.id
  : undefined);

// DELIV-04 — 审批决策动作：从投影 allowedActions 中筛出批准/拒绝/请求修改，按真实 enabled/disabledReason 展示。
// R0 治理契约未解除时这些变更类动作恒为禁用；说明文本由用户填写但在动作可用前不提交。
const decisionActionIDs = new Set(["approve", "reject", "request_change"]);
const decisionActions = computed(() => controlActions.value.filter(action => decisionActionIDs.has(action.id)));
const decisionNote = ref("");

const retrying = ref(false);
async function invokeAction(action: ControlAction) {
  if (!canInvoke(action)) return;
  if (action.handler === "navigate_progress" || action.handler === "open_delivery") {
    column.value = "main";
    persist();
    return;
  }
  if (action.handler === "open_diagnostics") return selectPanel("diagnostics");
  if (action.handler === "open_evidence") return selectPanel("goal_brief");
  if (action.handler === "retry") {
    if (retrying.value) return;
    retrying.value = true;
    await $fetch(`/api/agent-company/projects/${encodeURIComponent(workID.value ?? "")}/retry`, {
      method: "POST",
      body: {},
    }).catch(() => undefined);
    retrying.value = false;
    await Promise.all([refresh(), refreshGoalBrief(), refreshSeedGrow()]);
  }
}

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});

function briefSourceLabel(source: string) {
  if (source === "user_confirmation") return "用户确认";
  if (source === "user_input") return "用户输入";
  if (source === "system_suggestion") return "系统建议";
  return "旧项目 Charter";
}
function briefApprovalLabel(mode: string) {
  if (mode === "autonomous") return "自主推进";
  if (mode === "strict") return "严格审批";
  return "平衡审批";
}
function artifactKindLabel(kind: string) {
  if (kind === "report") return "报告";
  if (kind === "file") return "文件";
  if (kind === "link") return "链接";
  return "成果";
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
  };
  return labels[status] ?? status;
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
  };
  return labels[status] ?? status;
}
function artifactRoute(projectID: string, artifactID: string) {
  return `/library/artifacts/${encodeURIComponent(projectID)}/${encodeURIComponent(artifactID)}`;
}
</script>

<template>
  <UDashboardPanel id="work-detail" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-work3" :data-column="column">
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
                :disabled="!canInvoke(action) || (action.handler === 'retry' && retrying)"
                :title="action.disabledReason"
                :aria-disabled="!canInvoke(action)"
                @click="invokeAction(action)"
              >
                {{ action.label }}<template v-if="action.handler === 'retry' && retrying">…</template>
              </button>
            </div>

            <div class="ac-detail-stack">
              <section class="ac-detail-panel">
                <div class="ac-detail-heading">
                  <div>
                    <p class="ac-card-kicker">Progress</p>
                    <h2>当前进展</h2>
                  </div>
                  <strong v-if="work.progress.percent !== undefined">{{ work.progress.percent }}%</strong>
                </div>
                <div class="ac-progress" :aria-label="`${work.progress.completedItems} / ${work.progress.totalItems} 已完成`">
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
                </article>
              </section>

              <section v-if="work.delivery" class="ac-detail-panel">
                <div class="ac-detail-heading">
                  <div>
                    <p class="ac-card-kicker">Delivery</p>
                    <h2>交付版本 {{ work.delivery.version }}</h2>
                  </div>
                  <span
                    v-if="deliveryView"
                    class="ac-status-badge"
                    :data-stage="deliveryView.stage"
                  >{{ deliveryView.stateLabel }}</span>
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
                      <span class="ac-acceptance__verdict" :data-verdict="item.verdict">{{ criterionVerdictLabels[item.verdict] }}</span>
                      <span class="ac-acceptance__text">
                        <strong>{{ item.description }}</strong>
                        <small>验证方式：{{ item.verification }}</small>
                      </span>
                    </li>
                  </ul>
                  <p class="ac-delivery-hint">逐项通过 / 未通过结论需本地服务下发核对结果，当前统一标记为“未逐项核对”，不代替后端下结论。</p>
                </div>
              </section>
            </div>

            <CompanyComposer
              v-if="composerTarget"
              :target="composerTarget"
              :agents="snapshot.agents"
              @sent="refresh()"
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
              :data-context-panel="kind"
              :data-active="kind === activePanel"
              :aria-selected="kind === activePanel"
              :aria-controls="`context-panel-${kind}`"
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
            :id="activePanel ? `context-panel-${activePanel}` : undefined"
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
                <span class="ac-status-badge" :data-status="approval.status">{{ gateStatusLabel(approval.status) }}</span>
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
                  @click="selectedArtifactID = artifact.id; persist()"
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
              <article
                v-for="agent in detail?.recruitment.candidates ?? []"
                :key="agent.id"
                class="ac-inline-item"
              >
                <h3>{{ agent.name }}</h3>
                <span>{{ agent.lifecycle }}</span>
              </article>
            </template>

            <!-- Diagnostics -->
            <template v-else-if="activePanel === 'diagnostics'">
              <SeedGrowDiagnostics
                v-if="seedProject"
                :graph="seedGrow?.graph"
                :validation="seedGrow?.validation"
                :discoveries="seedGrow?.discoveries ?? []"
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
