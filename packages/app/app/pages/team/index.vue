<script setup lang="ts">
const appConfig = useAppConfig();
const { data: snapshot, pending, refresh } = useCompanySnapshot();
const available = computed(() => ["ready", "degraded"].includes(snapshot.value.connection));
const agentsUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("agents") ?? false);
const workUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("work") ?? false);
const unavailableWorkCount = computed(() =>
  snapshot.value.work.filter(work => work.availability === "unavailable").length);
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
          @retry="refresh()"
        />

        <template v-else-if="snapshot.agents.length">
          <p v-if="workUnavailable || unavailableWorkCount" class="ac-resource-notice">
            成员活动可用，但部分工作关联状态不可用，不会显示为零负载。
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

              <p class="ac-team-evidence">
                <UIcon :name="agent.evidence ? 'i-lucide-badge-check' : 'i-lucide-circle-dashed'" />
                <template v-if="agent.evidence">
                  活动证据更新于 {{ dateTime.format(new Date(agent.evidence.timeUpdated)) }}
                </template>
                <template v-else>当前没有运行证据</template>
              </p>
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
