<script setup lang="ts">
import { useRoute } from "nuxt/app"

const route = useRoute()
</script>

<template>
  <NuxtLink
    to="/company"
    class="company-module-launcher"
    :class="{ 'company-module-launcher--active': route.path.startsWith('/company') }"
    aria-label="Open Agent Company"
  >
    <span class="company-module-launcher__mark" aria-hidden="true">AC</span>
    <span>Company</span>
  </NuxtLink>
</template>
