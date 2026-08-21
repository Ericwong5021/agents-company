<script setup lang="ts">
const colorMode = useColorMode();

const themeColor = computed(() => (colorMode.value === "dark" ? "#101c25" : "#f1f7fb"));

useHead({
  meta: [
    { key: "theme-color", name: "theme-color", content: themeColor },
  ],
});

useSiteSeo();
</script>

<template>
  <UApp :toaster="{ position: 'top-right' }" :tooltip="{ delayDuration: 200 }">
    <NuxtLoadingIndicator color="var(--ui-text-highlighted)" />

    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
