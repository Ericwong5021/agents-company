<script setup lang="ts">
import type { OrganizationProjection } from "@agents-company/shared/experience";
import {
  assignmentStatusLabels,
  availableAssignments,
  assignmentsForAgent,
  sourceRefLabel,
} from "../../../modules/agent-company/runtime/shared/seed-grow-view";

const appConfig = useAppConfig();
const { data: snapshot, pending, refresh } = useCompanySnapshot();
const {
  data: organizationResult,
  status: organizationStatus,
  error: organizationError,
  refresh: refreshOrganization,
} = useFetch<OrganizationProjection[]>("/api/agent-company/experience/organization", {
  default: () => [],
});
const available = computed(() => ["ready", "degraded"].includes(snapshot.value.connection));
const agentsUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("agents") ?? false);
const workUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("work") ?? false);
const unavailableWorkCount = computed(() =>
  snapshot.value.work.filter(work => work.availability === "unavailable").length);
const assignments = computed(() => organizationResult.value.flatMap(availableAssignments));
const projectedAssignments = computed(() =>
  assignments.value.filter(assignment =>
    snapshot.value.agents.every(agent => agent.id !== assignment.agent.id)));
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function ownedWork(agentID: string) {
  return snapshot.value.work
    .filter(work => work.availability === "available")
    .filter(work => work.summary.owner?.id === agentID);
}

function agentAssignments(agentID: string) {
  return assignmentsForAgent(organizationResult.value, agentID);
}

