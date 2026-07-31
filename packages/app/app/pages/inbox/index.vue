<script setup lang="ts">
import {
  ExperienceApiError,
  GoalBriefStartResult,
  type GoalBrief,
} from "@agents-company/shared/experience";
import type {
  DecisionCenterItem,
  DecisionCenterProjection,
  GovernanceAsset,
} from "@agents-company/sdk/v2/founder-os";
import {
  goalDraftRequest,
  isCurrentGoalDraftRequest,
  parseGoalBriefGenerationResponse,
  parseGoalDraftStorage,
  serializeGoalDraftStorage,
} from "../../../modules/agent-company/runtime/shared/goal-brief-generation";
import {
  parseGoalBriefFailure,
  type GoalBriefFailureView,
} from "../../../modules/agent-company/runtime/shared/goal-brief-state";
import {
  chooseDemo,
  chooseReal,
  onboardingStorageKey,
  parseOnboardingState,
  serializeOnboardingState,
  skipOnboarding,
  type OnboardingState,
} from "../../../modules/agent-company/runtime/shared/onboarding";
import {
  aggregateAttention,
  categorySummaries,
  countByType,
} from "../../../modules/agent-company/runtime/shared/inbox-attention";

const goalDraftStorageKey = "agent-company:inbox-goal-draft:v1";
const previousGoalDraftStorageKey = "agent-company:inbox-previous-goal-draft:v1";
const goalGenerationStartedAtStorageKey = "agent-company:inbox-goal-started-at:v1";
const goalBriefRecoveryWindowMs = 180_000;
const goalBriefRecoveryPollMs = 2_000;
const appConfig = useAppConfig();
const route = useRoute();
const { data: snapshot, pending, refresh } = useCompanySnapshot();
const goalDraft = useState("agent-company-inbox-goal-draft", () => "");
const generationRequestID = useState("agent-company-inbox-goal-request-id", () => "");
const generationRequestGoal = useState("agent-company-inbox-goal-request-goal", () => "");
const generationRequestStartedAt = useState("agent-company-inbox-goal-request-started-at", () => 0);
const draftHydrated = ref(false);
const generating = ref(false);
const recoveringGeneratedBrief = ref(false);
const starting = ref(false);
const generatedBrief = ref<GoalBrief>();
const generationFailure = ref<GoalBriefFailureView>();
const generationError = ref("");
const startError = ref("");
const startRequestID = ref("");
const newGoalOpen = ref(route.query.newGoal === "1");
const previousGoalDraft = ref("");
const newGoalFeedback = ref("");
const goalDraftInput = ref<HTMLTextAreaElement>();
const goalDraftSection = ref<HTMLElement>();
const draftStorageAvailable = ref(true);
const onboarding = ref<OnboardingState>(parseOnboardingState(null));
const onboardingHydrated = ref(false);
const available = computed(() => ["ready", "degraded"].includes(snapshot.value.connection));
const workUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("work") ?? false);
const unavailableWork = computed(() => snapshot.value.work.filter(work => work.availability === "unavailable"));
const primaryWorkID = computed(() => {
  const item = snapshot.value.work[0];
  if (!item) return "";
  return item.availability === "available" ? item.summary.workId : item.workId;
});
const allAttentionItems = computed(() => aggregateAttention(snapshot.value.work));
const attentionItems = computed(() =>
  allAttentionItems.value.filter(item => item.workId === primaryWorkID.value));
const historicalAttentionItems = computed(() =>
  allAttentionItems.value.filter(item => item.workId !== primaryWorkID.value));
const currentUnavailableWork = computed(() =>
  unavailableWork.value.filter(work => work.workId === primaryWorkID.value));
const historicalUnavailableWork = computed(() =>
  unavailableWork.value.filter(work => work.workId !== primaryWorkID.value));
const attentionCategories = computed(() => categorySummaries(countByType(attentionItems.value)));
const totalUnhandled = computed(() => attentionItems.value.length + currentUnavailableWork.value.length);
const historicalUnhandled = computed(() =>
  historicalAttentionItems.value.length + historicalUnavailableWork.value.length);
const historicalUnhandledWorkCount = computed(() =>
  new Set([
    ...historicalAttentionItems.value.map(item => item.workId),
    ...historicalUnavailableWork.value.map(work => work.workId),
  ]).size);
const hasLocalDraft = computed(() => Boolean(goalDraft.value.trim()));
const firstRun = computed(() =>
  available.value
  && !workUnavailable.value
  && snapshot.value.work.length === 0
  && attentionItems.value.length === 0
  && unavailableWork.value.length === 0);
const showGoalDraft = computed(() =>
  available.value
    ? firstRun.value || newGoalOpen.value || hasLocalDraft.value || Boolean(generatedBrief.value)
    : hasLocalDraft.value);
// 首次进入且尚未做出选择时，先呈现“连接真实工作区 / 查看演示”两个清晰选项，而非直接跳到目标输入。
const welcomeStage = computed(() =>
  onboardingHydrated.value && firstRun.value && onboarding.value.mode === "unset");
const canGenerate = computed(() =>
  draftHydrated.value
  && available.value
  && snapshot.value.company.providerConfigured !== false
  && hasLocalDraft.value
  && !generating.value
  && !recoveringGeneratedBrief.value);
const providerDisclosure = computed(() =>
  snapshot.value.company.providerConfigured === false
    ? "尚未配置模型服务"
    : `当前模型服务（${snapshot.value.company.provider}）`);
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function localizedReason(value: string) {
  return value
    .replace(/Delivery v(\d+)/g, "交付版本 $1")
    .replace(/\bArtifacts?\b/g, "成果");
}
const decisionCenter = ref<DecisionCenterProjection>();
const decisionCenterPending = ref(false);
const decisionCenterFeedback = ref("");
const decisionSourceLabels = {
  human: "大东本人",
  ai_founder: "AI 大东 · 创始人代理",
  board: "董事会",
  policy_engine: "Policy Engine",
  unknown: "历史来源未确认",
} as const;

function assetReferenceHref(reference: { assetId: string; version: number }) {
  return `/settings/company#asset-${encodeURIComponent(reference.assetId)}-${reference.version}`;
}

