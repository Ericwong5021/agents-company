<script setup lang="ts">
const route = useRoute();
const projectID = Array.isArray(route.params.projectID)
  ? route.params.projectID[0]
  : route.params.projectID;

await navigateTo(`/work/${encodeURIComponent(projectID ?? "")}`, {
  replace: true,
  redirectCode: 302,
});
</script>

<template>
  <div />
</template>
