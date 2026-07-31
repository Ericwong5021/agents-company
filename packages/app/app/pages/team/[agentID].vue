<script setup lang="ts">
import type { CompanyAgentDetail } from "../../../modules/agent-company/runtime/shared/company-contract";
import { selectionEvidenceLabel } from "../../../modules/agent-company/runtime/shared/seed-grow-view";

const appConfig = useAppConfig();
const route = useRoute();
const agentID = computed(() => Array.isArray(route.params.agentID)
  ? route.params.agentID[0]
  : route.params.agentID);
const projectID = computed(() => {
  const value = route.query.project
  return Array.isArray(value) ? value[0] : value
})
const { data: snapshot } = useCompanySnapshot()
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
const performances = computed(() =>
  projectID.value
    ? detail.value?.performances.filter((performance) => performance.projectID === projectID.value) ?? []
    : detail.value?.performances ?? [],
)
const selections = computed(() =>
  projectID.value
    ? detail.value?.selections.filter((selection) => selection.projectID === projectID.value) ?? []
    : detail.value?.selections ?? [],
)
const isProjectOwner = computed(() =>
  Boolean(
    projectID.value &&
    snapshot.value.work.some(
      (work) =>
        work.availability === "available" &&
        work.summary.workId === projectID.value &&
        work.summary.owner?.id === agentID.value,
    ),
  ),
)

function shortWorkID(value: string) {
  return value.slice(-8)
}

function capabilityLabel(value: string) {
  const normalized = value.split("@")[0] ?? value
  if (normalized.includes("charter") || normalized.includes("planner")) return "目标拆解与项目规划"
  if (normalized.includes("safety")) return "安全流程设计"
  if (normalized.includes("evidence")) return "证据框架整理"
  if (normalized.includes("review")) return "独立复核"
  return "项目执行能力"
}

function roleLabel(value?: string | null) {
  const role = value ?? ""
  const known = {
    ceo: "首席执行官",
    cto: "技术负责人",
    product_lead: "产品负责人",
    CEO: "首席执行官",
    CTO: "技术负责人",
    "Product Lead": "产品负责人",
    "project-planner": "项目规划负责人",
  } as Record<string, string>
  return (known[role] ?? role)
    .replace(/\s+independent reviewer\b/gi, "（独立复核）")
    .replace(/\bProject Charter\b/g, "项目章程")
    .replace(/\bCharter\b/g, "工作章程")
    || "团队成员"
}

function selectionReasonLabel(value: string) {
  return selectionEvidenceLabel(roleLabel(value)).replace(
    /Agent conflicts with the persisted independence boundary\.?/gi,
    "候选成员与已保存的独立性边界冲突。",
  )
}
</script>

<template>
  <UDashboardPanel id="team-agent" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page ac-workspace-page--narrow">
        <NuxtLink
          :to="projectID ? `/team?project=${encodeURIComponent(projectID)}` : '/team'"
          class="ac-back-link"
        >
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
                {{ detail.agent.employment === "employee" ? "正式员工" : projectID ? "本工作临时角色" : "公司临时角色" }}
              </p>
              <h1 class="ac-workspace-title">{{ roleLabel(detail.agent.name) }}</h1>
              <p class="ac-workspace-lede">
                {{ roleLabel(detail.agent.role) }} ·
                {{ projectID ? "仅显示当前工作的责任与记录" : `公司范围活动：${appConfig.experience.activityLabels[detail.agent.activity]}` }}
              </p>
              <p v-if="isProjectOwner" class="ac-workspace-lede">
                本工作负责人身份来自已确认的目标摘要；它与具体执行任务的候选入选记录相互独立。
              </p>
            </div>
          </header>

          <section class="ac-detail-panel ac-agent-panel" aria-label="能力证据">
            <p class="ac-card-kicker">能力证据</p>
            <ul v-if="detail.capabilities.length" class="ac-agent-list">
              <li v-for="capability in detail.capabilities" :key="capability.pack">
                <strong>{{ capabilityLabel(capability.pack) }}</strong>
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
            <p v-else class="ac-agent-empty">
              还没有能力证据记录。<template v-if="isProjectOwner">负责人身份不表示具体执行能力已通过验证。</template>
            </p>
          </section>

          <section class="ac-detail-panel ac-agent-panel" aria-label="工作历史">
            <p class="ac-card-kicker">交付历史</p>
            <ul v-if="performances.length" class="ac-agent-list">
              <li v-for="(performance, index) in performances" :key="`${performance.projectID}-${performance.timeCreated}`">
                <strong>工作记录 {{ index + 1 }}</strong>
                <span>{{ outcomeLabels[performance.outcome] ?? performance.outcome }}</span>
                <span>质量 {{ performance.qualityScore }} · 可靠性 {{ performance.reliabilityScore }}</span>
                <span>{{ performance.reviewSummary }}</span>
                <details class="ac-source-trace">
                  <summary>查看内部追踪信息</summary>
                  <span>工作 #{{ shortWorkID(performance.projectID) }}</span>
                </details>
              </li>
            </ul>
            <p v-else class="ac-agent-empty">还没有已记录的交付表现。</p>
          </section>

          <section class="ac-detail-panel ac-agent-panel" aria-label="执行任务候选记录">
            <p class="ac-card-kicker">执行任务候选记录</p>
            <p v-if="isProjectOwner" class="ac-agent-empty">
              以下记录只说明该成员是否适合某个具体执行任务，不改变其项目负责人责任。
            </p>
            <ul v-if="selections.length" class="ac-agent-list">
              <li v-for="(selection, index) in selections" :key="`${selection.projectID}-${index}`">
                <strong>候选记录 {{ index + 1 }}</strong>
                <span>{{ selection.decision === "selected" ? "入选" : "未入选" }}{{
                  selection.released ? "（已释放）" : "" }}</span>
                <span>{{ selectionReasonLabel(selection.reason) }}</span>
                <details class="ac-source-trace">
                  <summary>查看内部追踪信息</summary>
                  <span>工作 #{{ shortWorkID(selection.projectID) }}</span>
                </details>
              </li>
            </ul>
            <p v-else class="ac-agent-empty">还没有团队选择记录。</p>
          </section>

          <section v-if="detail.employmentReviews.length" class="ac-detail-panel ac-agent-panel" aria-label="雇佣审计">
            <p class="ac-card-kicker">雇佣复核</p>
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
