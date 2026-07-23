<script setup lang="ts">
import { useCompanySnapshot } from "../../composables/useCompanySnapshot"

const { data: snapshot, pending, refresh } = useCompanySnapshot()
</script>

<template>
  <UDashboardPanel id="agent-company-settings" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="company-settings-page">
        <header class="company-settings-page__header">
          <h1>Settings</h1>
          <p>Manage your identity, memory, integrations, and company module.</p>
        </header>

        <nav class="company-settings-tabs" aria-label="Settings">
          <NuxtLink to="/settings/profile">Profile</NuxtLink>
          <NuxtLink to="/settings/integrations">Integrations</NuxtLink>
          <NuxtLink to="/settings/company" class="company-settings-tabs__active">Company</NuxtLink>
        </nav>

        <div class="company-settings-stack">
          <section class="company-settings-section">
            <div class="company-settings-section__heading">
              <div>
                <h2>Control Plane</h2>
                <p>Read-only connection used by the Eve extension module.</p>
              </div>
              <UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-refresh-cw"
                aria-label="Refresh Control Plane"
                :loading="pending"
                @click="refresh()"
              />
            </div>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>{{ snapshot.connection === "live" ? "Connected" : "Demo fallback" }}</dd>
              </div>
              <div>
                <dt>Company</dt>
                <dd>{{ snapshot.company.name }}</dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>{{ snapshot.company.provider }}</dd>
              </div>
            </dl>
          </section>

          <section class="company-settings-section">
            <div class="company-settings-section__heading">
              <div>
                <h2>Source protection</h2>
                <p>The upstream Eve template is verified against its import manifest.</p>
              </div>
            </div>
            <dl>
              <div>
                <dt>Extension method</dt>
                <dd>Nuxt module + client plugin</dd>
              </div>
              <div>
                <dt>Template edits</dt>
                <dd>None</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
