<script setup lang="ts">
import type { CompanyAgentDetail } from "../../../modules/agent-company/runtime/shared/company-contract";

const appConfig = useAppConfig();
const route = useRoute();
const agentID = computed(() => Array.isArray(route.params.agentID)
  ? route.params.agentID[0]
  : route.params.agentID);
const {
  data: detail,
  status,
  error,
  refresh,
} = useFetch<CompanyAgentDetail>(() => `/api/agent-company/agents/${encodeURIComponent(agentID.value ?? "")}`);
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
// TEAM-01/TEAM-02：能力证据状态直接来自 Control Plane 的证据事实，不做前端推断。
const capabilityLabels: Record<string, string> = {
  declared: "已声明（未验证）",
  verified: "已验证",
  expired: "证据过期",
};
const outcomeLabels: Record<string, string> = {
  success: "成功交付",
  failure: "交付失败",
};
</script>

<template>
  <UDashboardPanel id="team-agent" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page ac-workspace-page--narrow">
        <NuxtLink to="/team" class="ac-back-link">
          <UIcon name="i-lucide-arrow-left" />
          返回团队
        </NuxtLink>

        <section v-if="status === 'pending'" class="ac-detail-panel mt-5" aria-live="polite">
          正在读取成员事实…
        </section>

        <section v-else-if="error || !detail" class="ac-detail-panel ac-brief-state--error mt-5">
          <h1 class="ac-workspace-title">成员详情暂时不可用</h1>
          <p>未能从本地服务读取该成员的真实活动与证据，页面不会展示猜测或过期副本。</p>
          <UButton color="neutral" variant="outline" @click="refresh()">
            重新读取
          </UButton>
        </section>

        <template v-else>
          <header class="ac-workspace-header mt-5">
            <div>
              <p class="ac-workspace-eyebrow">
                {{ detail.agent.employment === "employee" ? "正式员工" : "在岗临时角色" }}
              </p>
              <h1 class="ac-workspace-title">{{ detail.agent.name }}</h1>
              <p class="ac-workspace-lede">
                {{ detail.agent.role ?? "团队成员" }} ·
                {{ appConfig.experience.activityLabels[detail.agent.activity] }} ·
                进行中 {{ detail.agent.workload.active }} · 阻塞 {{ detail.agent.workload.blocked }}
              </p>
            </div>
          </header>

          <section class="ac-detail-panel ac-agent-panel" aria-label="能力证据">
            <p class="ac-card-kicker">Capability evidence</p>
            <ul v-if="detail.capabilities.length" class="ac-agent-list">
              <li v-for="capability in detail.capabilities" :key="capability.pack">
                <strong>{{ capability.pack }}</strong>
                <span>{{ capabilityLabels[capability.status] ?? capability.status }}</span>
                <span v-if="capability.lastVerifiedAt">
                  最近验证 {{ dateTime.format(new Date(capability.lastVerifiedAt)) }}
                </span>
                <span v-if="capability.failureCount">失败记录 {{ capability.failureCount }} 次</span>
                <span v-if="!capability.available" class="ac-agent-list__warning">
                  {{ capability.availabilityReasons.join("；") || "当前不可用" }}
                </span>
              </li>
            </ul>
            <p v-else class="ac-agent-empty">还没有能力证据记录。</p>
          </section>

          <section class="ac-detail-panel ac-agent-panel" aria-label="工作历史">
            <p class="ac-card-kicker">Delivery history</p>
            <ul v-if="detail.performances.length" class="ac-agent-list">
              <li v-for="performance in detail.performances" :key="`${performance.projectID}-${performance.timeCreated}`">
                <strong>{{ performance.projectID }}</strong>
                <span>{{ outcomeLabels[performance.outcome] ?? performance.outcome }}</span>
                <span>质量 {{ performance.qualityScore }} · 可靠性 {{ performance.reliabilityScore }}</span>
                <span>{{ performance.reviewSummary }}</span>
              </li>
            </ul>
            <p v-else class="ac-agent-empty">还没有已记录的交付表现。</p>
          </section>

          <section class="ac-detail-panel ac-agent-panel" aria-label="选择历史">
            <p class="ac-card-kicker">Selection history</p>
            <ul v-if="detail.selections.length" class="ac-agent-list">
              <li v-for="(selection, index) in detail.selections" :key="`${selection.projectID}-${index}`">
                <strong>{{ selection.projectID }}</strong>
                <span>{{ selection.decision === "selected" ? "入选" : "未入选" }}{{
                  selection.released ? "（已释放）" : "" }}</span>
                <span>{{ selection.reason }}</span>
              </li>
            </ul>
            <p v-else class="ac-agent-empty">还没有团队选择记录。</p>
          </section>

          <section v-if="detail.employmentReviews.length" class="ac-detail-panel ac-agent-panel" aria-label="雇佣审计">
            <p class="ac-card-kicker">Employment review</p>
            <ul class="ac-agent-list">
              <li v-for="(review, index) in detail.employmentReviews" :key="index">
                <strong>{{ review.status }}</strong>
                <span>{{ review.rationale }}</span>
                <span v-if="review.timeDecided">决定于 {{ dateTime.format(new Date(review.timeDecided)) }}</span>
              </li>
            </ul>
          </section>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
