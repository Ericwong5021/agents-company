<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    text?: string
    side?: "top" | "right" | "bottom" | "left"
    delay?: number
    disabled?: boolean
  }>(),
  {
    text: undefined,
    side: "top",
    delay: 280,
    disabled: false,
  },
)

const open = defineModel<boolean>("open", { default: false })
</script>

<template>
  <UTooltip
    v-model:open="open"
    :text="props.text"
    :disabled="props.disabled"
    :delay-duration="props.delay"
    :content="{ side: props.side, sideOffset: 8, collisionPadding: 12 }"
    :ui="{
      content: 'ac-boardroom ac-ui-tooltip',
      text: 'ac-ui-tooltip__text',
    }"
  >
    <slot :open="open" />
    <template v-if="$slots.content" #content>
      <slot name="content" />
    </template>
  </UTooltip>
</template>

<style>
.ac-boardroom.ac-ui-tooltip {
  max-width: min(280px, calc(100vw - 24px));
  border: 0;
  border-radius: var(--ac-boardroom-radius-xs);
  background: var(--ac-boardroom-ink-900);
  padding: 7px 9px;
  color: var(--ac-boardroom-cloud);
  box-shadow: var(--ac-boardroom-shadow-control);
  font-family: var(--ac-boardroom-font-sans);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.45;
}

.ac-boardroom.ac-ui-tooltip .ac-ui-tooltip__text {
  color: inherit;
}
</style>
