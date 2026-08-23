<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    side?: "top" | "right" | "bottom" | "left"
    align?: "start" | "center" | "end"
    modal?: boolean
    dismissible?: boolean
  }>(),
  {
    side: "bottom",
    align: "start",
    modal: false,
    dismissible: true,
  },
)

const open = defineModel<boolean>("open", { default: false })
</script>

<template>
  <UPopover
    v-model:open="open"
    :modal="props.modal"
    :dismissible="props.dismissible"
    :content="{ side: props.side, align: props.align, sideOffset: 8, collisionPadding: 12 }"
    :ui="{ content: 'ac-boardroom ac-ui-popover' }"
  >
    <slot :open="open" />
    <template #content="{ close }">
      <slot name="content" :close="close" />
    </template>
  </UPopover>
</template>

<style>
.ac-boardroom.ac-ui-popover {
  min-width: 220px;
  max-width: min(360px, calc(100vw - 24px));
  overflow: hidden;
  border: 0;
  border-radius: var(--ac-boardroom-radius-md);
  background: var(--ac-boardroom-cloud);
  color: var(--ac-boardroom-ink-900);
  box-shadow: var(--ac-boardroom-shadow-popover);
  font-family: var(--ac-boardroom-font-sans);
  transform-origin: var(--reka-popover-content-transform-origin);
}
</style>
