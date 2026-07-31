<script setup lang="ts">
import { useFetch, useRoute } from "nuxt/app"
import { computed, ref } from "vue"
import type { CompanyProjectDetail } from "../../../../shared/company-contract"

const route = useRoute()
const projectID = computed(() => String(route.params.projectID))
const { data, pending, error, refresh } = useFetch<CompanyProjectDetail>(
  () => `/api/agent-company/projects/${encodeURIComponent(projectID.value)}`,
)
const retrying = ref(false)
const retryError = ref("")

async function retryProject() {
  retrying.value = true
  retryError.value = ""
  try {
    await $fetch(`/api/agent-company/projects/${encodeURIComponent(projectID.value)}/retry`, { method: "POST" })
    await refresh()
  } catch (cause) {
    retryError.value = cause instanceof Error ? cause.message : "Project retry failed"
  } finally {
    retrying.value = false
  }
}

function agentName(agentID?: string) {
  if (!agentID) return "Unassigned"
  return data.value?.recruitment.candidates.find((candidate) => candidate.id === agentID)?.name ?? agentID
}
</script>

<template>
  <UDashboardPanel id="agent-company-project" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar>
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-refresh-cw"
          aria-label="Refresh project"
          :loading="pending"
          @click="refresh()"
        />
      </Navbar>
    </template>

    <template #body>
      <div v-if="data" class="company-page company-project-page">
        <header class="company-page__header">
          <div>
            <p class="company-eyebrow">Project · {{ data.project.status }}</p>
            <h1>{{ data.project.title }}</h1>
            <p class="company-page__lede">{{ data.project.goal }}</p>
          </div>
          <div class="flex items-center gap-3">
            <UButton
              v-if="data.project.status === 'blocked'"
              color="primary"
              :loading="retrying"
              @click="retryProject"
            >
              Retry blocked project
            </UButton>
            <NuxtLink to="/company" class="company-text-link">Back to company</NuxtLink>
          </div>
        </header>
        <p v-if="retryError" class="company-notice">{{ retryError }}</p>

        <section v-if="data.charter" class="company-project-panel">
          <div class="company-section__heading">
            <div>
              <p class="company-eyebrow">Approved contract</p>
              <h2>项目范围与计划</h2>
            </div>
            <span class="company-project-badge">直接负责人 · {{ agentName(data.charter.driAgentID) }}</span>
          </div>
          <p class="company-project-value">{{ data.charter.value }}</p>
          <div class="company-project-contract">
            <div>
              <strong>Deliverables</strong>
              <ul><li v-for="item in data.charter.deliverables" :key="item">{{ item }}</li></ul>
            </div>
            <div>
              <strong>Acceptance</strong>
              <ul><li v-for="item in data.charter.acceptance" :key="item">{{ item }}</li></ul>
            </div>
            <div>
              <strong>Scope</strong>
              <ul><li v-for="item in data.charter.scope" :key="item">{{ item }}</li></ul>
            </div>
            <div>
              <strong>Non-goals</strong>
              <ul><li v-for="item in data.charter.nonGoals" :key="item">{{ item }}</li></ul>
            </div>
          </div>
        </section>

        <section class="company-project-panel">
          <div class="company-section__heading">
            <div>
              <p class="company-eyebrow">Execution</p>
              <h2>工作项</h2>
            </div>
            <span class="company-project-badge">{{ data.workItems.length }} items</span>
          </div>
          <div class="company-work-items">
            <article v-for="item in data.workItems" :key="item.id">
              <div>
                <span>{{ item.kind }} · {{ item.status }}</span>
                <strong>{{ item.title }}</strong>
                <p>Owner: {{ agentName(item.ownerAgentID) }}</p>
              </div>
              <dl>
                <div>
                  <dt>Depends on</dt>
                  <dd>{{ item.dependsOn.length ? item.dependsOn.join(", ") : "Ready" }}</dd>
                </div>
                <div>
                  <dt>Review</dt>
                  <dd>{{ item.reviewStatus }}</dd>
                </div>
                <div>
                  <dt>Attempts</dt>
                  <dd>{{ item.attempt }} / {{ item.maxAttempts }}</dd>
                </div>
              </dl>
              <p v-if="item.error" class="company-work-item__error">{{ item.error }}</p>
            </article>
            <p v-if="!data.workItems.length" class="company-empty">正在准备工作项。</p>
          </div>
        </section>

        <section class="company-project-panel">
          <div class="company-section__heading">
            <div>
              <p class="company-eyebrow">Adaptive organization</p>
              <h2>Team selection</h2>
            </div>
          </div>
          <div class="company-team-decisions">
            <article v-for="selection in data.recruitment.selections" :key="selection.id">
              <span :data-decision="selection.decision">{{ selection.decision }}</span>
              <strong>{{ agentName(selection.agentID) }}</strong>
              <p>{{ selection.reason }}</p>
            </article>
            <p v-if="!data.recruitment.selections.length" class="company-empty">Capability needs are being evaluated.</p>
          </div>
        </section>

        <section class="company-project-panel">
          <div class="company-section__heading">
            <div>
              <p class="company-eyebrow">Evidence</p>
              <h2>成果与关口</h2>
            </div>
          </div>
          <div class="company-evidence-list">
            <article v-for="artifact in data.artifacts" :key="artifact.id">
              <span>{{ artifact.kind }}</span>
              <strong>{{ artifact.title }}</strong>
            </article>
            <article v-for="gate in data.gates" :key="gate.id">
              <span>{{ gate.kind }} · {{ gate.status }}</span>
              <strong>{{ gate.title }}</strong>
            </article>
            <p v-if="!data.artifacts.length && !data.gates.length" class="company-empty">No evidence submitted yet.</p>
          </div>
        </section>
      </div>

      <div v-else class="company-page">
        <p v-if="error" class="company-notice">Project could not be loaded.</p>
        <p v-else class="company-empty">Loading project…</p>
      </div>
    </template>
  </UDashboardPanel>
</template>