function evidenceReferenceHref(reference: { kind: string; id: string; version?: number }) {
  if (reference.kind === "founder_asset")
    return `/settings/company#asset-${encodeURIComponent(reference.id)}-${reference.version ?? 1}`;
  if (reference.kind === "conversation")
    return `/chat/${encodeURIComponent(reference.id)}`;
  if (reference.kind === "decision")
    return `/inbox#decision-${encodeURIComponent(reference.id)}`;
  return `/work?referenceKind=${encodeURIComponent(reference.kind)}&referenceId=${encodeURIComponent(reference.id)}`;
}

async function refreshDecisionCenter() {
  if (!available.value || !snapshot.value.company.id) return;
  decisionCenterPending.value = true;
  decisionCenterFeedback.value = "";
  await $fetch<DecisionCenterProjection>("/api/agent-company/decision-center", {
    query: { companyId: snapshot.value.company.id },
  }).then(
    value => decisionCenter.value = value,
    () => decisionCenterFeedback.value = "决策中心暂时无法读取，未显示缓存状态。",
  );
  decisionCenterPending.value = false;
}

async function refreshInbox() {
  await Promise.all([refresh(), refreshDecisionCenter()]);
}

watch(
  [available, () => snapshot.value.company.id],
  ([ready, companyId]) => {
    if (ready && companyId) void refreshDecisionCenter();
  },
  { immediate: true },
);

async function decisionAction(item: DecisionCenterItem, action: "accept" | "reject" | "rollback") {
  const reason = window.prompt(action === "accept" ? "接受说明" : action === "reject" ? "否决原因" : "回滚原因");
  if (!reason) return;
  decisionCenterPending.value = true;
  decisionCenterFeedback.value = "";
  const endpoint = item.gate && action !== "rollback"
    ? "/api/agent-company/decision-center-gate"
    : "/api/agent-company/decision-center-action";
  const body = item.gate && action !== "rollback"
    ? {
        gateId: item.gate.id,
        decision: action === "accept" ? "approve" : "reject",
        note: reason,
        actor: { kind: "human", id: "user" },
      }
    : {
        decisionId: item.decision.id,
        action: {
          schemaVersion: 1,
          idempotencyKey: crypto.randomUUID(),
          action,
          reason,
          actorId: "user",
        },
      };
  await $fetch(endpoint, { method: "POST", body }).then(
    () => {
      decisionCenterFeedback.value = action === "accept" ? "决定已接受。" : action === "reject" ? "决定已否决。" : "回滚已记录。";
      return refreshDecisionCenter();
    },
    () => decisionCenterFeedback.value = "操作未写入，请刷新后重试。",
  );
  decisionCenterPending.value = false;
}

async function rollbackYellow(item: DecisionCenterItem) {
  if (!item.yellowSummary) return;
  const reason = window.prompt("输入 Yellow 回滚原因");
  if (!reason?.trim()) return;
  decisionCenterPending.value = true;
  decisionCenterFeedback.value = "";
  await $fetch("/api/agent-company/decision-center-yellow-rollback", {
    method: "POST",
    body: {
      runId: item.yellowSummary.runId,
      rollback: {
        schemaVersion: 1,
        idempotencyKey: crypto.randomUUID(),
        trigger: "human_decision",
        reason,
        actor: { kind: "human", id: "local_user" },
      },
    },
  }).then(
    () => {
      decisionCenterFeedback.value = "Yellow 回滚请求已写入 checkpoint 链。";
      return refreshDecisionCenter();
    },
    () => decisionCenterFeedback.value = "Yellow 回滚未完成，请检查 checkpoint 与回滚处理器。",
  );
  decisionCenterPending.value = false;
}

async function correctDecision(item: DecisionCenterItem, kind: "override" | "correction") {
  const humanDecision = window.prompt(kind === "override" ? "输入新的最终决定" : "输入纠正内容");
  if (!humanDecision) return;
  const reason = window.prompt("输入纠正原因");
  if (!reason) return;
  const learningScope = window.prompt("这次纠偏是“个例”还是“长期规则”？", "个例");
  if (learningScope !== "个例" && learningScope !== "长期规则") return;
  const proposedAssetUpdates = (() => {
    if (learningScope === "个例") return [];
    const targetAssetId = window.prompt("目标资产 ID，创建新规则时留空")?.trim() || null;
    const type = window.prompt(
      "规则类型：constitution / principle / heuristic / boundary / taste_reference / taste_anti_reference / rubric / decision_case",
      "heuristic",
    )?.trim() as GovernanceAsset["type"] | undefined;
    if (
      !type
      || !["constitution", "principle", "heuristic", "boundary", "taste_reference", "taste_anti_reference", "rubric", "decision_case"].includes(type)
    )
      return;
    const baseVersion = targetAssetId
      ? Number(window.prompt("目标资产当前版本", "1"))
      : null;
    if (targetAssetId && (!Number.isInteger(baseVersion) || Number(baseVersion) < 1)) return;
    const scope = item.decision.scope.type === "project"
      ? { kind: "project" as const, ref: item.decision.scope.projectId }
      : { kind: "company" as const };
    return [{
      target: { assetId: targetAssetId, type, scope },
      baseRevision: targetAssetId ? { assetId: targetAssetId, version: Number(baseVersion) } : null,
      typedDiff: {
        operation: targetAssetId ? "revise" as const : "create" as const,
        content: humanDecision,
        rationale: reason,
        tags: ["founder-correction"],
        sourceRefs: [{ kind: "decision" as const, id: item.decision.id }],
      },
      authority: "ai_proposed" as const,
    }];
  })();
  if (!proposedAssetUpdates) return;
  decisionCenterPending.value = true;
  await $fetch("/api/agent-company/decision-center-correction", {
    method: "POST",
    body: {
      schemaVersion: 1,
      idempotencyKey: crypto.randomUUID(),
      decisionId: item.decision.id,
      kind,
      humanDecision,
      reason,
      proposedAssetUpdates,
      actorKind: "human",
      actorId: "user",
    },
  }).then(
    () => {
      decisionCenterFeedback.value = learningScope === "长期规则"
        ? "纠偏已追加，长期规则已生成 ai_proposed / draft。"
        : kind === "override"
          ? "Override 已追加记录。"
          : "Correction 已追加记录。";
      return refreshDecisionCenter();
    },
    () => decisionCenterFeedback.value = "纠正未写入，请刷新后重试。",
  );
  decisionCenterPending.value = false;
}

