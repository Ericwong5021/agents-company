<script setup lang="ts">
import { computed } from "vue"
import { useCompanySnapshot } from "../../composables/useCompanySnapshot"

const { data: snapshot, pending, refresh } = useCompanySnapshot()
const companyAvailable = computed(() => ["ready", "degraded"].includes(snapshot.value.connection))
const connectionLabel = computed(() => {
  if (snapshot.value.connection === "ready") return "本地运行服务已连接"
  if (snapshot.value.connection === "degraded") return "部分数据不可用"
  if (snapshot.value.connection === "recovering") return "正在重新连接"
  if (snapshot.value.connection === "connecting") return "正在连接"
  return "本地运行服务未连接"
})
</script>

<template>
  <UDashboardPanel id="agent-company-overview" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar>
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-refresh-cw"
          aria-label="Refresh company"
          :loading="pending"
          @click="refresh()"
        />
      </Navbar>
    </template>

    <template #body>
      <div class="company-page">
        <header class="company-page__header">
          <div>
            <p class="company-eyebrow">Local AI team</p>
            <h1>{{ snapshot.company.name }}</h1>
            <p class="company-page__lede">
              把目标交给本地 AI 团队，跟进真实进展，并验收可直接使用的成果。
            </p>
          </div>
          <span class="company-connection" :data-state="snapshot.connection">
            {{ connectionLabel }}
          </span>
        </header>

        <CompanyModuleNav />

        <CompanyConnectionState
          v-if="!companyAvailable"
          :connection="snapshot.connection"
          :issue="snapshot.issue"
          :pending="pending"
          show-settings
          @retry="refresh()"
        />

        <template v-else>
          <p v-if="snapshot.notice" class="company-notice">{{ snapshot.notice }}</p>

          <section class="company-stat-grid" aria-label="Company status">
            <article class="company-stat">
              <span>Online employees</span>
              <strong>{{ snapshot.stats.online }}</strong>
            </article>
            <article class="company-stat">
              <span>Active projects</span>
              <strong>{{ snapshot.stats.activeProjects }}</strong>
            </article>
            <article class="company-stat">
              <span>Board messages</span>
              <strong>{{ snapshot.stats.boardMessages }}</strong>
            </article>
          </section>

          <div class="company-overview-grid">
            <section class="company-section">
              <div class="company-section__heading">
                <div>
                  <p class="company-eyebrow">Current work</p>
                  <h2>Company projects</h2>
                </div>
                <NuxtLink to="/company/board" class="company-text-link">Open board</NuxtLink>
              </div>
              <div class="company-list">
                <NuxtLink
                  v-for="project in snapshot.projects"
                  :key="project.id"
                  :to="`/company/projects/${encodeURIComponent(project.id)}`"
                  class="company-project"
                >
                  <div>
                    <strong>{{ project.title }}</strong>
                    <span>{{ project.status }}</span>
                  </div>
                  <div class="company-progress" :aria-label="`${project.progress}% complete`">
                    <span :style="{ width: `${project.progress}%` }" />
                  </div>
                </NuxtLink>
                <p v-if="!snapshot.projects.length" class="company-empty">No active projects.</p>
              </div>
            </section>

            <section class="company-section">
              <div class="company-section__heading">
                <div>
                  <p class="company-eyebrow">Runtime</p>
                  <h2>Operating contract</h2>
                </div>
              </div>
              <dl class="company-definition-list">
                <div>
                  <dt>Provider</dt>
                  <dd>{{ snapshot.company.provider }}</dd>
                </div>
                <div>
                  <dt>Approval policy</dt>
                  <dd>{{ snapshot.company.approvalPolicy }}</dd>
                </div>
              </dl>
            </section>
          </div>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
