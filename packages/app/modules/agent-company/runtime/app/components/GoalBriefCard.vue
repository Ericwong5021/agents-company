<script setup lang="ts">
import type { GoalBrief } from "@agents-company/shared/experience";
import {
  buildBriefAppendRequest,
  goalBriefView,
  parseGoalBriefAppendResponse,
  type GoalBriefFieldEdit,
} from "../../shared/goal-brief-view";

const props = defineProps<{
  brief: GoalBrief;
  // 只读时隐藏编辑与开始动作（例如连接中断或历史视图）。
  readonly?: boolean;
  starting?: boolean;
}>();

const emit = defineEmits<{
  updated: [brief: GoalBrief];
  start: [brief: GoalBrief];
}>();

const view = computed(() => goalBriefView(props.brief));
const showFullBrief = ref(false);
const editing = ref(false);
const saving = ref(false);
const saveError = ref("");

// 编辑工作副本。保存时只把与当前版本不同的字段作为受影响字段提交。
const draftGoal = ref("");
const draftConstraints = ref("");
const draftDeliverables = ref<{ id: string; title: string; description: string }[]>([]);
const draftAcceptance = ref<{ id: string; description: string; verification: string }[]>([]);
const draftQuestionAnswers = ref<Record<string, string>>({});

function beginEdit() {
  draftGoal.value = props.brief.goal;
  draftConstraints.value = props.brief.constraints.join("\n");
  draftDeliverables.value = props.brief.deliverables.map(item => ({ ...item }));
  draftAcceptance.value = props.brief.acceptanceCriteria.map(item => ({ ...item }));
  draftQuestionAnswers.value = {};
  saveError.value = "";
  editing.value = true;
}

function cancelEdit() {
  editing.value = false;
  saveError.value = "";
}

function collectEdit(): GoalBriefFieldEdit {
  const edit: GoalBriefFieldEdit = {};
  const goal = draftGoal.value.trim();
  if (goal && goal !== props.brief.goal) edit.goal = goal;

  const constraints = draftConstraints.value
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  if (JSON.stringify(constraints) !== JSON.stringify(props.brief.constraints)) edit.constraints = constraints;

  const deliverables = draftDeliverables.value.map(item => ({
    id: item.id,
    title: item.title.trim(),
    description: item.description.trim(),
  }));
  if (JSON.stringify(deliverables) !== JSON.stringify(props.brief.deliverables)) edit.deliverables = deliverables;

  const acceptance = draftAcceptance.value.map(item => ({
    id: item.id,
    description: item.description.trim(),
    verification: item.verification.trim(),
  }));
  if (JSON.stringify(acceptance) !== JSON.stringify(props.brief.acceptanceCriteria))
    edit.acceptanceCriteria = acceptance;

  const answered = props.brief.openQuestions.flatMap((question, index) => {
    const answer = draftQuestionAnswers.value[question.id]?.trim();
    return answer ? [{ question, answer, index }] : [];
  });
  if (answered.length) {
    const answeredIDs = new Set(answered.map(item => item.question.id));
    edit.openQuestions = props.brief.openQuestions.filter(question => !answeredIDs.has(question.id));
    edit.assumptions = [
      ...props.brief.assumptions,
      ...answered.map(item => ({
        id: `answer-${item.index + 1}-${item.question.id}`.slice(0, 240),
        description: `${item.question.question}：${item.answer}`,
        confirmed: true,
      })),
    ];
  }

  return edit;
}

async function saveEdit() {
  if (saving.value) return;
  const edit = collectEdit();
  if (Object.keys(edit).length === 0) {
    editing.value = false;
    return;
  }
  const request = (() => {
    try {
      return buildBriefAppendRequest(props.brief, edit);
    } catch {
      return undefined;
    }
  })();
  if (!request) {
    saveError.value = "修改内容不符合要求，请检查必填字段。";
    return;
  }

  saving.value = true;
  saveError.value = "";
  const result = await $fetch.raw<unknown>(
    `/api/agent-company/goal-brief/${encodeURIComponent(props.brief.id)}/versions`,
    { method: "POST", body: request, ignoreResponseError: true },
  ).then(
    response => ({ ok: true as const, response }),
    () => ({ ok: false as const }),
  );
  saving.value = false;

  if (!result.ok) {
    saveError.value = "目标摘要服务暂时不可用，修改未保存。";
    return;
  }
  const response = parseGoalBriefAppendResponse(result.response.status, result.response._data);
  if (response?.kind === "success") {
    editing.value = false;
    emit("updated", response.brief);
    return;
  }
  if (response?.kind === "version_conflict") {
    saveError.value = `目标摘要已被更新到第 ${response.currentVersion} 版，请刷新后重新编辑。`;
    return;
  }
  saveError.value = "修改未能保存，草稿仍保留在编辑框。";
}
</script>

