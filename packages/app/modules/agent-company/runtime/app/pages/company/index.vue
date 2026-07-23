<script setup lang="ts">
import { useCompanySnapshot } from "../../composables/useCompanySnapshot"

const { data: snapshot, pending, refresh } = useCompanySnapshot()
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
            <p class="company-eyebrow">Agent Company module</p>
            <h1>{{ snapshot.company.name }}</h1>
            <p class="company-page__lede">
              Local-first company operations, added without changing the Eve template source.
            </p>
          </div>
          <span class="company-connection" :data-state="snapshot.connection">
            {{ snapshot.connection === "live" ? "Live Control Plane" : "Demo data" }}
          </span>
        </header>

        <CompanyModuleNav />

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
              <div>
                <dt>Source boundary</dt>
                <dd>Nuxt module</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
