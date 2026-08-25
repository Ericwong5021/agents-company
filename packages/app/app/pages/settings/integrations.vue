<script setup lang="ts">
const { connectors, error, refresh, isInitialLoad, pending } = useConnectors();
const connectedCount = computed(
  () => connectors.value?.filter(connector => connector.status.state === "connected").length ?? 0,
);
</script>

<template>
  <UDashboardPanel id="integration-settings" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <ModuleWorkspace eyebrow="设置" title="集成" description="" narrow>
        <div class="grid gap-8">
          <SettingsSection title="消息渠道">
            <IntegrationsSlackLinkCard />
          </SettingsSection>

          <SettingsSection v-if="isInitialLoad || error || connectors?.length" title="外部服务">
            <template #actions>
              <div class="flex items-center gap-2">
                <span v-if="connectors" class="text-xs tabular-nums text-muted">{{ connectedCount }}/{{ connectors.length }} 已连接</span>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-refresh-cw"
                  :loading="pending"
                  aria-label="刷新外部服务"
                  @click="refresh()"
                />
              </div>
            </template>

            <div v-if="isInitialLoad" class="px-4 py-4">
              <USkeleton class="h-12 rounded-md" />
            </div>

            <div v-else-if="error" class="px-4 py-4">
              <UAlert color="error" variant="subtle" title="外部服务加载失败" :description="error.message" />
            </div>

            <template v-else>
              <IntegrationsConnectorCard
                v-for="connector in connectors"
                :key="connector.id"
                :connector="connector"
                @refresh="refresh()"
              />
            </template>
          </SettingsSection>
        </div>
      </ModuleWorkspace>
    </template>
  </UDashboardPanel>
</template>
