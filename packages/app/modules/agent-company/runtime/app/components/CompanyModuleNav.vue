<script setup lang="ts">
import { useAppConfig, useRoute } from "nuxt/app"
import { computed } from "vue"

const route = useRoute()
const appConfig = useAppConfig() as {
  shell: {
    navigation: Array<{ label: string; to: string }>
  }
}

const paths = new Set(["/company", "/company/board", "/company/operations"])
const items = computed(() => appConfig.shell.navigation.filter(item => paths.has(item.to)))

function isActive(path: string) {
  return route.path === path || (path !== "/inbox" && route.path.startsWith(`${path}/`))
}
</script>

<template>
  <nav class="company-module-nav" aria-label="Agent Company primary">
    <NuxtLink
      v-for="item in items"
      :key="item.to"
      :to="item.to"
      class="company-module-nav__item"
      :class="{ 'company-module-nav__item--active': isActive(item.to) }"
      :aria-current="isActive(item.to) ? 'page' : undefined"
    >
      {{ item.label }}
    </NuxtLink>
  </nav>
</template>
