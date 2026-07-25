<script setup lang="ts">
const appConfig = useAppConfig();
const { data: snapshot, pending, refresh } = useCompanySnapshot();
const available = computed(() => ["ready", "degraded"].includes(snapshot.value.connection));
const workUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("work") ?? false);
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function ownerName(owner?: { id: string; name?: string }) {
  if (!owner) return "尚未分配负责人";
  return owner.name ?? snapshot.value.agents.find(agent => agent.id === owner.id)?.name ?? "负责人已分配";
}
</script>

<template>
  <UDashboardPanel id="work" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page">
        <header class="ac-workspace-header">
          <div>
            <p class="ac-workspace-eyebrow">Active execution</p>
            <h1 class="ac-workspace-title">Work</h1>
            <p class="ac-workspace-lede">
              查看目标、执行过程、失败尝试与当前进展。
            </p>
          </div>
        </header>

        <div
          v-if="!available || workUnavailable"
          key="connection-state"
        >
          <CompanyConnectionState
            :connection="snapshot.connection"
            :issue="snapshot.issue"
            :pending="pending"
            show-settings
            @retry="refresh()"
          />
        </div>

        <section
          v-else-if="snapshot.work.length"
          key="work-list"
          class="ac-card-list"
          aria-label="工作列表"
        >
          <NuxtLink
            v-for="work in snapshot.work"
            :key="work.availability === 'available' ? work.summary.workId : work.workId"
            :to="`/work/${encodeURIComponent(work.availability === 'available' ? work.summary.workId : work.workId)}`"
            class="ac-work-card"
          >
            <template v-if="work.availability === 'available'">
              <div class="ac-card-heading">
                <div>
                  <p class="ac-card-kicker">{{ work.summary.phase }}</p>
                  <h2>{{ work.summary.title }}</h2>
                </div>
                <span class="ac-status-badge" :data-status="work.summary.userStatus">
                  {{ appConfig.experience.statusLabels[work.summary.userStatus] }}
                </span>
              </div>

              <p class="ac-card-reason">{{ work.summary.reason.text }}</p>

              <div class="ac-progress" :aria-label="`${work.progress.completedItems} / ${work.progress.totalItems} 已完成`">
                <span :style="{ width: `${work.progress.percent ?? 0}%` }" />
              </div>

              <div class="ac-card-footer">
                <span>{{ ownerName(work.summary.owner) }}</span>
                <span>
                  {{ work.progress.completedItems }} / {{ work.progress.totalItems }}
                  <template v-if="work.progress.percent !== undefined"> · {{ work.progress.percent }}%</template>
                </span>
                <time :datetime="work.summary.updatedAt">
                  {{ dateTime.format(new Date(work.summary.updatedAt)) }}
                </time>
                <span
                  v-if="work.summary.nextAction"
                  class="ac-card-action"
                  :aria-disabled="!work.summary.nextAction.enabled"
                  :data-disabled="!work.summary.nextAction.enabled"
                >
                  {{ appConfig.experience.actionLabels[work.summary.nextAction.id] }}
                  <small v-if="!work.summary.nextAction.enabled"> · 暂不可用</small>
                  <UIcon name="i-lucide-arrow-right" />
                </span>
              </div>
            </template>

            <template v-else>
              <div class="ac-card-heading">
                <div>
                  <p class="ac-card-kicker">状态诊断</p>
                  <h2>{{ work.title }}</h2>
                </div>
                <span class="ac-status-badge" data-status="unavailable">状态不可用</span>
              </div>
              <p class="ac-card-reason">{{ work.reason.text }}</p>
              <div class="ac-card-footer">
                <span>{{ work.diagnostics.length }} 项诊断</span>
                <time :datetime="work.updatedAt">
                  {{ dateTime.format(new Date(work.updatedAt)) }}
                </time>
                <span class="ac-card-action">
                  查看诊断
                  <UIcon name="i-lucide-arrow-right" />
                </span>
              </div>
            </template>
          </NuxtLink>
        </section>

        <section v-else key="work-empty" class="ac-empty-state">
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon" aria-hidden="true">
              <UIcon name="i-lucide-panels-top-left" />
            </span>
            <h2>还没有可展示的工作</h2>
            <p>新的目标形成真实工作状态后，这里会呈现当前状态、原因与下一步。</p>
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
