<script setup lang="ts">
type Evidence = {
  id: string;
  position: "supporting" | "counter";
  source_kind: string;
  source_ref: string;
  summary: string;
  created_at: number;
};

type Belief = {
  id: string;
  statement: string;
  scope: string[];
  applicable_scopes: string[];
  inapplicable_scopes: string[];
  confidence: number;
  status: "candidate" | "contested" | "experiment_pending" | "validated" | "adopted" | "rejected" | "deprecated";
  action_implications: string[];
  interpretation_refs: Array<{ interpretation_id: string; position: "supporting" | "counter" | "context" }>;
  evidence: Evidence[];
  experiment_ids: string[];
  board_decision_id: string | null;
  updated_at: number;
};

type Experiment = {
  id: string;
  belief_id: string;
  hypothesis: string;
  status: "proposed" | "authorized" | "running" | "completed" | "evaluated" | "rejected" | "stopped";
  verdict: "pending" | "supported" | "refuted" | "inconclusive";
  authority_class: "green" | "yellow" | "red";
  approval_gate_id: string | null;
  outcome_signal_ids: string[];
};

type LearningWorkspace = {
  beliefs: Belief[];
  experiments: Experiment[];
  patches: unknown[];
  evidencePackage: {
    weak_gate: "confirmed" | "not_confirmed";
    requirements: Array<{ id: string; status: string; evidence_refs: string[] }>;
  };
};

const { data: learning, pending, error, refresh } = useFetch<LearningWorkspace>("/api/agent-company/learning", {
  default: (): LearningWorkspace => ({
    beliefs: [],
    experiments: [],
    patches: [],
    evidencePackage: { weak_gate: "not_confirmed", requirements: [] },
  }),
});
const statusLabel: Record<Belief["status"], string> = {
  candidate: "候选",
  contested: "有争议",
  experiment_pending: "实验待验证",
  validated: "证据已验证",
  adopted: "已采纳",
  rejected: "已拒绝",
  deprecated: "已弃用",
};
const dateTime = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const experimentsByBelief = computed(() => new Map(learning.value.beliefs.map(belief => [
  belief.id,
  learning.value.experiments.filter(experiment => experiment.belief_id === belief.id),
])));
type BeliefActionDraft = {
  position: "supporting" | "counter";
  source_kind: "interpretation" | "outcome_signal" | "artifact" | "decision" | "external";
  source_ref: string;
  summary: string;
  board_decision_id: string;
};
const beliefDrafts = reactive<Record<string, BeliefActionDraft>>({});
const outcomeDrafts = reactive<Record<string, string>>({});
const actionPending = ref("");
const actionFeedback = ref("");
const actionFailed = ref(false);
const beliefDraft = (beliefID: string) => beliefDrafts[beliefID] ??= {
  position: "supporting",
  source_kind: "external",
  source_ref: "",
  summary: "",
  board_decision_id: "",
};
async function mutate(path: string, body: Record<string, unknown>, pendingKey: string, success: string) {
  actionPending.value = pendingKey;
  actionFeedback.value = "";
  actionFailed.value = false;
  const written = await $fetch(path, { method: "POST", body }).then(
    () => true,
    () => false,
  );
  actionPending.value = "";
  actionFailed.value = !written;
  actionFeedback.value = written ? success : "操作未写入。请核对真实引用、当前状态与权限后重试。";
  if (written) await refresh();
}
async function appendEvidence(beliefID: string) {
  const draft = beliefDraft(beliefID);
  if (!draft.source_ref.trim() || !draft.summary.trim()) {
    actionFailed.value = true;
    actionFeedback.value = "追加证据需要真实来源引用和摘要。";
    return;
  }
  await mutate(`/api/agent-company/learning/beliefs/${encodeURIComponent(beliefID)}/evidence`, {
    position: draft.position,
    source_kind: draft.source_kind,
    source_ref: draft.source_ref.trim(),
    summary: draft.summary.trim(),
  }, `belief-evidence:${beliefID}`, "证据已追加。");
  if (!actionFailed.value) {
    draft.source_ref = "";
    draft.summary = "";
  }
}
async function adoptBelief(beliefID: string) {
  const draft = beliefDraft(beliefID);
  if (!draft.board_decision_id.trim()) {
    actionFailed.value = true;
    actionFeedback.value = "采纳需要与该 Belief 完全一致的已接受 Board Decision。";
    return;
  }
  await mutate(`/api/agent-company/learning/beliefs/${encodeURIComponent(beliefID)}/adopt`, {
    board_decision_id: draft.board_decision_id.trim(),
  }, `belief-adopt:${beliefID}`, "Belief 已按 Board 决定采纳。");
}
async function actOnExperiment(experiment: Experiment, action: "refresh_authority" | "start" | "complete" | "stop" | "attach_outcome") {
  const outcomeSignalID = outcomeDrafts[experiment.id]?.trim();
  if (action === "attach_outcome" && !outcomeSignalID) {
    actionFailed.value = true;
    actionFeedback.value = "评估需要真实且已验证的 Outcome Signal。";
    return;
  }
  await mutate(`/api/agent-company/learning/experiments/${encodeURIComponent(experiment.id)}/actions`, {
    action,
    ...(action === "refresh_authority" ? { idempotency_key: crypto.randomUUID() } : {}),
    ...(action === "attach_outcome" ? { outcome_signal_id: outcomeSignalID } : {}),
  }, `experiment:${experiment.id}`, `Experiment 已执行 ${action}。`);
  if (!actionFailed.value && action === "attach_outcome") outcomeDrafts[experiment.id] = "";
}
</script>