async function retry() {
  await Promise.all([refresh(), refreshOrganization()]);
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
            <p class="ac-workspace-eyebrow">People and responsibility</p>
            <h1 class="ac-workspace-title">Team</h1>
            <p class="ac-workspace-lede">
              查看团队责任、当前负载与由真实活动形成的工作证据。
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

        <template v-else-if="snapshot.agents.length || projectedAssignments.length">
          <p v-if="workUnavailable || unavailableWorkCount" class="ac-resource-notice">
            成员活动可用，但部分工作关联状态不可用，不会显示为零负载。
          </p>
          <p v-if="organizationStatus === 'pending'" class="ac-resource-notice" role="status">
            正在读取 Assignment 责任证据…
          </p>
          <p v-else-if="organizationError" class="ac-resource-notice" role="alert">
            Assignment 责任证据暂时不可用，不会显示为零分配。
          </p>

          <section class="ac-team-grid" aria-label="团队成员">
            <article v-for="agent in snapshot.agents" :key="agent.id" class="ac-team-card">
              <div class="ac-team-card__top">
                <span class="ac-team-avatar" aria-hidden="true">{{ agent.name.slice(0, 1) }}</span>
                <span class="ac-activity-badge" :data-attention="agent.attention">
                  {{ appConfig.experience.activityLabels[agent.activity] }}
                </span>
              </div>

              <h2>{{ agent.name }}</h2>
              <p class="ac-team-role">{{ agent.role ?? "团队成员" }}</p>
              <p v-if="agent.subject" class="ac-team-subject">{{ agent.subject }}</p>
              <p v-if="agent.risk" class="ac-team-risk">{{ agent.risk }}</p>

              <dl class="ac-team-facts">
                <div>
                  <dt>责任范围</dt>
                  <dd>{{ agent.department ?? "未归属部门" }}</dd>
                </div>
                <div>
                  <dt>可打断性</dt>
                  <dd>{{ appConfig.experience.interruptibilityLabels[agent.interruptibility] }}</dd>
                </div>
                <div>
                  <dt>运行上下文</dt>
                  <dd>{{ agent.location ?? "当前没有运行上下文证据" }}</dd>
                </div>
              </dl>

              <div class="ac-team-work">
                <p class="ac-card-kicker">Current responsibility</p>
                <template v-if="!workUnavailable && ownedWork(agent.id).length">
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
                <p class="ac-card-kicker">Assignment evidence</p>
                <article
                  v-for="assignment in agentAssignments(agent.id)"
                  :key="assignment.assignmentId"
                >
                  <div class="ac-team-assignments__heading">
                    <NuxtLink :to="`/work/${encodeURIComponent(assignment.projectId)}`">
                      {{ assignment.temporaryRole }}
                    </NuxtLink>
                    <span class="ac-status-badge" :data-status="assignment.status">
                      {{ assignmentStatusLabels[assignment.status] }}
                    </span>
                  </div>
                  <p>{{ assignment.responsibility }}</p>
                  <dl>
                    <div>
                      <dt>加入原因</dt>
                      <dd>{{ assignment.selectionReason }}</dd>
                    </div>
                    <div>
                      <dt>能力需求</dt>
                      <dd>{{ assignment.need.role }}</dd>
                    </div>
                    <div>
                      <dt>身份</dt>
                      <dd>{{ assignment.lifecycleAtSelection === "employee" ? "正式员工" : "项目临时角色" }}</dd>
                    </div>
                    <div v-if="assignment.releasedAt">
                      <dt>释放</dt>
                      <dd>{{ assignment.releaseReason ?? "项目责任已结束" }}</dd>
                    </div>
                  </dl>
                  <details class="ac-source-trace">
                    <summary>查看选择事实</summary>
                    <ul>
                      <li v-for="source in assignment.sourceRefs" :key="`${source.kind}:${source.id}`">
                        {{ sourceRefLabel(source) }}
                      </li>
                    </ul>
                  </details>
                </article>
              </div>

              <p class="ac-team-evidence">
                <UIcon :name="agent.evidence ? 'i-lucide-badge-check' : 'i-lucide-circle-dashed'" />
                <template v-if="agent.evidence">
                  活动证据更新于 {{ dateTime.format(new Date(agent.evidence.timeUpdated)) }}
                </template>
                <template v-else>当前没有运行证据</template>
              </p>
            </article>

            <article
              v-for="assignment in projectedAssignments"
              :key="assignment.assignmentId"
              class="ac-team-card"
            >
              <div class="ac-team-card__top">
                <span class="ac-team-avatar" aria-hidden="true">
                  {{ (assignment.agent.name ?? assignment.agent.id).slice(0, 1) }}
                </span>
                <span class="ac-activity-badge" data-attention="false">项目中</span>
              </div>

              <h2>{{ assignment.agent.name ?? assignment.agent.id }}</h2>
              <p class="ac-team-role">{{ assignment.temporaryRole }}</p>
              <p class="ac-team-subject">{{ assignment.responsibility }}</p>

              <dl class="ac-team-facts">
                <div>
                  <dt>成员身份</dt>
                  <dd>{{ assignment.currentLifecycle === "employee" ? "正式员工" : "项目临时成员" }}</dd>
                </div>
                <div>
                  <dt>能力需求</dt>
                  <dd>{{ assignment.need.role }}</dd>
                </div>
                <div>
                  <dt>权限模式</dt>
                  <dd>{{ assignment.permissionMode }}</dd>
                </div>
              </dl>

              <div class="ac-team-assignments">
                <p class="ac-card-kicker">Assignment evidence</p>
                <article>
                  <div class="ac-team-assignments__heading">
                    <NuxtLink :to="`/work/${encodeURIComponent(assignment.projectId)}`">
                      {{ assignment.temporaryRole }}
                    </NuxtLink>
                    <span class="ac-status-badge" :data-status="assignment.status">
                      {{ assignmentStatusLabels[assignment.status] }}
                    </span>
                  </div>
                  <p>{{ assignment.responsibility }}</p>
                  <dl>
                    <div>
                      <dt>加入原因</dt>
                      <dd>{{ assignment.selectionReason }}</dd>
                    </div>
                    <div>
                      <dt>能力需求</dt>
                      <dd>{{ assignment.need.role }}</dd>
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
                        {{ sourceRefLabel(source) }}
                      </li>
                    </ul>
                  </details>
                </article>
              </div>
            </article>
          </section>
        </template>

        <section v-else class="ac-empty-state">
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon" aria-hidden="true">
              <UIcon name="i-lucide-users-round" />
            </span>
            <h2>还没有可见团队成员</h2>
            <p>这是来自本地运行时的真实空结果，成员出现后会展示责任与活动证据。</p>
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