async function takeoverDecision(item: DecisionCenterItem) {
  const boardThreadId = item.decision.source?.boardThreadId;
  if (!boardThreadId) return;
  const reason = window.prompt("输入接管原因，提交后将写入治理 fence");
  if (!reason?.trim()) return;
  decisionCenterPending.value = true;
  await $fetch("/api/agent-company/founder-board/intervene", {
    method: "POST",
    body: {
      companyId: snapshot.value.company.id,
      idempotencyKey: crypto.randomUUID(),
      kind: "takeover",
      boardThreadId,
      ...(item.decision.scope.type === "project" ? { projectId: item.decision.scope.projectId } : {}),
      decisionId: item.decision.id,
      reason,
      actorKind: "human",
      actorId: "local_user",
    },
  }).then(
    () => {
      decisionCenterFeedback.value = "接管 fence 与停止请求已写入治理链。";
      return refreshDecisionCenter();
    },
    () => decisionCenterFeedback.value = "接管未完成，请检查董事会讨论与项目状态。",
  );
  decisionCenterPending.value = false;
}

onMounted(async () => {
  const stored = (() => {
    try {
      return parseGoalDraftStorage(localStorage.getItem(goalDraftStorageKey));
    } catch {
      draftStorageAvailable.value = false;
      return parseGoalDraftStorage(null);
    }
  })();
  goalDraft.value = stored.draft;
  try {
    previousGoalDraft.value = localStorage.getItem(previousGoalDraftStorageKey) ?? "";
  } catch {
    draftStorageAvailable.value = false;
  }
  generationRequestID.value = stored.request?.requestId ?? "";
  generationRequestGoal.value = stored.request?.goal ?? "";
  generationRequestStartedAt.value = restoreGenerationStartedAt();
  onboarding.value = parseOnboardingState(localStorage.getItem(onboardingStorageKey));
  onboardingHydrated.value = true;
  await nextTick();
  draftHydrated.value = true;
  if (stored.request) await recoverGeneratedGoalBrief(stored.request.requestId, stored.request.goal);
  if (newGoalOpen.value) {
    goalDraftSection.value?.scrollIntoView({ block: "start" });
    goalDraftInput.value?.focus();
  }
});

watch(
  () => route.query.newGoal,
  async value => {
    if (value !== "1") return;
    newGoalOpen.value = true;
    await nextTick();
    goalDraftSection.value?.scrollIntoView({ behavior: "smooth", block: "start" });
    goalDraftInput.value?.focus();
  },
);

function persistOnboarding(next: OnboardingState) {
  onboarding.value = next;
  if (import.meta.client) localStorage.setItem(onboardingStorageKey, serializeOnboardingState(next));
}

function chooseRealWorkspace() {
  persistOnboarding(chooseReal(onboarding.value, new Date().toISOString()));
  if (snapshot.value.company.providerConfigured === false) navigateTo("/settings");
}

function chooseDemoWorkspace() {
  persistOnboarding(chooseDemo(onboarding.value, new Date().toISOString()));
  navigateTo("/welcome");
}

async function openNewGoal() {
  newGoalOpen.value = true;
  const current = goalDraft.value.trim();
  if (current) {
    previousGoalDraft.value = goalDraft.value;
    try {
      localStorage.setItem(previousGoalDraftStorageKey, previousGoalDraft.value);
    } catch {
      draftStorageAvailable.value = false;
    }
  }
  goalDraft.value = "";
  generatedBrief.value = undefined;
  generationFailure.value = undefined;
  generationError.value = "";
  startError.value = "";
  startRequestID.value = "";
  newGoalFeedback.value = current
    ? "新的空白目标草稿已建立；上一份本地草稿已保留。"
    : "新的空白目标草稿已建立。";
  await nextTick();
  goalDraftSection.value?.scrollIntoView({ behavior: "smooth", block: "start" });
  goalDraftInput.value?.focus();
}

async function restorePreviousGoalDraft() {
  const previous = previousGoalDraft.value;
  if (!previous.trim()) return;
  const current = goalDraft.value;
  previousGoalDraft.value = current;
  try {
    if (current.trim()) localStorage.setItem(previousGoalDraftStorageKey, current);
    else localStorage.removeItem(previousGoalDraftStorageKey);
  } catch {
    draftStorageAvailable.value = false;
  }
  goalDraft.value = previous;
  newGoalFeedback.value = current.trim()
    ? "已切换到上一份本地草稿；刚才的草稿也已保留，可再次切换。"
    : "已恢复上一份本地草稿。";
  await nextTick();
  goalDraftInput.value?.focus();
}

function skipOnboardingChoice() {
  persistOnboarding(skipOnboarding(onboarding.value, new Date().toISOString()));
}

function currentGenerationRequest() {
  if (!generationRequestID.value || !generationRequestGoal.value) return null;
  return {
    requestId: generationRequestID.value,
    goal: generationRequestGoal.value,
  };
}

