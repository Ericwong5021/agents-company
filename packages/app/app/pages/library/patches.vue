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
  default: () => ({
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
          <nav class="ac-work-tabs" aria-label="Library 视图">
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
              <span v-if="patch.approval_gate_id">Gate {{ patch.approval_gate_id }}</span>
              <span v-else>无已建 ApprovalGate</span>
              <time>{{ dateTime.format(patch.updated_at) }}</time>
            </footer>
          </article>
        </section>
        <section v-else class="ac-empty-state">
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon"><UIcon name="i-lucide-git-compare-arrows" /></span>
            <h2>还没有 Learning Patch</h2>
            <p>只有连接真实 Outcome Signal 的 Experiment 才能提出 Patch；缺 Benchmark、Canary 或回滚时保持失败关闭。</p>
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
