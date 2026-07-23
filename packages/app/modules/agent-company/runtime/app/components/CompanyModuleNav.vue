<script setup lang="ts">
import { useAppConfig, useRoute } from "nuxt/app"
import { computed } from "vue"

const route = useRoute()
const appConfig = useAppConfig() as {
  agentCompany?: {
    navigation?: Array<{ label: string; to: string }>
  }
}

const items = computed(
  () =>
    appConfig.agentCompany?.navigation ?? [
      { label: "Overview", to: "/company" },
      { label: "Board", to: "/company/board" },
      { label: "Employees", to: "/company/employees" },
    ],
)
</script>

<template>
  <nav class="company-module-nav" aria-label="Agent Company">
    <NuxtLink
      v-for="item in items"
      :key="item.to"
      :to="item.to"
      class="company-module-nav__item"
      :class="{ 'company-module-nav__item--active': route.path === item.to }"
    >
      {{ item.label }}
    </NuxtLink>
  </nav>
</template>