function restoreGenerationStartedAt() {
  if (!import.meta.client) return 0;
  try {
    const value = Number(localStorage.getItem(goalGenerationStartedAtStorageKey));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function beginGenerationRecoveryWindow() {
  const startedAt = Date.now();
  generationRequestStartedAt.value = startedAt;
  if (import.meta.client) {
    try {
      localStorage.setItem(goalGenerationStartedAtStorageKey, String(startedAt));
    } catch {}
  }
}

function clearGenerationRecoveryWindow() {
  generationRequestStartedAt.value = 0;
  if (import.meta.client) {
    try {
      localStorage.removeItem(goalGenerationStartedAtStorageKey);
    } catch {}
  }
}

function waitForRecoveryPoll(delay: number) {
  return new Promise(resolve => setTimeout(resolve, delay));
}

function persistGoalDraft() {
  if (!import.meta.client || !draftHydrated.value) return;
  try {
    localStorage.setItem(goalDraftStorageKey, serializeGoalDraftStorage({
      version: 1,
      draft: goalDraft.value,
      request: currentGenerationRequest(),
    }));
    draftStorageAvailable.value = true;
  } catch {
    draftStorageAvailable.value = false;
  }
}

async function recoverGeneratedGoalBrief(requestID: string, requestGoal: string) {
  if (!requestID || !requestGoal || requestGoal !== goalDraft.value.trim() || generatedBrief.value) return;
  const deadline = generationRequestStartedAt.value > 0
    ? generationRequestStartedAt.value + goalBriefRecoveryWindowMs
    : Date.now();
  recoveringGeneratedBrief.value = true;
  generationError.value = "";
  while (true) {
    const result = await $fetch.raw<unknown>("/api/agent-company/goal-brief/request", {
      query: { requestId: requestID },
      ignoreResponseError: true,
      timeout: 8_000,
    }).then(
      response => ({ ok: true as const, response }),
      () => ({ ok: false as const }),
    );
    if (
      requestID !== generationRequestID.value
      || requestGoal !== generationRequestGoal.value
      || requestGoal !== goalDraft.value.trim()
    ) {
      recoveringGeneratedBrief.value = false;
      return;
    }
    if (result.ok) {
      const response = parseGoalBriefGenerationResponse(result.response.status, result.response._data);
      if (response?.kind === "success" && !response.brief.projectId && !response.brief.sourceThreadId) {
        generatedBrief.value = response.brief;
        clearGenerationRecoveryWindow();
        recoveringGeneratedBrief.value = false;
        return;
      }
      if (response?.kind === "structured_failure") {
        generationFailure.value = parseGoalBriefFailure(response.failure);
        clearGenerationRecoveryWindow();
        recoveringGeneratedBrief.value = false;
        return;
      }
      if (response?.kind === "conflict" && response.error.code === "request_conflict") {
        generationError.value = response.error.message;
        clearGenerationRecoveryWindow();
        recoveringGeneratedBrief.value = false;
        return;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await waitForRecoveryPoll(Math.min(goalBriefRecoveryPollMs, remaining));
  }
  recoveringGeneratedBrief.value = false;
  generationError.value = "本地工作区仍已连接，但这次模型请求没有形成可恢复的目标摘要。请选择“重试生成”，或检查模型设置；草稿仍保存在本地。";
}

watch(goalDraft, (value) => {
  if (!import.meta.client || !draftHydrated.value) return;
  if (value.trim() !== generationRequestGoal.value) {
    generationRequestID.value = "";
    generationRequestGoal.value = "";
    clearGenerationRecoveryWindow();
  }
  generatedBrief.value = undefined;
  generationFailure.value = undefined;
  generationError.value = "";
  startError.value = "";
  startRequestID.value = "";
  persistGoalDraft();
});

async function generateGoalBrief() {
  const goal = goalDraft.value.trim();
  if (!goal || generating.value || !available.value) return;
  const request = goalDraftRequest(goal, currentGenerationRequest(), () => crypto.randomUUID());
  generationRequestID.value = request.requestId;
  generationRequestGoal.value = request.goal;
  beginGenerationRecoveryWindow();
  persistGoalDraft();

  generating.value = true;
  generationFailure.value = undefined;
  generationError.value = "";
  const result = await $fetch.raw<unknown>("/api/agent-company/goal-brief/generate", {
    method: "POST",
    body: {
      requestId: request.requestId,
      goal: request.goal,
    },
    ignoreResponseError: true,
    timeout: 165_000,
  }).then(
    response => ({ ok: true as const, response }),
    () => ({ ok: false as const }),
  );
  generating.value = false;
  if (!isCurrentGoalDraftRequest(goalDraft.value, currentGenerationRequest(), request)) {
    if (goalDraft.value.trim() === request.goal)
      generationError.value = "目标摘要请求状态发生变化，没有创建工作；草稿仍保存在本地，可以安全重试。";
    return;
  }
  if (!result.ok) {
    await recoverGeneratedGoalBrief(request.requestId, request.goal);
    return;
  }

  const response = parseGoalBriefGenerationResponse(
    result.response.status,
    result.response._data,
  );
  if (!response) {
    const detail = result.response._data && typeof result.response._data === "object"
      && "statusMessage" in result.response._data
      && typeof result.response._data.statusMessage === "string"
      ? result.response._data.statusMessage
      : "";
    generationError.value = detail
      ? `${detail}，草稿仍保存在本地。`
      : "目标摘要没有生成成功，请检查模型连接后重试；草稿仍保存在本地。";
    return;
  }
  if (response.kind === "success") {
    generatedBrief.value = response.brief;
    clearGenerationRecoveryWindow();
    return;
  }
  if (response.kind === "structured_failure") {
    generationFailure.value = parseGoalBriefFailure(response.failure);
    clearGenerationRecoveryWindow();
    return;
  }
  if (response.error.code === "request_in_progress") {
    await recoverGeneratedGoalBrief(request.requestId, request.goal);
    return;
  }
  clearGenerationRecoveryWindow();
  generationError.value = response.error.message;
}

async function editGoalDraft() {
  await nextTick();
  goalDraftInput.value?.focus();
}

async function startGoalBrief(brief: GoalBrief) {
  if (starting.value || !available.value) return;
  startRequestID.value ||= generationRequestID.value || crypto.randomUUID();
  starting.value = true;
  startError.value = "";
  const result = await $fetch.raw<unknown>(
    `/api/agent-company/goal-brief/${encodeURIComponent(brief.id)}/start`,
    {
      method: "POST",
      body: {
        requestId: startRequestID.value,
        expectedVersion: brief.version,
      },
      ignoreResponseError: true,
    },
  ).then(
    response => ({ ok: true as const, response }),
    () => ({ ok: false as const }),
  );
  starting.value = false;
  if (!result.ok) {
    startError.value = "开始执行服务暂时不可用，请重试。";
    return;
  }
  if (result.response.status === 200) {
    const response = GoalBriefStartResult.safeParse(result.response._data);
    if (response.success) {
      localStorage.removeItem(goalDraftStorageKey);
      localStorage.removeItem(goalGenerationStartedAtStorageKey);
      await refresh();
      await navigateTo(`/work/${encodeURIComponent(response.data.projectId)}`);
      return;
    }
  }
  const error = ExperienceApiError.safeParse(result.response._data);
  startError.value = error.success ? error.data.message : "开始执行响应无法识别，请重试。";
}
</script>

<template>
  <UDashboardPanel id="inbox" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page">
        <header class="ac-workspace-header">
          <div>
            <p class="ac-workspace-eyebrow">待处理队列</p>
            <h1 class="ac-workspace-title">收件箱</h1>
            <p class="ac-workspace-lede">
              需要你处理的决定、阻塞与交付会集中出现在这里。
            </p>
          </div>
          <div class="flex items-center gap-2">
            <UButton
              v-if="available && snapshot.company.providerConfigured !== false"
              color="neutral"
              variant="outline"
              icon="i-lucide-plus"
              @click="openNewGoal"
            >
              新建目标
            </UButton>
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-refresh-cw"
              aria-label="刷新收件箱"
              :loading="pending"
              @click="refreshInbox"
            />
          </div>
        </header>

        <section
          v-if="available && decisionCenter"
          class="ac-card-list"
          aria-label="决策中心"
        >
          <div class="ac-card-heading">
            <div>
              <p class="ac-card-kicker">决策中心</p>
              <h2>创始人治理决定</h2>
            </div>
            <span>{{ decisionCenter.pending.length }} 项待决定</span>
          </div>
          <p
            v-if="decisionCenterFeedback"
            aria-live="polite"
          >
            {{ decisionCenterFeedback }}
          </p>
          <article
            v-for="item in decisionCenter.pending"
            :id="`decision-${item.decision.id}`"
            :key="item.decision.id"
            class="ac-attention-card"
            :data-priority="item.decision.authorityClass === 'red' ? 'critical' : 'normal'"
          >
            <div class="ac-card-heading">
              <div>
                <p class="ac-card-kicker">{{ decisionSourceLabels[item.sourceLabel] }}</p>
                <h2>{{ item.decision.subject ?? "未命名决定" }}</h2>
              </div>
              <span class="ac-status-badge">{{ item.decision.currentStatus }}</span>
            </div>
            <p class="ac-card-reason">{{ item.decision.recommendation ?? item.decision.context ?? "历史记录没有可确认的建议内容。" }}</p>
            <p class="ac-card-impact">
              权限 {{ item.decision.authorityClass ?? "unknown" }}
              · 置信度 {{ item.decision.confidence === null ? "unknown" : `${Math.round(item.decision.confidence * 100)}%` }}
              · {{ item.decision.reversible === null ? "可逆性未知" : item.decision.reversible ? "可逆" : "不可逆" }}
            </p>
            <p v-if="item.decision.options?.length">备选：{{ item.decision.options.join("；") }}</p>
            <p v-if="item.gate">红灯审批：{{ item.gate.status }} · 请求方 {{ decisionSourceLabels[item.gate.requestedBy.kind] }}</p>
            <details class="ac-decision-references">
              <summary>依据与引用</summary>
              <div>
                <section>
                  <strong>原则</strong>
                  <NuxtLink
                    v-for="reference in item.decision.principleRefs ?? []"
                    :key="`${reference.assetId}:${reference.version}`"
                    :to="assetReferenceHref(reference)"
                  >
                    {{ reference.assetId }} v{{ reference.version }}
                  </NuxtLink>
                  <span v-if="!item.decision.principleRefs?.length">未引用</span>
                </section>
                <section>
                  <strong>Decision case</strong>
                  <NuxtLink
                    v-for="reference in item.decision.decisionCaseRefs ?? []"
                    :key="`${reference.assetId}:${reference.version}`"
                    :to="assetReferenceHref(reference)"
                  >
                    {{ reference.assetId }} v{{ reference.version }}
                  </NuxtLink>
                  <span v-if="!item.decision.decisionCaseRefs?.length">未引用</span>
                </section>
                <section>
                  <strong>Evidence</strong>
                  <NuxtLink
                    v-for="reference in item.decision.evidenceRefs ?? []"
                    :key="`${reference.kind}:${reference.id}:${reference.version ?? 0}`"
                    :to="evidenceReferenceHref(reference)"
                  >
                    {{ reference.kind }} · {{ reference.id }}<template v-if="reference.version"> · v{{ reference.version }}</template>
                  </NuxtLink>
                  <span v-if="!item.decision.evidenceRefs?.length">未引用</span>
                </section>
              </div>
            </details>
            <div class="ac-goal-generation-state__actions">
              <UButton
                color="neutral"
                :disabled="decisionCenterPending"
                @click="decisionAction(item, 'accept')"
              >
                接受
              </UButton>
              <UButton
                color="neutral"
                variant="outline"
                :disabled="decisionCenterPending"
                @click="decisionAction(item, 'reject')"
              >
                否决
              </UButton>
              <UButton
                color="neutral"
                variant="outline"
                :disabled="decisionCenterPending"
                @click="correctDecision(item, 'override')"
              >
                Override
              </UButton>
              <UButton
                color="neutral"
                variant="ghost"
                :disabled="decisionCenterPending"
                @click="correctDecision(item, 'correction')"
              >
                Correction
              </UButton>
              <UButton
                color="error"
                variant="soft"
                :disabled="decisionCenterPending || !item.decision.source?.boardThreadId"
                @click="takeoverDecision(item)"
              >
                接管
              </UButton>
            </div>
          </article>
          <article
            v-for="item in decisionCenter.executed"
            :key="`executed-${item.decision.id}`"
            class="ac-attention-card"
          >
            <div class="ac-card-heading">
              <div>
                <p class="ac-card-kicker">{{ decisionSourceLabels[item.sourceLabel] }} · 已执行</p>
                <h2>{{ item.decision.subject ?? "未命名决定" }}</h2>
              </div>
              <span>{{ item.outcomes.length }} 个 Outcome</span>
            </div>
            <p>{{ item.decision.finalDecision }}</p>
            <p v-for="outcome in item.outcomes" :key="outcome.id">{{ outcome.result }} · {{ outcome.summary }}</p>
            <details v-if="item.yellowSummary" class="ac-decision-references">
              <summary>Yellow 成本、checkpoint 与 Outcome</summary>
              <div>
                <section>
                  <strong>成本</strong>
                  <span>
                    {{ item.yellowSummary.cost.actual }} / {{ item.yellowSummary.cost.limit }}
                    {{ item.yellowSummary.cost.unit }}
                  </span>
                  <span>状态 {{ item.yellowSummary.status }}</span>
                </section>
                <section>
                  <strong>Checkpoint</strong>
                  <span>{{ item.yellowSummary.checkpointId ?? "缺失" }}</span>
                  <span>回滚处理器 {{ item.yellowSummary.rollbackHandlerId ?? "缺失" }}</span>
                </section>
                <section>
                  <strong>Outcome</strong>
                  <span v-for="outcomeId in item.yellowSummary.outcomeIds" :key="outcomeId">{{ outcomeId }}</span>
                  <span v-for="outcome in item.outcomes" :key="`result-${outcome.id}`">
                    {{ outcome.result }} · {{ outcome.summary }}
                  </span>
                  <span v-if="!item.yellowSummary.outcomeIds.length">尚未记录</span>
                </section>
                <section>
                  <strong>回滚记录</strong>
                  <span v-for="rollback in item.yellowSummary.rollbacks" :key="rollback.id">
                    {{ rollback.status }} · {{ rollback.reason }}<template v-if="rollback.result"> · {{ rollback.result }}</template>
                  </span>
                  <span v-if="!item.yellowSummary.rollbacks.length">尚未回滚</span>
                </section>
              </div>
            </details>
            <UButton
              v-if="item.yellowSummary"
              color="error"
              variant="soft"
              :disabled="decisionCenterPending || !item.yellowSummary.checkpointId || item.yellowSummary.status === 'rolled_back'"
              @click="rollbackYellow(item)"
            >
              Yellow Rollback
            </UButton>
            <UButton
              v-else
              color="neutral"
              variant="outline"
              :disabled="decisionCenterPending"
              @click="decisionAction(item, 'rollback')"
            >
              Rollback
            </UButton>
          </article>
          <article
            v-for="item in decisionCenter.delegated"
            :key="`delegated-${item.decision.id}`"
            class="ac-attention-card"
          >
            <div class="ac-card-heading">
              <div>
                <p class="ac-card-kicker">AI 代理决定</p>
                <h2>{{ item.decision.subject ?? "未命名决定" }}</h2>
              </div>
              <span class="ac-status-badge">{{ item.decision.currentStatus }}</span>
            </div>
            <p>{{ item.decision.finalDecision ?? item.decision.recommendation }}</p>
            <p>Snapshot {{ item.decision.founderTwinSnapshot?.id ?? "缺失" }} · {{ item.decision.evidenceRefs?.length ?? 0 }} 条证据</p>
            <details v-if="item.yellowSummary" class="ac-decision-references">
              <summary>Yellow 成本、checkpoint 与 Outcome</summary>
              <div>
                <section>
                  <strong>成本</strong>
                  <span>
                    {{ item.yellowSummary.cost.actual }} / {{ item.yellowSummary.cost.limit }}
                    {{ item.yellowSummary.cost.unit }}
                  </span>
                  <span>状态 {{ item.yellowSummary.status }}</span>
                </section>
                <section>
                  <strong>Checkpoint</strong>
                  <span>{{ item.yellowSummary.checkpointId ?? "缺失" }}</span>
                  <span>回滚处理器 {{ item.yellowSummary.rollbackHandlerId ?? "缺失" }}</span>
                </section>
                <section>
                  <strong>Outcome</strong>
                  <span v-for="outcomeId in item.yellowSummary.outcomeIds" :key="outcomeId">{{ outcomeId }}</span>
                  <span v-for="outcome in item.outcomes" :key="`result-${outcome.id}`">
                    {{ outcome.result }} · {{ outcome.summary }}
                  </span>
                  <span v-if="!item.yellowSummary.outcomeIds.length">尚未记录</span>
                </section>
                <section>
                  <strong>回滚记录</strong>
                  <span v-for="rollback in item.yellowSummary.rollbacks" :key="rollback.id">
                    {{ rollback.status }} · {{ rollback.reason }}<template v-if="rollback.result"> · {{ rollback.result }}</template>
                  </span>
                  <span v-if="!item.yellowSummary.rollbacks.length">尚未回滚</span>
                </section>
              </div>
            </details>
            <details class="ac-decision-references">
              <summary>原则、案例与 evidence</summary>
              <div>
                <section>
                  <strong>原则</strong>
                  <NuxtLink
                    v-for="reference in item.decision.principleRefs ?? []"
                    :key="`${reference.assetId}:${reference.version}`"
                    :to="assetReferenceHref(reference)"
                  >
                    {{ reference.assetId }} v{{ reference.version }}
                  </NuxtLink>
                </section>
                <section>
                  <strong>Decision case</strong>
                  <NuxtLink
                    v-for="reference in item.decision.decisionCaseRefs ?? []"
                    :key="`${reference.assetId}:${reference.version}`"
                    :to="assetReferenceHref(reference)"
                  >
                    {{ reference.assetId }} v{{ reference.version }}
                  </NuxtLink>
                </section>
                <section>
                  <strong>Evidence</strong>
                  <NuxtLink
                    v-for="reference in item.decision.evidenceRefs ?? []"
                    :key="`${reference.kind}:${reference.id}:${reference.version ?? 0}`"
                    :to="evidenceReferenceHref(reference)"
                  >
                    {{ reference.kind }} · {{ reference.id }}
                  </NuxtLink>
                </section>
              </div>
            </details>
            <UButton
              v-if="item.yellowSummary"
              color="error"
              variant="soft"
              :disabled="decisionCenterPending || !item.yellowSummary.checkpointId || item.yellowSummary.status === 'rolled_back'"
              @click="rollbackYellow(item)"
            >
              Yellow Rollback
            </UButton>
          </article>
          <article
            v-for="item in decisionCenter.overridden"
            :key="`overridden-${item.decision.id}`"
            class="ac-attention-card"
          >
            <div class="ac-card-heading">
              <div>
                <p class="ac-card-kicker">推翻与纠偏</p>
                <h2>{{ item.decision.subject ?? "未命名决定" }}</h2>
              </div>
              <span>{{ item.corrections.length }} 条追加记录</span>
            </div>
            <p v-for="correction in item.corrections" :key="correction.id">
              {{ correction.kind }} · {{ correction.humanDecision }} · {{ correction.reason }}
            </p>
          </article>
          <article
            v-for="item in decisionCenter.withOutcomes"
            :key="`outcome-${item.decision.id}`"
            class="ac-attention-card"
          >
            <div class="ac-card-heading">
              <div>
                <p class="ac-card-kicker">Decision Outcome</p>
                <h2>{{ item.decision.subject ?? "未命名决定" }}</h2>
              </div>
              <span>{{ item.outcomes.length }} 个独立信号</span>
            </div>
            <p v-for="outcome in item.outcomes" :key="outcome.id">
              {{ outcome.result }} · {{ outcome.summary }}
            </p>
          </article>
        </section>

        <!-- DELIV-01 — 分类计数概览：按真实事项的五类分布展示，count 为 0 的类别不出现 -->
        <div
          v-if="available && attentionCategories.length"
          class="ac-attention-summary"
          aria-label="待处理事项分类"
        >
          <span class="ac-attention-summary__total">{{ totalUnhandled }} 项待处理</span>
          <span
            v-for="category in attentionCategories"
            :key="category.type"
            class="ac-attention-summary__chip"
            :data-type="category.type"
          >
            {{ category.label }}
            <strong>{{ category.count }}</strong>
          </span>
        </div>

        <CompanyConnectionState
          v-if="!available || workUnavailable"
          :connection="snapshot.connection"
          :issue="snapshot.issue"
          :pending="pending"
          show-settings
          @retry="refresh()"
        />

        <section
          v-if="available && (attentionItems.length || currentUnavailableWork.length)"
          class="ac-card-list"
          aria-label="当前工作待处理事项"
        >
          <NuxtLink
            v-for="work in currentUnavailableWork"
            :key="work.workId"
            :to="`/work/${encodeURIComponent(work.workId)}`"
            class="ac-attention-card"
            data-priority="critical"
          >
            <div class="ac-card-heading">
              <div>
                <p class="ac-card-kicker">状态诊断</p>
                <h2>{{ work.title }}</h2>
              </div>
              <span class="ac-status-badge" data-status="unavailable">状态不可用</span>
            </div>
            <p class="ac-card-reason">{{ localizedReason(work.reason.text) }}</p>
            <p class="ac-card-impact">{{ work.diagnostics.length }} 项诊断需要查看</p>
            <span class="ac-card-action">
              查看诊断
              <UIcon name="i-lucide-arrow-right" />
            </span>
          </NuxtLink>

          <NuxtLink
            v-for="item in attentionItems"
            :key="item.id"
            :to="`/work/${encodeURIComponent(item.workId)}`"
            class="ac-attention-card"
            :data-priority="item.priority"
          >
            <div class="ac-card-heading">
              <div>
                <p class="ac-card-kicker">{{ item.workTitle }}</p>
                <h2>{{ item.title }}</h2>
              </div>
              <time :datetime="item.updatedAt">{{ dateTime.format(new Date(item.updatedAt)) }}</time>
            </div>
            <p class="ac-card-reason">{{ localizedReason(item.reason.text) }}</p>
            <p class="ac-card-impact">{{ item.impact }}</p>
            <span
              v-if="item.recommendedAction"
              class="ac-card-action"
              :aria-disabled="!item.recommendedAction.enabled"
              :data-disabled="!item.recommendedAction.enabled"
            >
              {{ appConfig.experience.actionLabels[item.recommendedAction.id] }}
              <small v-if="!item.recommendedAction.enabled"> · 暂不可用</small>
              <UIcon name="i-lucide-arrow-right" />
            </span>
          </NuxtLink>
        </section>

        <details
          v-if="available && historicalUnhandled"
          class="ac-detail-panel"
        >
          <summary>
            历史待办事项（{{ historicalUnhandled }} 项，来自 {{ historicalUnhandledWorkCount }} 项工作）
          </summary>
          <div class="ac-card-list">
            <NuxtLink
              v-for="work in historicalUnavailableWork"
              :key="work.workId"
              :to="`/work/${encodeURIComponent(work.workId)}`"
              class="ac-attention-card"
              data-priority="critical"
            >
              <div class="ac-card-heading">
                <div>
                  <p class="ac-card-kicker">历史状态诊断</p>
                  <h2>{{ work.title }}</h2>
                </div>
                <span class="ac-status-badge" data-status="unavailable">状态不可用</span>
              </div>
              <p class="ac-card-reason">{{ localizedReason(work.reason.text) }}</p>
            </NuxtLink>
            <NuxtLink
              v-for="item in historicalAttentionItems"
              :key="item.id"
              :to="`/work/${encodeURIComponent(item.workId)}`"
              class="ac-attention-card"
              :data-priority="item.priority"
            >
              <div class="ac-card-heading">
                <div>
                  <p class="ac-card-kicker">历史工作 · {{ item.workTitle }}</p>
                  <h2>{{ item.title }}</h2>
                </div>
                <time :datetime="item.updatedAt">{{ dateTime.format(new Date(item.updatedAt)) }}</time>
              </div>
              <p class="ac-card-reason">{{ localizedReason(item.reason.text) }}</p>
              <p class="ac-card-impact">{{ item.impact }}</p>
            </NuxtLink>
          </div>
        </details>

        <OnboardingChoice
          v-if="welcomeStage"
          :provider-configured="snapshot.company.providerConfigured !== false"
          @real="chooseRealWorkspace"
          @demo="chooseDemoWorkspace"
          @skip="skipOnboardingChoice"
        />

        <section
          v-if="showGoalDraft && !welcomeStage"
          ref="goalDraftSection"
          class="ac-empty-state"
          :class="{ 'ac-empty-state--with-connection': !available }"
        >
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon" aria-hidden="true">
              <UIcon name="i-lucide-inbox" />
            </span>
            <h2>
              {{
                available
                  ? firstRun
                    ? "让本地 AI 团队接手第一个交付目标"
                    : "创建一个新的交付目标"
                  : "本地目标草稿仍在这里"
              }}
            </h2>
            <p>
              {{
                available
                  ? "Agent Company 会先生成可调整的目标摘要；你确认开始后，它才会创建工作并启动团队执行。"
                  : "连接中断不会清除这份本地草稿。恢复连接后，可以继续生成只读目标摘要。"
              }}
            </p>

            <div class="ac-goal-draft">
              <div class="ac-goal-draft__heading">
                <div>
                  <span>目标草稿</span>
                  <strong>{{ draftStorageAvailable ? "本地保存" : "仅本页保留" }}</strong>
                </div>
                <small>未创建项目</small>
              </div>
              <div v-if="newGoalFeedback" class="ac-goal-generation-state" role="status">
                <p>{{ newGoalFeedback }}</p>
                <UButton
                  v-if="previousGoalDraft.trim()"
                  color="neutral"
                  variant="outline"
                  @click="restorePreviousGoalDraft"
                >
                  恢复上一份草稿
                </UButton>
              </div>
              <label for="inbox-goal-draft">描述你希望团队交付的结果</label>
              <textarea
                id="inbox-goal-draft"
                ref="goalDraftInput"
                v-model="goalDraft"
                rows="4"
                maxlength="8000"
                :placeholder="draftHydrated ? '例如：整理本地研究材料，形成结论可追溯的报告。' : '正在恢复本地草稿…'"
                :readonly="!draftHydrated"
              />
              <div class="ac-goal-draft__footer">
                <span>
                  <UIcon name="i-lucide-hard-drive" />
                  {{
                    draftStorageAvailable
                      ? hasLocalDraft
                        ? "已保存到此设备"
                        : "草稿先保存在此设备"
                      : "本地存储不可用，刷新或关闭页面会丢失草稿"
                  }}
                </span>
                <UButton
                  v-if="snapshot.company.providerConfigured === false"
                  color="neutral"
                  to="/settings"
                >
                  先连接模型服务
                </UButton>
                <UButton
                  v-else
                  color="neutral"
                  :loading="generating"
                  :disabled="!canGenerate"
                  @click="generateGoalBrief"
                >
                  生成目标摘要
                </UButton>
              </div>
              <p class="ac-goal-draft__boundary">
                点击“生成目标摘要”会把当前目标全文发送给{{ providerDisclosure }}处理。
                是否留存和计费取决于你与该服务方的账户条款；这不会授权发布、付款、采购、外联或外发消息。
                摘要会先作为未绑定工作的草稿保存在本机；点击“开始执行”后才会创建工作。
                <NuxtLink to="/settings">查看模型连接</NuxtLink>
              </p>
              <p v-if="generating" class="ac-goal-draft__boundary" role="status">
                正在把当前目标发送给{{ providerDisclosure }}并生成摘要，通常需要一到两分钟。请保持页面打开；超时后可以安全重试。
              </p>
              <p v-if="recoveringGeneratedBrief" class="ac-goal-draft__boundary" role="status">
                正在恢复此前生成的目标摘要…
              </p>
              <p
                v-if="snapshot.company.providerConfigured === false"
                class="ac-goal-draft__boundary"
              >
                连接模型服务后可以生成只读目标摘要。
              </p>
            </div>

            <div
              v-if="generationFailure"
              class="ac-goal-generation-state ac-goal-generation-state--error"
              role="alert"
            >
              <h3>{{ generationFailure.title }}</h3>
              <p>{{ generationFailure.detail }}</p>
              <div class="ac-goal-generation-state__actions">
                <UButton
                  v-for="action in generationFailure.actions"
                  :key="action.id"
                  color="neutral"
                  :variant="action.id === 'retry' ? 'solid' : 'outline'"
                  @click="action.id === 'retry' ? generateGoalBrief() : editGoalDraft()"
                >
                  {{ action.label }}
                </UButton>
              </div>
            </div>

            <div
              v-if="generationError"
              class="ac-goal-generation-state ac-goal-generation-state--error"
              role="alert"
            >
              <p>{{ generationError }}</p>
              <div class="ac-goal-generation-state__actions">
                <UButton color="neutral" @click="generateGoalBrief">
                  重试生成
                </UButton>
                <UButton color="neutral" variant="outline" to="/settings">
                  检查模型设置
                </UButton>
              </div>
            </div>

            <section
              v-if="generatedBrief"
              class="ac-goal-generation-state ac-goal-generation-state--success"
              aria-live="polite"
            >
              <GoalBriefCard
                :brief="generatedBrief"
                :readonly="!available"
                :starting="starting"
                @updated="generatedBrief = $event"
                @start="startGoalBrief"
              />
              <p v-if="startError" class="ac-goal-generation-state__boundary" role="alert">
                {{ startError }}
              </p>
              <p class="ac-goal-generation-state__boundary">
                摘要已保存在本地；开始后会绑定到唯一工作，重复提交不会创建第二个项目。
              </p>
            </section>

            <UButton
              v-if="available"
              class="ac-empty-state__action"
              color="neutral"
              variant="outline"
              :to="snapshot.company.providerConfigured === false ? '/settings' : '/work'"
            >
              {{ snapshot.company.providerConfigured === false ? "连接模型服务" : "查看工作" }}
            </UButton>
          </div>
        </section>

        <section
          v-if="available && !workUnavailable && !firstRun && attentionItems.length === 0 && currentUnavailableWork.length === 0"
          class="ac-empty-state"
        >
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon" aria-hidden="true">
              <UIcon name="i-lucide-circle-check" />
            </span>
            <h2>目前没有需要你处理的事项</h2>
            <p>已有工作会继续保留在“工作”；出现决定、阻塞或待验收成果时，这里会提示你。</p>
            <UButton
              class="ac-empty-state__action"
              color="neutral"
              variant="outline"
              to="/work"
            >
              查看正在进行的工作
            </UButton>
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
