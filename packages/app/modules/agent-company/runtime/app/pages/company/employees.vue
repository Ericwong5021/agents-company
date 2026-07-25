<script setup lang="ts">
import { computed } from "vue"
import { useCompanySnapshot } from "../../composables/useCompanySnapshot"

const { data: snapshot, pending, refresh } = useCompanySnapshot()
const companyAvailable = computed(() => ["ready", "degraded"].includes(snapshot.value.connection))
</script>

<template>
  <UDashboardPanel id="agent-company-employees" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="company-page">
        <header class="company-page__header">
          <div>
            <p class="company-eyebrow">Employee projection</p>
            <h1>Employees</h1>
            <p class="company-page__lede">Evidence-backed presence and activity from the local runtime.</p>
          </div>
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

        <p v-else-if="snapshot.notice" class="company-notice">{{ snapshot.notice }}</p>

        <section v-if="companyAvailable" class="company-employee-grid" aria-label="Company employees">
          <article v-for="agent in snapshot.agents" :key="agent.id" class="company-employee">
            <div class="company-employee__top">
              <span class="company-employee__avatar">{{ agent.name.slice(0, 1) }}</span>
              <span class="company-presence" :data-state="agent.presence">{{ agent.presence }}</span>
            </div>
            <h2>{{ agent.name }}</h2>
            <p>{{ agent.role }}</p>
            <dl>
              <div>
                <dt>Department</dt>
                <dd>{{ agent.department }}</dd>
              </div>
              <div>
                <dt>Activity</dt>
                <dd>{{ agent.activity }}</dd>
              </div>
            </dl>
            <span class="company-employee__subject">{{ agent.subject }}</span>
          </article>
          <p v-if="!snapshot.agents.length" class="company-empty">No employees were returned by the Control Plane.</p>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
