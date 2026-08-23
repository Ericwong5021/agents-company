<script setup lang="ts">
withDefaults(defineProps<{
  contextOpen?: boolean
  contextWide?: boolean
}>(), {
  contextOpen: false,
  contextWide: false,
})
</script>

<template>
  <section class="ac-workspace-stage" :data-context-open="contextOpen || undefined" :data-context-wide="contextWide || undefined">
    <main id="main-content" tabindex="-1" class="ac-workspace-stage__main">
      <slot />
    </main>
    <slot name="context" />
  </section>
</template>

<style scoped>
.ac-workspace-stage {
  position: relative;
  z-index: 0;
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(0, 1fr);
  overflow: hidden;
  background: var(--ac-boardroom-canvas);
}

.ac-workspace-stage[data-context-open] {
  grid-template-columns: minmax(0, 1fr) 420px;
}

.ac-workspace-stage[data-context-wide] {
  grid-template-columns: minmax(0, 1fr) clamp(420px, 42vw, 640px);
}

.ac-workspace-stage__main {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.ac-workspace-stage__main:focus {
  outline: 0;
}

.ac-workspace-stage__main > :deep([data-slot="root"]) {
  height: 100%;
  min-height: 0;
}

.ac-workspace-stage__main > :deep([data-slot="root"] > [data-slot="body"] > *) {
  animation: ac-boardroom-rise var(--ac-boardroom-motion-slow) var(--ac-boardroom-ease-out) both;
}

@media (max-width: 1180px) {
  .ac-workspace-stage[data-context-open],
  .ac-workspace-stage[data-context-wide] {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
