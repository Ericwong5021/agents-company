<script setup lang="ts">
import type { GoalBrief } from "@agents-company/shared/experience";
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
const appConfig = useAppConfig();
const { data: snapshot, pending, refresh } = useCompanySnapshot();
const goalDraft = useState("agent-company-inbox-goal-draft", () => "");
const generationRequestID = useState("agent-company-inbox-goal-request-id", () => "");
const generationRequestGoal = useState("agent-company-inbox-goal-request-goal", () => "");
const draftHydrated = ref(false);
const generating = ref(false);
const generatedBrief = ref<GoalBrief>();
const generationFailure = ref<GoalBriefFailureView>();
const generationError = ref("");
const goalDraftInput = ref<HTMLTextAreaElement>();
const draftStorageAvailable = ref(true);
const onboarding = ref<OnboardingState>(parseOnboardingState(null));
const onboardingHydrated = ref(false);
const available = computed(() => ["ready", "degraded"].includes(snapshot.value.connection));
const workUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("work") ?? false);
const unavailableWork = computed(() => snapshot.value.work.filter(work => work.availability === "unavailable"));
const attentionItems = computed(() => aggregateAttention(snapshot.value.work));
const attentionCategories = computed(() => categorySummaries(countByType(attentionItems.value)));
const totalUnhandled = computed(() => attentionItems.value.length + unavailableWork.value.length);
const hasLocalDraft = computed(() => Boolean(goalDraft.value.trim()));
const firstRun = computed(() =>
  available.value
  && !workUnavailable.value
  && snapshot.value.work.length === 0
  && attentionItems.value.length === 0
  && unavailableWork.value.length === 0);
const showGoalDraft = computed(() => firstRun.value || (!available.value && hasLocalDraft.value));
// 首次进入且尚未做出选择时，先呈现“连接真实工作区 / 查看演示”两个清晰选项，而非直接跳到目标输入。
const welcomeStage = computed(() =>
  onboardingHydrated.value && firstRun.value && onboarding.value.mode === "unset");
const canGenerate = computed(() =>
  draftHydrated.value
  && available.value
  && snapshot.value.company.providerConfigured !== false
  && hasLocalDraft.value
  && !generating.value);
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
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

async function refreshDecisionCenter() {
  if (!available.value || !snapshot.value.company.id) return;
  decisionCenterPending.value = true;
  decisionCenterFeedback.value = "";
  await $fetch<DecisionCenterProjection>("/api/agent-company/decision-center", {
    query: { companyId: snapshot.value.company.id },
  }).then(
    value => decisionCenter.value = value,
    () => decisionCenterFeedback.value = "Decision Center 暂时无法读取，未显示缓存状态。",
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
  generationRequestID.value = stored.request?.requestId ?? "";
  generationRequestGoal.value = stored.request?.goal ?? "";
  onboarding.value = parseOnboardingState(localStorage.getItem(onboardingStorageKey));
  onboardingHydrated.value = true;
  await nextTick();
  draftHydrated.value = true;
});

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

watch(goalDraft, (value) => {
  if (!import.meta.client || !draftHydrated.value) return;
  if (value.trim() !== generationRequestGoal.value) {
    generationRequestID.value = "";
    generationRequestGoal.value = "";
  }
  generatedBrief.value = undefined;
  generationFailure.value = undefined;
  generationError.value = "";
  persistGoalDraft();
});

async function generateGoalBrief() {
  const goal = goalDraft.value.trim();
  if (!goal || generating.value || !available.value) return;
  const request = goalDraftRequest(goal, currentGenerationRequest(), () => crypto.randomUUID());
  generationRequestID.value = request.requestId;
  generationRequestGoal.value = request.goal;
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
  }).then(
    response => ({ ok: true as const, response }),
    () => ({ ok: false as const }),
  );
  generating.value = false;
  if (!isCurrentGoalDraftRequest(goalDraft.value, currentGenerationRequest(), request)) return;
  if (!result.ok) {
    generationError.value = draftStorageAvailable.value
      ? "目标摘要服务暂时不可用，草稿仍保存在此浏览器。"
      : "目标摘要服务暂时不可用，当前草稿仅保留在本页。";
    return;
  }

  const response = parseGoalBriefGenerationResponse(
    result.response.status,
    result.response._data,
  );
  if (!response) {
    generationError.value = "本地服务返回了无法识别的目标摘要，草稿没有被清除。";
    return;
  }
  if (response.kind === "success") {
    generatedBrief.value = response.brief;
    return;
  }
  if (response.kind === "structured_failure") {
    generationFailure.value = parseGoalBriefFailure(response.failure);
    return;
  }
  generationError.value = response.error.message;
}

