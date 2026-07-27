<script setup lang="ts">
import type { GoalBrief } from "@agents-company/shared/experience";
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
const available = computed(() => ["ready", "degraded"].includes(snapshot.value.connection));
const workUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("work") ?? false);
const priority = { critical: 0, high: 1, normal: 2 } as const;
const unavailableWork = computed(() => snapshot.value.work.filter(work => work.availability === "unavailable"));
const attentionItems = computed(() => snapshot.value.work
  .filter(work => work.availability === "available")
  .flatMap(work => work.attentionItems.map(item => ({
    ...item,
    workTitle: work.summary.title,
  })))
  .sort((left, right) =>
    priority[left.priority] - priority[right.priority]
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)));
const hasLocalDraft = computed(() => Boolean(goalDraft.value.trim()));
const firstRun = computed(() =>
  available.value
  && !workUnavailable.value
  && snapshot.value.work.length === 0
  && attentionItems.value.length === 0
  && unavailableWork.value.length === 0);
const showGoalDraft = computed(() => firstRun.value || (!available.value && hasLocalDraft.value));
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
  await nextTick();
  draftHydrated.value = true;
});

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
            @click="refresh()"
          />
        </header>

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

        <section
          v-if="showGoalDraft"
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
              <div class="ac-goal-generation-state__heading">
                <div>
                  <span>Goal Brief</span>
                  <h3>只读目标摘要</h3>
                </div>
                <strong>未立项</strong>
              </div>
              <p class="ac-goal-generation-state__goal">{{ generatedBrief.goal }}</p>
              <dl>
                <div>
                  <dt>交付内容</dt>
                  <dd>{{ generatedBrief.deliverables.length }} 项</dd>
                </div>
                <div>
                  <dt>验收标准</dt>
                  <dd>{{ generatedBrief.acceptanceCriteria.length }} 项</dd>
                </div>
                <div>
                  <dt>风险</dt>
                  <dd>{{ generatedBrief.riskLevel }}</dd>
                </div>
              </dl>
              <p>摘要已保存在本地 Control Plane，但没有绑定 Project，也不会开始执行。</p>
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
