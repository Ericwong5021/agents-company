<script setup lang="ts">
withDefaults(
  defineProps<{
    axis?: "vertical" | "horizontal" | "both"
    label?: string
    tabindex?: number
  }>(),
  {
    axis: "vertical",
    label: undefined,
    tabindex: 0,
  },
)
</script>

<template>
  <div
    class="ac-boardroom ac-ui-scroll-area"
    :data-axis="axis"
    :role="label ? 'region' : undefined"
    :aria-label="label"
    :tabindex="tabindex"
  >
    <div class="ac-ui-scroll-area__content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.ac-ui-scroll-area {
  min-width: 0;
  min-height: 0;
  overscroll-behavior: contain;
  scrollbar-color: var(--ac-boardroom-scrollbar) transparent;
  scrollbar-width: thin;
}

.ac-ui-scroll-area[data-axis="vertical"] {
  overflow-x: hidden;
  overflow-y: auto;
}

.ac-ui-scroll-area[data-axis="horizontal"] {
  overflow-x: auto;
  overflow-y: hidden;
}

.ac-ui-scroll-area[data-axis="both"] {
  overflow: auto;
}

.ac-ui-scroll-area::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.ac-ui-scroll-area::-webkit-scrollbar-track {
  background: transparent;
}

.ac-ui-scroll-area::-webkit-scrollbar-thumb {
  border-radius: var(--ac-boardroom-radius-pill);
  background: var(--ac-boardroom-scrollbar);
}

@media (hover: hover) {
  .ac-ui-scroll-area::-webkit-scrollbar-thumb:hover {
    background: var(--ac-boardroom-scrollbar-hover);
  }
}
</style>
