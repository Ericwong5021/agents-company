<script setup lang="ts">
import type { OrganizationProjection } from "@agents-company/shared/experience"
import {
  assignmentStatusLabels,
  availableAssignments,
  permissionModeLabels,
  selectionEvidenceLabel,
  sourceRefTypeLabel,
} from "../../../modules/agent-company/runtime/shared/seed-grow-view"

const appConfig = useAppConfig()
const route = useRoute()
const { data: snapshot, pending, refresh } = useCompanySnapshot()
const {
  data: organizationResult,
  status: organizationStatus,
  error: organizationError,
  refresh: refreshOrganization,
} = useFetch<OrganizationProjection[]>("/api/agent-company/experience/organization", {
  default: () => [],
})
const available = computed(() => ["ready", "degraded"].includes(snapshot.value.connection))
const agentsUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("agents") ?? false)
const assignments = computed(() => organizationResult.value.flatMap(availableAssignments))
const primaryWorkID = computed(() => {
  const scoped = typeof route.query.project === "string" ? route.query.project : ""
  if (
    scoped &&
    snapshot.value.work.some(
      (work) => (work.availability === "available" ? work.summary.workId : work.workId) === scoped,
    )
  )
    return scoped
  const work = snapshot.value.work[0]
  if (!work) return ""
  return work.availability === "available" ? work.summary.workId : work.workId
})
const primaryWork = computed(() => snapshot.value.work.find((work) =>
  (work.availability === "available" ? work.summary.workId : work.workId) === primaryWorkID.value))
const primaryWorkTitle = computed(() =>
  primaryWork.value?.availability === "available" ? primaryWork.value.summary.title : primaryWork.value?.title)
const workUnavailable = computed(() =>
  Boolean(primaryWork.value && primaryWork.value.availability === "unavailable"))
const unavailableWorkCount = computed(() => workUnavailable.value ? 1 : 0)
const unavailableOrganizationCount = computed(() =>
  organizationResult.value.some(
    (organization) =>
      organization.projectId === primaryWorkID.value && organization.availability === "unavailable",
  ) ? 1 : 0)
const currentAssignments = computed(() =>
  assignments.value.filter((assignment) => assignment.projectId === primaryWorkID.value))
const historicalAssignments = computed(() =>
  assignments.value.filter((assignment) => assignment.projectId !== primaryWorkID.value))
const projectedAssignments = computed(() =>
  currentAssignments.value.filter(
    (assignment) => snapshot.value.agents.every((agent) => agent.id !== assignment.agent.id),
  ),
)
const currentAgentIDs = computed(() => {
  const ids = new Set(currentAssignments.value.map((assignment) => assignment.agent.id))
  if (primaryWork.value?.availability === "available" && primaryWork.value.summary.owner?.id)
    ids.add(primaryWork.value.summary.owner.id)
  return ids
})
const employees = computed(() =>
  snapshot.value.agents.filter(
    (agent) => agent.employment === "employee" && currentAgentIDs.value.has(agent.id),
  ))
const allTemporaries = computed(() => snapshot.value.agents.filter((agent) => agent.employment === "temporary"))
const currentTemporaryAgentIDs = computed(() =>
  new Set(currentAssignments.value.map((assignment) => assignment.agent.id)))
const temporaries = computed(() =>
  allTemporaries.value.filter((agent) => currentTemporaryAgentIDs.value.has(agent.id)))
const historicalTemporaries = computed(() =>
  allTemporaries.value.filter((agent) => !currentTemporaryAgentIDs.value.has(agent.id)))
const historicalProjectedAssignments = computed(() =>
  historicalAssignments.value.filter(
    (assignment) => snapshot.value.agents.every((agent) => agent.id !== assignment.agent.id),
  ))
const primaryWorkTerminal = computed(() =>
  primaryWork.value?.availability === "available"
  && ["accepted", "failed", "cancelled"].includes(primaryWork.value.summary.userStatus))
