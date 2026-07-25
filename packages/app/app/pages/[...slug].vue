<script setup lang="ts">
if (import.meta.server) setResponseStatus(404);
</script>

<template>
  <UDashboardPanel id="not-found" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page ac-workspace-page--narrow">
        <header class="ac-workspace-header">
          <div>
            <p class="ac-workspace-eyebrow">404</p>
            <h1 class="ac-workspace-title">页面不存在</h1>
            <p class="ac-workspace-lede">
              这个地址没有对应的 Agent Company 页面。
            </p>
          </div>
        </header>

        <section class="ac-empty-state">
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon" aria-hidden="true">
              <UIcon name="i-lucide-map" />
            </span>
            <h2>回到工作区</h2>
            <p>从 Inbox 继续查看需要处理的真实事项。</p>
            <UButton class="ac-empty-state__action" color="neutral" to="/inbox">
              打开 Inbox
            </UButton>
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
