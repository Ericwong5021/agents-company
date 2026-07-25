<script setup lang="ts">
const appConfig = useAppConfig();
const { data: snapshot, pending, refresh } = useCompanySnapshot();
const available = computed(() => ["ready", "degraded"].includes(snapshot.value.connection));
const workUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("work") ?? false);
const unavailableWork = computed(() => snapshot.value.work.filter(work => work.availability === "unavailable"));
const deliveries = computed(() => snapshot.value.work
  .filter(work => work.availability === "available")
  .flatMap(work => work.delivery
    ? [{
        ...work.delivery,
        workTitle: work.summary.title,
      }]
    : []));
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
});
</script>

<template>
  <UDashboardPanel id="library" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page">
        <header class="ac-workspace-header">
          <div>
            <p class="ac-workspace-eyebrow">Verified output</p>
            <h1 class="ac-workspace-title">Library</h1>
            <p class="ac-workspace-lede">
              保存可追溯的成果、报告与历史版本。
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
          v-else-if="deliveries.length || unavailableWork.length"
          key="library-list"
          class="ac-card-list"
          aria-label="交付成果"
        >
          <NuxtLink
            v-for="work in unavailableWork"
            :key="work.workId"
            :to="`/work/${encodeURIComponent(work.workId)}`"
            class="ac-library-card"
          >
            <div class="ac-card-heading">
              <div>
                <p class="ac-card-kicker">成果状态待确认</p>
                <h2>{{ work.title }}</h2>
              </div>
              <span class="ac-status-badge" data-status="unavailable">状态不可用</span>
            </div>
            <p class="ac-card-reason">{{ work.reason.text }}</p>
            <div class="ac-card-footer">
              <span>{{ work.diagnostics.length }} 项诊断</span>
              <span class="ac-card-action">
                查看诊断
                <UIcon name="i-lucide-arrow-right" />
              </span>
            </div>
          </NuxtLink>

          <NuxtLink
            v-for="delivery in deliveries"
            :key="delivery.id"
            :to="`/work/${encodeURIComponent(delivery.workId)}`"
            class="ac-library-card"
          >
            <div class="ac-card-heading">
              <div>
                <p class="ac-card-kicker">版本 {{ delivery.version }}</p>
                <h2>{{ delivery.workTitle }}</h2>
              </div>
              <time :datetime="delivery.updatedAt">{{ dateTime.format(new Date(delivery.updatedAt)) }}</time>
            </div>
            <p class="ac-card-reason">{{ delivery.reason.text }}</p>
            <div class="ac-card-footer">
              <span>{{ delivery.artifacts.length }} 项成果</span>
              <span
                v-if="delivery.nextAction"
                class="ac-card-action"
                :aria-disabled="!delivery.nextAction.enabled"
                :data-disabled="!delivery.nextAction.enabled"
              >
                {{ appConfig.experience.actionLabels[delivery.nextAction.id] }}
                <small v-if="!delivery.nextAction.enabled"> · 暂不可用</small>
                <UIcon name="i-lucide-arrow-right" />
              </span>
            </div>
          </NuxtLink>
        </section>

        <section v-else key="library-empty" class="ac-empty-state">
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon" aria-hidden="true">
              <UIcon name="i-lucide-library" />
            </span>
            <h2>还没有归档成果</h2>
            <p>工作形成可验证交付后，会在这里保留版本、来源和下一步。</p>
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