const primaryWorkAwaitingAcceptance = computed(() =>
  primaryWork.value?.availability === "available"
  && Boolean(primaryWork.value.delivery)
  && primaryWork.value.summary.userStatus !== "accepted")
const primaryWorkBlocked = computed(() =>
  primaryWork.value?.availability === "available"
  && primaryWork.value.summary.userStatus === "blocked")

function ownedWork(agentID: string) {
  return snapshot.value.work
    .filter((work) => work.availability === "available")
    .filter((work) => work.summary.workId === primaryWorkID.value && work.summary.owner?.id === agentID)
}

function agentAssignments(agentID: string) {
  return currentAssignments.value.filter((assignment) => assignment.agent.id === agentID)
}

function currentResponsibilitySummary(agentID: string) {
  const rows = agentAssignments(agentID)
  const active = rows.filter((assignment) => ["assigned", "active"].includes(assignment.status)).length
  const released = rows.filter((assignment) => assignment.status === "released").length
  if (primaryWorkTerminal.value)
    return rows.length ? `本工作已结束 · ${rows.length} 项责任记录` : "本工作已结束"
  if (primaryWorkAwaitingAcceptance.value)
    return rows.length ? `执行已结束 · 等待你验收 · ${rows.length} 项责任记录` : "执行已结束 · 等待你验收"
  if (primaryWorkBlocked.value) {
    if (active && released) return `工作受阻 · ${active} 项责任待恢复 · ${released} 项执行分配已结束`
    if (active) return `工作受阻 · ${active} 项责任待恢复`
    if (released) return `工作受阻 · ${released} 项执行分配已结束`
    return "工作受阻 · 当前没有待恢复责任"
  }
  if (active && released) return `${active} 项进行中 · ${released} 项执行分配已结束`
  if (active) return `${active} 项进行中`
  if (released) return `${released} 项执行分配已结束`
  if (ownedWork(agentID).length) return "本工作负责人"
  return "当前工作未记录责任"
}