<template>
  <UDashboardPanel id="belief-lab" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page">
        <header class="ac-workspace-header">
          <div>
            <p class="ac-workspace-eyebrow">Organizational learning</p>
            <h1 class="ac-workspace-title">Belief Lab</h1>
            <p class="ac-workspace-lede">
              把同源 Interpretation 的支持、反证与适用边界放在一起；票数不会替公司作决定。
            </p>
          </div>
          <NuxtLink to="/library" class="ac-back-link">
            <UIcon name="i-lucide-arrow-left" />
            返回 Library
          </NuxtLink>
        </header>

        <div class="ac-work-toolbar">
          <nav class="ac-work-tabs" aria-label="成果库视图">
            <NuxtLink to="/library" class="ac-work-tab">Commons inbox</NuxtLink>
            <NuxtLink to="/library/interpretations" class="ac-work-tab">Interpretations</NuxtLink>
            <span class="ac-work-tab" data-active="true">
              Belief Lab
              <span class="ac-work-tab__count">{{ learning.beliefs.length }}</span>
            </span>
            <NuxtLink to="/library/patches" class="ac-work-tab">Patches</NuxtLink>
          </nav>
          <span class="ac-learning-gate" :data-status="learning.evidencePackage.weak_gate">
            E2E weak gate · {{ learning.evidencePackage.weak_gate }}
          </span>
        </div>

        <section v-if="pending" class="ac-detail-panel" aria-live="polite">正在读取 Belief 投影…</section>
        <section v-else-if="error" class="ac-detail-panel ac-brief-state--error">
          <h2>Belief Lab 暂时不可用</h2>
          <UButton color="neutral" variant="outline" @click="refresh()">重新读取</UButton>
        </section>
        <section v-else-if="learning.beliefs.length" class="ac-belief-ledger">
          <article v-for="belief in learning.beliefs" :key="belief.id" class="ac-belief-row">
            <header class="ac-belief-row__heading">
              <div>
                <p class="ac-card-kicker">{{ belief.scope.join(" · ") }}</p>
                <h2>{{ belief.statement }}</h2>
              </div>
              <span class="ac-status-badge" :data-status="belief.status">{{ statusLabel[belief.status] }}</span>
            </header>

            <div class="ac-belief-meter" aria-label="Belief confidence">
              <span :style="{ width: `${belief.confidence * 100}%` }" />
              <small>confidence {{ belief.confidence.toFixed(2) }}</small>
            </div>

            <div class="ac-belief-boundaries">
              <section>
                <p>适用范围</p>
                <ul>
                  <li v-for="scope in belief.applicable_scopes" :key="scope">{{ scope }}</li>
                  <li v-if="!belief.applicable_scopes.length">尚未确认</li>
                </ul>
              </section>
              <section>
                <p>不适用范围</p>
                <ul>
                  <li v-for="scope in belief.inapplicable_scopes" :key="scope">{{ scope }}</li>
                  <li v-if="!belief.inapplicable_scopes.length">尚未确认</li>
                </ul>
              </section>
            </div>

            <div class="ac-belief-evidence">
              <section>
                <header>
                  <span class="ac-evidence-dot" data-position="supporting" />
                  <strong>支持</strong>
                  <small>{{ belief.interpretation_refs.filter(item => item.position === "supporting").length + belief.evidence.filter(item => item.position === "supporting").length }}</small>
                </header>
                <p v-for="evidence in belief.evidence.filter(item => item.position === 'supporting')" :key="evidence.id">
                  {{ evidence.summary }}
                </p>
                <p v-if="!belief.evidence.some(item => item.position === 'supporting')" class="ac-learning-muted">
                  由 {{ belief.interpretation_refs.filter(item => item.position === "supporting").length }} 个 Interpretation 支撑
                </p>
              </section>
              <section>
                <header>
                  <span class="ac-evidence-dot" data-position="counter" />
                  <strong>反证</strong>
                  <small>{{ belief.interpretation_refs.filter(item => item.position === "counter").length + belief.evidence.filter(item => item.position === "counter").length }}</small>
                </header>
                <p v-for="evidence in belief.evidence.filter(item => item.position === 'counter')" :key="evidence.id">
                  {{ evidence.summary }}
                </p>
                <p v-if="!belief.evidence.some(item => item.position === 'counter')" class="ac-learning-muted">
                  保留 {{ belief.interpretation_refs.filter(item => item.position === "counter").length }} 个反方 Interpretation
                </p>
              </section>
            </div>

            <footer class="ac-belief-row__footer">
              <div>
                <span>{{ belief.interpretation_refs.length }} Interpretations</span>
                <span>{{ belief.evidence.length }} 条追加证据</span>
                <span>{{ dateTime.format(belief.updated_at) }}</span>
              </div>
              <div v-if="experimentsByBelief.get(belief.id)?.length" class="ac-belief-experiments">
                <div v-for="experiment in experimentsByBelief.get(belief.id)" :key="experiment.id">
                  <span :data-verdict="experiment.verdict">
                    {{ experiment.status }} · {{ experiment.verdict }}
                  </span>
                  <UButton
                    v-if="experiment.status === 'proposed'"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :loading="actionPending === `experiment:${experiment.id}`"
                    @click="actOnExperiment(experiment, 'refresh_authority')"
                  >
                    刷新权限
                  </UButton>
                  <template v-if="experiment.status === 'authorized'">
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :loading="actionPending === `experiment:${experiment.id}`"
                      @click="actOnExperiment(experiment, 'start')"
                    >
                      开始
                    </UButton>
                    <UButton size="xs" color="neutral" variant="ghost" @click="actOnExperiment(experiment, 'stop')">
                      停止
                    </UButton>
                  </template>
                  <template v-if="experiment.status === 'running'">
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :loading="actionPending === `experiment:${experiment.id}`"
                      @click="actOnExperiment(experiment, 'complete')"
                    >
                      记录完成
                    </UButton>
                    <UButton size="xs" color="neutral" variant="ghost" @click="actOnExperiment(experiment, 'stop')">
                      停止
                    </UButton>
                  </template>
                  <form v-if="experiment.status === 'completed'" class="ac-learning-inline-action" @submit.prevent="actOnExperiment(experiment, 'attach_outcome')">
                    <input v-model="outcomeDrafts[experiment.id]" required placeholder="真实 Outcome Signal ID">
                    <UButton type="submit" size="xs" color="neutral" variant="outline" :loading="actionPending === `experiment:${experiment.id}`">
                      连接结果
                    </UButton>
                  </form>
                </div>
              </div>
              <span v-else>未连接 Experiment</span>
            </footer>

            <details class="ac-settings-disclosure">
              <summary>追加证据或按 Board 决定采纳</summary>
              <form class="company-provider-form company-provider-form__grid" @submit.prevent="appendEvidence(belief.id)">
                <label>
                  <span>证据方向</span>
                  <select v-model="beliefDraft(belief.id).position">
                    <option value="supporting">支持</option>
                    <option value="counter">反证</option>
                  </select>
                </label>
                <label>
                  <span>来源类型</span>
                  <select v-model="beliefDraft(belief.id).source_kind">
                    <option value="interpretation">Interpretation</option>
                    <option value="outcome_signal">Outcome Signal</option>
                    <option value="artifact">Artifact</option>
                    <option value="decision">Decision</option>
                    <option value="external">External</option>
                  </select>
                </label>
                <label class="company-provider-form__wide">
                  <span>真实来源引用</span>
                  <input v-model="beliefDraft(belief.id).source_ref" required placeholder="已持久化记录或可核验来源 ID">
                </label>
                <label class="company-provider-form__wide">
                  <span>证据摘要</span>
                  <textarea v-model="beliefDraft(belief.id).summary" required rows="2" />
                </label>
                <div class="company-provider-form__actions company-provider-form__wide">
                  <small>追加证据不会自动改变 Belief 结论。</small>
                  <UButton type="submit" color="neutral" variant="outline" :loading="actionPending === `belief-evidence:${belief.id}`">
                    追加证据
                  </UButton>
                </div>
              </form>
              <form
                v-if="belief.status !== 'adopted'"
                class="company-provider-form ac-learning-adopt"
                @submit.prevent="adoptBelief(belief.id)"
              >
                <label>
                  <span>已接受 Board Decision ID</span>
                  <input v-model="beliefDraft(belief.id).board_decision_id" required placeholder="最终决定必须与 Belief 陈述完全一致">
                </label>
                <div class="company-provider-form__actions">
                  <small>采纳仍由 Control Plane 校验真实终态和精确陈述。</small>
                  <UButton type="submit" color="neutral" :loading="actionPending === `belief-adopt:${belief.id}`">
                    采纳 Belief
                  </UButton>
                </div>
              </form>
            </details>
          </article>
        </section>
        <section v-else class="ac-empty-state">
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon"><UIcon name="i-lucide-scale" /></span>
            <h2>还没有 Candidate Belief</h2>
            <p>同源资料至少需要支持与反方 Interpretation；候选只会进入 proposal，不会按多数票自动采纳。</p>
          </div>
        </section>
        <p
          v-if="actionFeedback"
          class="company-provider-form__message"
          :class="{ 'company-provider-form__message--error': actionFailed }"
          role="status"
        >
          {{ actionFeedback }}
        </p>
      </div>
    </template>
  </UDashboardPanel>
</template>
