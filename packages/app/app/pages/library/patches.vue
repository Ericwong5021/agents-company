<script setup lang="ts">
type PatchBenchmark = {
  id: string;
  version: number;
  holdout_sha256: string;
  reviewer_id: string;
  result: "passed" | "failed" | "not_confirmed";
  real_sample_count: number;
};

type PatchCanary = {
  id: string;
  status: "running" | "passed" | "failed" | "rolled_back" | "not_confirmed";
  metric_evidence_refs: string[];
};

type LearningPatch = {
  id: string;
  target_type: "governance_asset" | "delegation_policy" | "skill" | "benchmark" | "agent_interest" | "workflow";
  target_id: string;
  expected_impact: string;
  benchmark_plan: string;
  rollback_plan: string;
  status: "proposed" | "approved" | "canary" | "active" | "rejected" | "rolled_back";
  authority_class: "yellow" | "red";
  approval_gate_id: string | null;
  active_target_version_id: string | null;
  evidence: string[];
  benchmarks: PatchBenchmark[];
  canaries: PatchCanary[];
  updated_at: number;
};

type LearningWorkspace = {
  beliefs: unknown[];
  experiments: unknown[];
  patches: LearningPatch[];
  evidencePackage: {
    weak_gate: "confirmed" | "not_confirmed";
    requirements: Array<{ id: string; status: "present" | "missing" | "not_confirmed"; evidence_refs: string[] }>;
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
const targetLabel: Record<LearningPatch["target_type"], string> = {
  governance_asset: "Governance asset",
  delegation_policy: "Delegation policy",
  skill: "Skill snapshot",
  benchmark: "Benchmark",
  agent_interest: "Agent interest",
  workflow: "Workflow",
};
const dateTime = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const stages = ["proposed", "approved", "canary", "active"] as const;
const reached = (patch: LearningPatch, stage: typeof stages[number]) => {
  if (patch.status === "rolled_back") return stage !== "active";
  if (patch.status === "rejected") return stage === "proposed";
  return stages.indexOf(stage) <= stages.indexOf(patch.status as typeof stages[number]);
};
type PatchAction = "approve" | "reject" | "record_benchmark" | "start_canary" | "finish_canary" | "activate" | "rollback";
type PatchActionDraft = {
  action: PatchAction;
  decision_id: string;
  holdout_manifest_ref: string;
  author_id: string;
  subject_id: string;
  reviewer_id: string;
  report_author_id: string;
  benchmark_result: "passed" | "failed" | "not_confirmed";
  evidence_refs: string;
  real_sample_count: number;
  previous_version_ref: string;
  candidate_version_ref: string;
  skill_snapshot_id: string;
  canary_id: string;
  canary_result: "passed" | "failed" | "not_confirmed";
  metric_evidence_refs: string;
  rollback_reason: string;
};
const actionLabels: Record<PatchAction, string> = {
  approve: "提交权限审批",
  reject: "拒绝 Patch",
  record_benchmark: "记录 Benchmark",
  start_canary: "启动 Canary",
  finish_canary: "完成 Canary",
  activate: "激活 Patch",
  rollback: "回滚 Patch",
};
const patchDrafts = reactive<Record<string, PatchActionDraft>>({});
const actionPending = ref("");
const actionFeedback = ref("");
const actionFailed = ref(false);
const patchActions = (patch: LearningPatch): PatchAction[] => {
  if (patch.status === "proposed") return ["approve", "record_benchmark", "reject"];
  if (patch.status === "approved") return ["record_benchmark", "start_canary", "reject"];
  if (patch.status === "canary") return ["finish_canary", "activate", "rollback"];
  if (patch.status === "active") return ["rollback"];
  return [];
};
const patchDraft = (patch: LearningPatch) => patchDrafts[patch.id] ??= {
  action: patchActions(patch)[0] ?? "rollback",
  decision_id: "",
  holdout_manifest_ref: "",
  author_id: "",
  subject_id: "",
  reviewer_id: "",
  report_author_id: "",
  benchmark_result: "not_confirmed",
  evidence_refs: "",
  real_sample_count: 0,
  previous_version_ref: patch.active_target_version_id ?? `initial:${patch.target_type}:${patch.target_id}`,
  candidate_version_ref: `candidate:${patch.id}`,
  skill_snapshot_id: "",
  canary_id: "",
  canary_result: "not_confirmed",
  metric_evidence_refs: "",
  rollback_reason: "",
};
const references = (value: string) => value.split(",").map(item => item.trim()).filter(Boolean);
function actionBody(patch: LearningPatch) {
  const draft = patchDraft(patch);
  if (draft.action === "approve")
    return { action: draft.action, decision_id: draft.decision_id.trim(), idempotency_key: crypto.randomUUID() };
  if (draft.action === "reject" || draft.action === "activate") return { action: draft.action };
  if (draft.action === "record_benchmark")
    return {
      action: draft.action,
      holdout_manifest: { reference: draft.holdout_manifest_ref.trim() },
      author_id: draft.author_id.trim(),
      ...(draft.subject_id.trim() ? { subject_id: draft.subject_id.trim() } : {}),
      reviewer_id: draft.reviewer_id.trim(),
      report_author_id: draft.report_author_id.trim(),
      result: draft.benchmark_result,
      evidence_refs: references(draft.evidence_refs),
      real_sample_count: draft.real_sample_count,
    };
  if (draft.action === "start_canary")
    return {
      action: draft.action,
      previous_version_ref: draft.previous_version_ref.trim(),
      candidate_version_ref: draft.candidate_version_ref.trim(),
      ...(draft.skill_snapshot_id.trim() ? { skill_snapshot_id: draft.skill_snapshot_id.trim() } : {}),
    };
  if (draft.action === "finish_canary")
    return {
      action: draft.action,
      canary_id: draft.canary_id.trim()
        || patch.canaries.find(canary => canary.status === "running")?.id
        || "",
      result: draft.canary_result,
      metric_evidence_refs: references(draft.metric_evidence_refs),
    };
  return { action: "rollback" as const, reason: draft.rollback_reason.trim() };
}
async function submitPatchAction(patch: LearningPatch) {
  const draft = patchDraft(patch);
  const body = actionBody(patch);
  if (
    (draft.action === "approve" && !draft.decision_id.trim())
    || (draft.action === "record_benchmark"
      && (!draft.holdout_manifest_ref.trim() || !draft.author_id.trim() || !draft.reviewer_id.trim() || !draft.report_author_id.trim()))
    || (draft.action === "start_canary" && (!draft.previous_version_ref.trim() || !draft.candidate_version_ref.trim()))
    || (draft.action === "finish_canary"
      && !draft.canary_id.trim()
      && !patch.canaries.some(canary => canary.status === "running"))
    || (draft.action === "rollback" && !draft.rollback_reason.trim())
  ) {
    actionFailed.value = true;
    actionFeedback.value = "请补齐该操作要求的真实引用和责任主体。";
    return;
  }
  actionPending.value = patch.id;
  actionFeedback.value = "";
  actionFailed.value = false;
  const written = await $fetch(`/api/agent-company/learning/patches/${encodeURIComponent(patch.id)}/actions`, {
    method: "POST",
    body,
  }).then(
    () => true,
    () => false,
  );
  actionPending.value = "";
  actionFailed.value = !written;
  actionFeedback.value = written
    ? `${actionLabels[draft.action]}已写入。`
    : "操作未写入。请核对权限、当前状态与所有真实证据引用。";
  if (written) {
    await refresh();
    delete patchDrafts[patch.id];
  }
}
</script>

<template>
  <UDashboardPanel id="learning-patches" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page">
        <header class="ac-workspace-header">
          <div>
            <p class="ac-workspace-eyebrow">Governed improvement</p>
            <h1 class="ac-workspace-title">Learning Patches</h1>
            <p class="ac-workspace-lede">
              Proposal、权限、冻结 Benchmark、Canary 与回滚逐层留痕；运行完成不会替代真实结果。
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
            <NuxtLink to="/library/beliefs" class="ac-work-tab">Belief Lab</NuxtLink>
            <span class="ac-work-tab" data-active="true">
              Patches
              <span class="ac-work-tab__count">{{ learning.patches.length }}</span>
            </span>
          </nav>
          <span class="ac-learning-gate" :data-status="learning.evidencePackage.weak_gate">
            Real chain · {{ learning.evidencePackage.weak_gate }}
          </span>
        </div>

        <section class="ac-patch-gate-strip" aria-label="E2E evidence status">
          <span
            v-for="requirement in learning.evidencePackage.requirements"
            :key="requirement.id"
            :data-status="requirement.status"
          >
            {{ requirement.id.replaceAll("_", " ") }}
          </span>
        </section>

        <section v-if="pending" class="ac-detail-panel" aria-live="polite">正在读取 Learning Patch 投影…</section>
        <section v-else-if="error" class="ac-detail-panel ac-brief-state--error">
          <h2>Learning Patches 暂时不可用</h2>
          <UButton color="neutral" variant="outline" @click="refresh()">重新读取</UButton>
        </section>
        <section v-else-if="learning.patches.length" class="ac-patch-ledger">
          <article v-for="patch in learning.patches" :key="patch.id" class="ac-patch-row">
            <header>
              <div>
                <p class="ac-card-kicker">{{ targetLabel[patch.target_type] }}</p>
                <h2>{{ patch.target_id }}</h2>
                <p>{{ patch.expected_impact }}</p>
              </div>
              <div class="ac-patch-authority">
                <span :data-authority="patch.authority_class">{{ patch.authority_class }}</span>
                <small>{{ patch.status }}</small>
              </div>
            </header>

            <ol class="ac-patch-track" aria-label="Patch lifecycle">
              <li v-for="stage in stages" :key="stage" :data-reached="reached(patch, stage)">
                <span />
                {{ stage }}
              </li>
            </ol>

            <div class="ac-patch-facts">
              <section>
                <p>Benchmark</p>
                <template v-if="patch.benchmarks.length">
                  <strong>v{{ patch.benchmarks.at(-1)?.version }} · {{ patch.benchmarks.at(-1)?.result }}</strong>
                  <span>{{ patch.benchmarks.at(-1)?.real_sample_count }} real samples</span>
                  <code>{{ patch.benchmarks.at(-1)?.holdout_sha256.slice(0, 12) }}</code>
                </template>
                <span v-else>未冻结留出集</span>
              </section>
              <section>
                <p>Canary</p>
                <template v-if="patch.canaries.length">
                  <strong>{{ patch.canaries.at(-1)?.status }}</strong>
                  <span>{{ patch.canaries.at(-1)?.metric_evidence_refs.length }} metric evidence</span>
                </template>
                <span v-else>尚未进入 Canary</span>
              </section>
              <section>
                <p>Rollback</p>
                <strong>已登记</strong>
                <span>{{ patch.rollback_plan }}</span>
              </section>
            </div>

            <footer>
              <span>{{ patch.evidence.length }} evidence refs</span>
              <span v-if="patch.approval_gate_id">审批 {{ patch.approval_gate_id }}</span>
              <span v-else>无已建审批</span>
              <time>{{ dateTime.format(patch.updated_at) }}</time>
            </footer>

            <details v-if="patchActions(patch).length" class="ac-settings-disclosure">
              <summary>推进 Patch 生命周期</summary>
              <form class="company-provider-form company-provider-form__grid" @submit.prevent="submitPatchAction(patch)">
                <label class="company-provider-form__wide">
                  <span>操作</span>
                  <select v-model="patchDraft(patch).action">
                    <option v-for="action in patchActions(patch)" :key="action" :value="action">
                      {{ actionLabels[action] }}
                    </option>
                  </select>
                </label>

                <label v-if="patchDraft(patch).action === 'approve'" class="company-provider-form__wide">
                  <span>治理 Decision ID</span>
                  <input v-model="patchDraft(patch).decision_id" required placeholder="与该 Patch 关联的真实 DecisionRecord">
                  <small>
                    Decision subject 必须为 <code>learning_patch:{{ patch.id }}</code>，
                    final decision 必须为 <code>approve_learning_patch:{{ patch.id }}</code>。
                  </small>
                </label>

                <template v-if="patchDraft(patch).action === 'record_benchmark'">
                  <label class="company-provider-form__wide">
                    <span>冻结 Holdout manifest 引用</span>
                    <input v-model="patchDraft(patch).holdout_manifest_ref" required placeholder="可核验的留出集清单引用">
                  </label>
                  <label>
                    <span>报告作者 Agent ID</span>
                    <input v-model="patchDraft(patch).author_id" required>
                  </label>
                  <label>
                    <span>独立 Reviewer Agent ID</span>
                    <input v-model="patchDraft(patch).reviewer_id" required>
                  </label>
                  <label>
                    <span>报告签发 Agent ID</span>
                    <input v-model="patchDraft(patch).report_author_id" required>
                  </label>
                  <label>
                    <span>被评估主体 ID，可选</span>
                    <input v-model="patchDraft(patch).subject_id">
                  </label>
                  <label>
                    <span>结果</span>
                    <select v-model="patchDraft(patch).benchmark_result">
                      <option value="not_confirmed">not_confirmed</option>
                      <option value="passed">passed</option>
                      <option value="failed">failed</option>
                    </select>
                  </label>
                  <label>
                    <span>真实样本数</span>
                    <input v-model.number="patchDraft(patch).real_sample_count" type="number" min="0" step="1">
                  </label>
                  <label class="company-provider-form__wide">
                    <span>证据引用，逗号分隔</span>
                    <input v-model="patchDraft(patch).evidence_refs" placeholder="仅填写已持久化执行事实">
                  </label>
                </template>

                <template v-if="patchDraft(patch).action === 'start_canary'">
                  <label>
                    <span>上一版本引用</span>
                    <input v-model="patchDraft(patch).previous_version_ref" required readonly>
                  </label>
                  <label>
                    <span>候选版本引用</span>
                    <input v-model="patchDraft(patch).candidate_version_ref" required readonly>
                  </label>
                  <label v-if="patch.target_type === 'skill'" class="company-provider-form__wide">
                    <span>真实 SkillSnapshot ID</span>
                    <input v-model="patchDraft(patch).skill_snapshot_id" required>
                  </label>
                </template>

                <template v-if="patchDraft(patch).action === 'finish_canary'">
                  <label>
                    <span>Canary ID</span>
                    <input
                      v-model="patchDraft(patch).canary_id"
                      :placeholder="patch.canaries.find(canary => canary.status === 'running')?.id ?? '运行中的 Canary ID'"
                    >
                  </label>
                  <label>
                    <span>结果</span>
                    <select v-model="patchDraft(patch).canary_result">
                      <option value="not_confirmed">not_confirmed</option>
                      <option value="passed">passed</option>
                      <option value="failed">failed</option>
                    </select>
                  </label>
                  <label class="company-provider-form__wide">
                    <span>指标证据引用，逗号分隔</span>
                    <input v-model="patchDraft(patch).metric_evidence_refs" placeholder="仅填写已持久化指标事实">
                  </label>
                </template>

                <label v-if="patchDraft(patch).action === 'rollback'" class="company-provider-form__wide">
                  <span>回滚原因</span>
                  <textarea v-model="patchDraft(patch).rollback_reason" required rows="2" />
                </label>

                <div class="company-provider-form__actions company-provider-form__wide">
                  <small>默认保持 not_confirmed，不以表单提交替代真实样本或真实结果。</small>
                  <UButton
                    type="submit"
                    color="neutral"
                    :variant="patchDraft(patch).action === 'rollback' ? 'outline' : 'solid'"
                    :loading="actionPending === patch.id"
                  >
                    {{ actionLabels[patchDraft(patch).action] }}
                  </UButton>
                </div>
              </form>
            </details>
          </article>
        </section>
        <section v-else class="ac-empty-state">
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon"><UIcon name="i-lucide-git-compare-arrows" /></span>
            <h2>还没有 Learning Patch</h2>
            <p>只有连接真实 Outcome Signal 的 Experiment 才能提出 Patch；缺 Benchmark、Canary 或回滚时保持失败关闭。</p>
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