function assignmentStatusLabel(status: keyof typeof assignmentStatusLabels) {
  if (primaryWorkBlocked.value && ["assigned", "active"].includes(status)) return "责任待恢复"
  if (primaryWorkAwaitingAcceptance.value && status === "released") return "执行已结束 · 待验收"
  return assignmentStatusLabels[status]
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
  return (known[role] ?? role ?? "团队成员")
    .replace(/\s+independent reviewer\b/gi, "（独立复核）")
    .replace(/本次闭环的董事会决策记录人/g, "项目规划负责人")
    .replace(/跨项目候选证据分析执行人/g, "方案分析负责人")
    .replace(/执行角色/g, "负责人")
    .replace(/执行人/g, "负责人")
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

function releaseReasonLabel(value?: string | null) {
  if (!value || value === "project_terminal") return "工作已结束"
  return value
}

async function retry() {
  await Promise.all([refresh(), refreshOrganization()])
}
</script>

<template>
  <UDashboardPanel id="team" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page">
        <header class="ac-workspace-header">
          <div>
            <p class="ac-workspace-eyebrow">团队与责任</p>
            <h1 class="ac-workspace-title">团队</h1>
            <p class="ac-workspace-lede">
              查看{{ primaryWorkTitle ? `“${primaryWorkTitle}”` : "当前工作" }}的责任分配与当前状态证据。
              <template v-if="primaryWorkID">工作 #{{ primaryWorkID.slice(-8) }}</template>
            </p>
          </div>
        </header>

        <CompanyConnectionState
          v-if="!available || agentsUnavailable"
          :connection="snapshot.connection"
          :issue="snapshot.issue"
          :pending="pending"
          show-settings
          @retry="retry()"
        />

        <p
          v-else-if="organizationStatus === 'pending' && !organizationResult.length && !snapshot.agents.length"
          class="ac-resource-notice"
          role="status"
        >
          正在读取责任分配证据…
        </p>
        <div v-else-if="organizationError && !snapshot.agents.length" class="ac-empty-state" role="alert">
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon" aria-hidden="true">
              <UIcon name="i-lucide-triangle-alert" />
            </span>
            <h2>团队责任证据暂时不可用</h2>
            <p>页面不会把读取失败显示为零成员或零分配。</p>
            <UButton class="ac-empty-state__action" color="neutral" @click="retry()">重新读取</UButton>
          </div>
        </div>

        <template v-else-if="employees.length || temporaries.length || projectedAssignments.length">
          <p v-if="organizationError" class="ac-resource-notice" role="alert">
            责任分配证据暂时不可用，已保留可验证的成员活动信息。
          </p>
          <p v-if="workUnavailable || unavailableWorkCount" class="ac-resource-notice">
            成员活动可用，但当前工作关联状态不可用，不会显示为零负载。
          </p>
          <p v-if="unavailableOrganizationCount" class="ac-resource-notice" role="alert">
            当前工作的责任分配投影不可用，不会显示为零分配。
          </p>

          <template
            v-for="group in [
              { key: 'employees', title: '正式员工', members: employees },
              { key: 'temporaries', title: '本工作临时角色', members: temporaries },
            ]"
            :key="group.key"
          >
            <section v-if="group.members.length" class="ac-team-section" :aria-label="group.title">
              <h2 class="ac-team-section__title">
                {{ group.title }}
                <span class="ac-team-section__count">{{ group.members.length }}</span>
              </h2>
              <div class="ac-team-grid">
                <article v-for="agent in group.members" :key="agent.id" class="ac-team-card">
                  <div class="ac-team-card__top">
                    <span class="ac-team-avatar" aria-hidden="true">{{ agent.name.slice(0, 1) }}</span>
                    <span class="ac-team-badges">
                      <span class="ac-team-employment" :data-employment="agent.employment">
                        {{ agent.employment === "employee" ? "正式员工" : "临时角色" }}
                      </span>
                      <span class="ac-activity-badge" :data-attention="false">
                        {{ currentResponsibilitySummary(agent.id) }}
                      </span>
                    </span>
                  </div>

                  <h2>
                    <NuxtLink
                      :to="`/team/${encodeURIComponent(agent.id)}?project=${encodeURIComponent(primaryWorkID)}`"
                      class="ac-team-card__link"
                    >
                      {{ roleLabel(agent.name) }}
                    </NuxtLink>
                  </h2>
                  <p class="ac-team-role">{{ roleLabel(agent.role) }}</p>

                  <dl class="ac-team-facts">
                    <div>
                      <dt>责任范围</dt>
                      <dd>{{ agent.department ?? "未归属部门" }}</dd>
                    </div>
                    <div>
                      <dt>本工作责任</dt>
                      <dd v-if="workUnavailable || unavailableWorkCount">未知 · 工作关联不完整</dd>
                      <dd v-else>{{ currentResponsibilitySummary(agent.id) }}</dd>
                    </div>
                    <div>
                      <dt>可打断性</dt>
                      <dd>
                        {{
                          primaryWorkTerminal
                            ? "工作已结束，无需介入"
                            : primaryWorkAwaitingAcceptance
                              ? "执行已结束，等待你验收"
                            : appConfig.experience.interruptibilityLabels[agent.interruptibility]
                        }}
                      </dd>
                    </div>
                    <div>
                      <dt>当前工作</dt>
                      <dd>{{ primaryWorkTerminal ? "已结束" : primaryWorkAwaitingAcceptance ? "执行已结束，等待你验收" : primaryWorkBlocked ? "工作受阻，等待恢复" : "执行状态以工作页为准" }}</dd>
                    </div>
                  </dl>

                  <div class="ac-team-work">
                    <p class="ac-card-kicker">当前责任</p>
                    <p v-if="!workUnavailable && agentAssignments(agent.id).length">
                      {{ currentResponsibilitySummary(agent.id) }}
                    </p>
                    <template v-else-if="!workUnavailable && ownedWork(agent.id).length">
                      <NuxtLink
                        v-for="work in ownedWork(agent.id)"
                        :key="work.summary.workId"
                        :to="`/work/${encodeURIComponent(work.summary.workId)}`"
                      >
                        {{ work.summary.title }}
                      </NuxtLink>
                    </template>
                    <p v-else-if="workUnavailable || unavailableWorkCount">工作关联不完整</p>
                    <p v-else>当前未分配可见工作</p>
                  </div>

                  <div v-if="agentAssignments(agent.id).length" class="ac-team-assignments">
                    <p class="ac-card-kicker">责任分配证据</p>
                    <article v-for="assignment in agentAssignments(agent.id)" :key="assignment.assignmentId">
                      <div class="ac-team-assignments__heading">
                        <NuxtLink :to="`/work/${encodeURIComponent(assignment.projectId)}`">
                          {{ roleLabel(assignment.temporaryRole) }}
                        </NuxtLink>
                        <span class="ac-status-badge" :data-status="assignment.status">
                          {{ assignmentStatusLabel(assignment.status) }}
                        </span>
                      </div>
                      <p>{{ assignment.responsibility }}</p>
                      <dl>
                        <div>
                          <dt>加入原因</dt>
                          <dd>{{ selectionReasonLabel(assignment.selectionReason) }}</dd>
                        </div>
                        <div>
                          <dt>能力需求</dt>
                          <dd>{{ roleLabel(assignment.need.role) }}</dd>
                        </div>
                        <div>
                          <dt>身份</dt>
                          <dd>{{ assignment.lifecycleAtSelection === "employee" ? "正式员工" : "项目临时角色" }}</dd>
                        </div>
                        <div v-if="assignment.releasedAt">
                          <dt>释放</dt>
                          <dd>{{ releaseReasonLabel(assignment.releaseReason) }}</dd>
                        </div>
                      </dl>
                      <details class="ac-source-trace">
                        <summary>查看选择事实</summary>
                        <ul>
                          <li v-for="source in assignment.sourceRefs" :key="`${source.kind}:${source.id}`">
                            {{ sourceRefTypeLabel(source) }}
                          </li>
                        </ul>
                      </details>
                    </article>
                  </div>

                  <p class="ac-team-evidence">
                    <UIcon name="i-lucide-shield-check" />
                    仅显示此工作的责任与分配记录。
                  </p>
                </article>
              </div>
            </section>
          </template>

          <section v-if="projectedAssignments.length" class="ac-team-section" aria-label="当前工作的临时成员">
            <h2 class="ac-team-section__title">
              当前工作的临时成员
              <span class="ac-team-section__count">{{ projectedAssignments.length }}</span>
            </h2>
            <div class="ac-team-grid">
              <article v-for="assignment in projectedAssignments" :key="assignment.assignmentId" class="ac-team-card">
                <div class="ac-team-card__top">
                  <span class="ac-team-avatar" aria-hidden="true">
                    {{ (assignment.agent.name ?? assignment.agent.id).slice(0, 1) }}
                  </span>
                  <span class="ac-activity-badge" data-attention="false">
                    {{ primaryWorkTerminal ? "已结束" : primaryWorkAwaitingAcceptance ? "待你验收" : "项目中" }}
                  </span>
                </div>

                <h2>{{ roleLabel(assignment.agent.name ?? "项目成员") }}</h2>
                <p class="ac-team-role">{{ roleLabel(assignment.temporaryRole) }}</p>
                <p class="ac-team-subject">{{ assignment.responsibility }}</p>

                <dl class="ac-team-facts">
                  <div>
                    <dt>成员身份</dt>
                    <dd>{{ assignment.currentLifecycle === "employee" ? "正式员工" : "项目临时成员" }}</dd>
                  </div>
                  <div>
                    <dt>能力需求</dt>
                    <dd>{{ roleLabel(assignment.need.role) }}</dd>
                  </div>
                  <div>
                    <dt>权限模式</dt>
                    <dd>{{ permissionModeLabels[assignment.permissionMode] }}</dd>
                  </div>
                </dl>

                <div class="ac-team-assignments">
                  <p class="ac-card-kicker">责任分配证据</p>
                  <article>
                    <div class="ac-team-assignments__heading">
                      <NuxtLink :to="`/work/${encodeURIComponent(assignment.projectId)}`">
                        {{ roleLabel(assignment.temporaryRole) }}
                      </NuxtLink>
                      <span class="ac-status-badge" :data-status="assignment.status">
                        {{ assignmentStatusLabel(assignment.status) }}
                      </span>
                    </div>
                    <p>{{ assignment.responsibility }}</p>
                    <dl>
                      <div>
                        <dt>加入原因</dt>
                        <dd>{{ selectionReasonLabel(assignment.selectionReason) }}</dd>
                      </div>
                      <div>
                        <dt>能力需求</dt>
                        <dd>{{ roleLabel(assignment.need.role) }}</dd>
                      </div>
                      <div>
                        <dt>身份</dt>
                        <dd>{{ assignment.lifecycleAtSelection === "employee" ? "正式员工" : "项目临时角色" }}</dd>
                      </div>
                    </dl>
                    <details class="ac-source-trace">
                      <summary>查看选择事实</summary>
                      <ul>
                      <li v-for="source in assignment.sourceRefs" :key="`${source.kind}:${source.id}`">
                        {{ sourceRefTypeLabel(source) }}
                        </li>
                      </ul>
                    </details>
                  </article>
                </div>
              </article>
            </div>
          </section>

          <details
            v-if="historicalTemporaries.length || historicalProjectedAssignments.length"
            class="ac-detail-panel"
          >
            <summary>
              历史工作成员（{{ historicalTemporaries.length + historicalProjectedAssignments.length }}）
            </summary>
            <div class="ac-team-grid">
              <article v-for="agent in historicalTemporaries" :key="agent.id" class="ac-team-card">
                <h2>
                  <NuxtLink :to="`/team/${encodeURIComponent(agent.id)}`" class="ac-team-card__link">
                    {{ roleLabel(agent.name) }}
                  </NuxtLink>
                </h2>
                <p class="ac-team-role">{{ roleLabel(agent.role ?? "历史项目临时成员") }}</p>
                <p class="ac-team-subject">当前工作未分配此成员。</p>
              </article>
              <article
                v-for="assignment in historicalProjectedAssignments"
                :key="assignment.assignmentId"
                class="ac-team-card"
              >
                <h2>{{ roleLabel(assignment.agent.name ?? "项目成员") }}</h2>
                <p class="ac-team-role">{{ roleLabel(assignment.temporaryRole) }}</p>
                <NuxtLink :to="`/work/${encodeURIComponent(assignment.projectId)}`">
                  查看历史工作
                </NuxtLink>
              </article>
            </div>
          </details>
        </template>

        <section v-else-if="!unavailableOrganizationCount" class="ac-empty-state">
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon" aria-hidden="true">
              <UIcon name="i-lucide-users-round" />
            </span>
            <h2>还没有可见团队成员</h2>
            <p>这是来自本地运行时的真实空结果，成员出现后会展示责任与活动证据。</p>
          </div>
        </section>
        <section v-else class="ac-empty-state" role="alert">
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon" aria-hidden="true">
              <UIcon name="i-lucide-triangle-alert" />
            </span>
            <h2>团队投影不可用</h2>
            <p>当前没有可确认的成员与责任分配事实，页面不会把不可用状态显示为真实空结果。</p>
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