<template>
  <section class="ac-brief" :data-editing="editing">
    <header class="ac-brief__heading">
      <div>
        <span class="ac-brief__eyebrow">Goal Brief</span>
        <h3>系统理解的目标</h3>
      </div>
      <div class="ac-brief__badges">
        <span class="ac-status-badge" :data-risk="view.riskLevel">风险 · {{ view.riskLabel }}</span>
        <span class="ac-status-badge" :data-autostart="view.autoStart">
          {{ view.autoStart ? "确认后自动开始" : view.approvalLabel }}
        </span>
      </div>
    </header>

    <!-- 目标 -->
    <div class="ac-brief__goal">
      <template v-if="editing">
        <label for="ac-brief-goal">理解的目标</label>
        <textarea id="ac-brief-goal" v-model="draftGoal" rows="3" maxlength="4000" />
      </template>
      <p v-else>{{ view.goal }}</p>
    </div>

    <div class="ac-brief__grid">
      <!-- 将交付 -->
      <div class="ac-brief__section">
        <h4>将交付</h4>
        <ul v-if="!editing">
          <li v-for="item in view.deliverables" :key="item.id">
            <strong>{{ item.title }}</strong>
            <span>{{ item.description }}</span>
          </li>
        </ul>
        <ul v-else class="ac-brief__edit-list">
          <li v-for="item in draftDeliverables" :key="item.id">
            <input v-model="item.title" maxlength="200" placeholder="交付物标题" />
            <textarea v-model="item.description" rows="2" maxlength="4000" placeholder="交付说明" />
          </li>
        </ul>
      </div>

      <!-- 完成标准 -->
      <div class="ac-brief__section">
        <h4>完成标准</h4>
        <ul v-if="!editing">
          <li v-for="item in view.acceptanceCriteria" :key="item.id">
            <span>{{ item.description }}</span>
            <small>验证：{{ item.verification }}</small>
          </li>
        </ul>
        <ul v-else class="ac-brief__edit-list">
          <li v-for="item in draftAcceptance" :key="item.id">
            <textarea v-model="item.description" rows="2" maxlength="4000" placeholder="验收标准" />
            <input v-model="item.verification" maxlength="4000" placeholder="如何验证" />
          </li>
        </ul>
      </div>
    </div>

    <!-- 推荐执行方式 -->
    <div class="ac-brief__section ac-brief__plan">
      <h4>推荐执行方式</h4>
      <p>{{ view.plan.summary }}</p>
      <p class="ac-brief__approval">{{ view.approvalDetail }}</p>
    </div>

    <!-- 需要决定（材料性开放问题）：为空时不渲染 -->
    <div v-if="view.hasMaterialQuestions" class="ac-brief__section ac-brief__questions">
      <h4>需要你决定 <span v-if="view.hasBlockingQuestions" class="ac-brief__blocking">有阻塞项</span></h4>
      <ul>
        <li v-for="question in view.materialQuestions" :key="question.id" :data-blocking="question.blocking">
          <strong>{{ question.question }}</strong>
          <span>{{ question.impact }}</span>
          <span class="ac-brief__default-assumption">若不回答：{{ question.defaultAssumption }}</span>
          <textarea
            v-if="editing"
            v-model="draftQuestionAnswers[question.id]"
            rows="2"
            maxlength="4000"
            placeholder="输入你的决定"
          />
        </li>
      </ul>
    </div>

    <!-- 系统已采用的默认假设：低风险可逆事项不打断用户，仅展示并留痕 -->
    <div v-if="view.hasAutoAdoptedAssumptions" class="ac-brief__section ac-brief__auto-adopted">
      <h4>系统已采用的默认假设</h4>
      <ul>
        <li v-for="item in view.autoAdoptedAssumptions" :key="item.id">
          <strong>{{ item.question }}</strong>
          <span>{{ item.defaultAssumption }}</span>
        </li>
      </ul>
    </div>

    <!-- 约束（编辑态可改） -->
    <div v-if="editing" class="ac-brief__section">
      <label for="ac-brief-constraints">约束（每行一条）</label>
      <textarea id="ac-brief-constraints" v-model="draftConstraints" rows="3" maxlength="4000" />
    </div>

    <!-- 完整 Brief：低频治理字段 -->
    <div v-if="view.hasFullBriefDetail && !editing" class="ac-brief__full">
      <button type="button" class="ac-brief__toggle" :aria-expanded="showFullBrief" @click="showFullBrief = !showFullBrief">
        {{ showFullBrief ? "收起完整 Brief" : "查看完整 Brief" }}
        <UIcon :name="showFullBrief ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
      </button>
      <div v-if="showFullBrief" class="ac-brief__full-body">
        <div v-if="view.fullBrief.constraints.length">
          <h5>约束</h5>
          <ul><li v-for="(item, index) in view.fullBrief.constraints" :key="index">{{ item }}</li></ul>
        </div>
        <div v-if="view.fullBrief.nonGoals.length">
          <h5>非目标</h5>
          <ul><li v-for="(item, index) in view.fullBrief.nonGoals" :key="index">{{ item }}</li></ul>
        </div>
        <div v-if="view.fullBrief.assumptions.length">
          <h5>系统假设（不阻塞开始）</h5>
          <ul>
            <li v-for="item in view.fullBrief.assumptions" :key="item.id" :data-confirmed="item.confirmed">
              {{ item.description }}
              <small>{{ item.confirmed ? "已确认" : "系统暂定 · 不阻塞" }}</small>
            </li>
          </ul>
        </div>
        <div v-if="view.fullBrief.planSteps.length">
          <h5>执行步骤</h5>
          <ol>
            <li v-for="step in view.fullBrief.planSteps" :key="step.id">
              <strong>{{ step.title }}</strong>
              <span>{{ step.outcome }}</span>
            </li>
          </ol>
        </div>
      </div>
    </div>

    <p v-if="saveError" class="ac-brief__error" role="alert">{{ saveError }}</p>

    <footer v-if="!readonly" class="ac-brief__actions">
      <template v-if="editing">
        <UButton color="neutral" :loading="saving" @click="saveEdit">保存修改</UButton>
        <UButton color="neutral" variant="ghost" :disabled="saving" @click="cancelEdit">取消</UButton>
      </template>
      <template v-else>
        <UButton
          color="neutral"
          :loading="starting"
          :disabled="view.hasMaterialQuestions"
          @click="emit('start', props.brief)"
        >
          {{ view.hasMaterialQuestions ? "请先处理关键问题" : view.autoStart ? "确认并开始" : "开始执行" }}
        </UButton>
        <UButton color="neutral" variant="outline" @click="beginEdit">调整</UButton>
      </template>
    </footer>
  </section>
</template>