async function editGoalDraft() {
  await nextTick();
  goalDraftInput.value?.focus();
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
            <p class="ac-workspace-eyebrow">Attention queue</p>
            <h1 class="ac-workspace-title">Inbox</h1>
            <p class="ac-workspace-lede">
              需要你处理的决定、阻塞与交付会集中出现在这里。
            </p>
          </div>
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-refresh-cw"
            aria-label="刷新 Inbox"
            :loading="pending"
            @click="refreshInbox"
          />
        </header>

        <section
          v-if="available && decisionCenter"
          class="ac-card-list"
          aria-label="Decision Center"
        >
          <div class="ac-card-heading">
            <div>
              <p class="ac-card-kicker">Decision Center</p>
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
            <UButton
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
          v-if="available && (attentionItems.length || unavailableWork.length)"
          class="ac-card-list"
          aria-label="待处理事项"
        >
          <NuxtLink
            v-for="work in unavailableWork"
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
            <p class="ac-card-reason">{{ work.reason.text }}</p>
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
            <p class="ac-card-reason">{{ item.reason.text }}</p>
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

        <OnboardingChoice
          v-if="welcomeStage"
          :provider-configured="snapshot.company.providerConfigured !== false"
          @real="chooseRealWorkspace"
          @demo="chooseDemoWorkspace"
          @skip="skipOnboardingChoice"
        />

        <section
          v-if="showGoalDraft && !welcomeStage"
          class="ac-empty-state"
          :class="{ 'ac-empty-state--with-connection': !available }"
        >
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon" aria-hidden="true">
              <UIcon name="i-lucide-inbox" />
            </span>
            <h2>
              {{ available ? "让本地 AI 团队接手第一个交付目标" : "本地目标草稿仍在这里" }}
            </h2>
            <p>
              {{
                available
                  ? "Agent Company 会把目标转为过程可控的团队执行，并把可验证成果保留在 Work 与 Library。当前还没有形成真实工作状态。"
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
                        ? "已保存到此浏览器"
                        : "输入内容只保存在此浏览器"
                      : "浏览器存储不可用，刷新或关闭页面会丢失草稿"
                  }}
                </span>
                <UButton
                  color="neutral"
                  :loading="generating"
                  :disabled="!canGenerate"
                  @click="generateGoalBrief"
                >
                  生成只读目标摘要
                </UButton>
              </div>
              <p class="ac-goal-draft__boundary">
                生成摘要会在本地 Control Plane 保存一个未绑定项目的 Brief，不会立项或启动 Agent。正式提交将在后续阶段开放。
              </p>
              <p
                v-if="snapshot.company.providerConfigured === false"
                class="ac-goal-draft__boundary"
              >
                连接 Provider 后可以生成只读目标摘要。
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

            <p
              v-if="generationError"
              class="ac-goal-generation-state ac-goal-generation-state--error"
              role="alert"
            >
              {{ generationError }}
            </p>

            <section
              v-if="generatedBrief"
              class="ac-goal-generation-state ac-goal-generation-state--success"
              aria-live="polite"
            >
              <GoalBriefCard
                :brief="generatedBrief"
                :readonly="!available"
                @updated="generatedBrief = $event"
              />
              <p class="ac-goal-generation-state__boundary">
                摘要已保存在本地 Control Plane，但没有绑定 Project，也不会开始执行。正式提交将在后续阶段开放。
              </p>
            </section>

            <UButton
              v-if="available"
              class="ac-empty-state__action"
              color="neutral"
              variant="outline"
              :to="snapshot.company.providerConfigured === false ? '/settings' : '/work'"
            >
              {{ snapshot.company.providerConfigured === false ? "连接 Provider" : "查看 Work" }}
            </UButton>
          </div>
        </section>

        <section
          v-if="available && !workUnavailable && !firstRun && attentionItems.length === 0 && unavailableWork.length === 0"
          class="ac-empty-state"
        >
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon" aria-hidden="true">
              <UIcon name="i-lucide-circle-check" />
            </span>
            <h2>目前没有需要你处理的事项</h2>
            <p>已有工作会继续保留在 Work；出现决定、阻塞或待验收成果时，这里会提示你。</p>
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
