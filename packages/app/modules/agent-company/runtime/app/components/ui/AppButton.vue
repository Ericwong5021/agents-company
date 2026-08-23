<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "ghost" | "danger"
    size?: "sm" | "md" | "lg" | "icon"
    type?: "button" | "submit" | "reset"
    disabled?: boolean
    loading?: boolean
    block?: boolean
  }>(),
  {
    variant: "secondary",
    size: "md",
    type: "button",
    disabled: false,
    loading: false,
    block: false,
  },
)
</script>

<template>
  <button
    class="ac-boardroom ac-ui-button"
    :class="{ 'ac-ui-button--block': block }"
    :data-variant="variant"
    :data-size="size"
    :type="type"
    :disabled="disabled || loading"
    :aria-busy="loading"
  >
    <span v-if="loading" class="ac-ui-button__spinner" aria-hidden="true" />
    <span v-if="$slots.leading && !loading" class="ac-ui-button__icon" aria-hidden="true">
      <slot name="leading" />
    </span>
    <span v-if="$slots.default" class="ac-ui-button__label">
      <slot />
    </span>
    <span v-if="$slots.trailing" class="ac-ui-button__icon" aria-hidden="true">
      <slot name="trailing" />
    </span>
  </button>
</template>

<style scoped>
.ac-ui-button {
  display: inline-flex;
  min-width: 40px;
  min-height: var(--ac-boardroom-control-height);
  align-items: center;
  justify-content: center;
  gap: var(--ac-boardroom-space-2);
  border: 0;
  border-radius: var(--ac-boardroom-radius-sm);
  padding: 0 14px;
  background: transparent;
  color: var(--ac-boardroom-ink-700);
  box-shadow: none;
  cursor: pointer;
  font: 650 13px/1 var(--ac-boardroom-font-sans);
  transition:
    transform var(--ac-boardroom-motion-fast) var(--ac-boardroom-ease-standard),
    background-color var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard),
    color var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard),
    box-shadow var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard),
    opacity var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard);
  user-select: none;
  white-space: nowrap;
}

.ac-ui-button[data-variant="primary"] {
  background: var(--ac-boardroom-accent-strong);
  color: var(--ac-boardroom-cloud);
  box-shadow: var(--ac-boardroom-shadow-control);
}

.ac-ui-button[data-variant="secondary"] {
  background: var(--ac-boardroom-cloud);
  color: var(--ac-boardroom-ink-700);
  box-shadow: var(--ac-boardroom-shadow-control);
}

.ac-ui-button[data-variant="ghost"] {
  color: var(--ac-boardroom-ink-500);
}

.ac-ui-button[data-variant="danger"] {
  background: var(--ac-boardroom-danger);
  color: var(--ac-boardroom-cloud);
  box-shadow: var(--ac-boardroom-shadow-control);
}

.ac-ui-button[data-size="sm"] {
  min-height: var(--ac-boardroom-control-height-sm);
  padding-inline: 12px;
  font-size: 12px;
}

.ac-ui-button[data-size="lg"] {
  min-height: var(--ac-boardroom-control-height-lg);
  padding-inline: 18px;
  font-size: 14px;
}

.ac-ui-button[data-size="icon"] {
  width: var(--ac-boardroom-control-height);
  padding: 0;
}

.ac-ui-button--block {
  width: 100%;
}

.ac-ui-button__icon {
  display: grid;
  width: 18px;
  height: 18px;
  flex: none;
  place-items: center;
}

.ac-ui-button__icon :deep(svg) {
  width: 18px;
  height: 18px;
}

.ac-ui-button__spinner {
  width: 15px;
  height: 15px;
  flex: none;
  border: 2px solid currentcolor;
  border-right-color: transparent;
  border-radius: var(--ac-boardroom-radius-pill);
  animation: ac-boardroom-spin 700ms linear infinite;
  opacity: 0.72;
}

.ac-ui-button:active:not(:disabled) {
  transform: scale(0.96);
}

.ac-ui-button:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}

@media (hover: hover) {
  .ac-ui-button[data-variant="primary"]:hover:not(:disabled) {
    background: var(--ac-boardroom-accent-ink);
  }

  .ac-ui-button[data-variant="secondary"]:hover:not(:disabled) {
    background: var(--ac-boardroom-accent-50);
    color: var(--ac-boardroom-accent-ink);
  }

  .ac-ui-button[data-variant="ghost"]:hover:not(:disabled) {
    background: var(--ac-boardroom-accent-50);
    color: var(--ac-boardroom-ink-700);
  }

  .ac-ui-button[data-variant="danger"]:hover:not(:disabled) {
    background: var(--ac-boardroom-danger);
    filter: brightness(0.92);
  }
}
</style>
