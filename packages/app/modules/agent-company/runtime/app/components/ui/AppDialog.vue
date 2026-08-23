<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    title?: string
    description?: string
    dismissible?: boolean
    scrollable?: boolean
    close?: boolean
  }>(),
  {
    title: undefined,
    description: undefined,
    dismissible: true,
    scrollable: false,
    close: true,
  },
)

const open = defineModel<boolean>("open", { default: false })
</script>

<template>
  <UModal
    v-model:open="open"
    :title="props.title"
    :description="props.description"
    :dismissible="props.dismissible"
    :scrollable="props.scrollable"
    :close="props.close"
    :ui="{
      overlay: 'ac-boardroom ac-ui-dialog-overlay',
      content: 'ac-boardroom ac-ui-dialog',
      header: 'ac-ui-dialog__header',
      wrapper: 'ac-ui-dialog__heading',
      title: 'ac-ui-dialog__title',
      description: 'ac-ui-dialog__description',
      body: 'ac-ui-dialog__body',
      footer: 'ac-ui-dialog__footer',
      close: 'ac-ui-dialog__close',
    }"
  >
    <slot :open="open" />
    <template v-if="$slots.title" #title>
      <slot name="title" />
    </template>
    <template v-if="$slots.description" #description>
      <slot name="description" />
    </template>
    <template #body="{ close: closeDialog }">
      <slot name="body" :close="closeDialog" />
    </template>
    <template v-if="$slots.footer" #footer="{ close: closeDialog }">
      <slot name="footer" :close="closeDialog" />
    </template>
  </UModal>
</template>

<style>
.ac-boardroom.ac-ui-dialog-overlay {
  background: var(--ac-boardroom-overlay);
}

.ac-boardroom.ac-ui-dialog {
  width: min(520px, calc(100vw - 24px));
  max-width: none;
  max-height: min(760px, calc(100svh - 24px));
  overflow: hidden;
  border: 0;
  border-radius: var(--ac-boardroom-radius-xl);
  background: var(--ac-boardroom-cloud);
  color: var(--ac-boardroom-ink-900);
  box-shadow: var(--ac-boardroom-shadow-dialog);
  font-family: var(--ac-boardroom-font-sans);
}

.ac-boardroom.ac-ui-dialog .ac-ui-dialog__header {
  min-height: 72px;
  align-items: flex-start;
  gap: var(--ac-boardroom-space-4);
  padding: var(--ac-boardroom-space-5) var(--ac-boardroom-space-6) var(--ac-boardroom-space-4);
}

.ac-boardroom.ac-ui-dialog .ac-ui-dialog__heading {
  gap: var(--ac-boardroom-space-1);
}

.ac-boardroom.ac-ui-dialog .ac-ui-dialog__title {
  color: var(--ac-boardroom-ink-900);
  font-size: 17px;
  font-weight: 720;
  letter-spacing: -0.012em;
  line-height: 1.3;
  text-wrap: balance;
}

.ac-boardroom.ac-ui-dialog .ac-ui-dialog__description {
  color: var(--ac-boardroom-ink-500);
  font-size: 12px;
  line-height: 1.65;
  text-wrap: pretty;
}

.ac-boardroom.ac-ui-dialog .ac-ui-dialog__body {
  padding: var(--ac-boardroom-space-2) var(--ac-boardroom-space-6) var(--ac-boardroom-space-6);
}

.ac-boardroom.ac-ui-dialog .ac-ui-dialog__footer {
  gap: var(--ac-boardroom-space-2);
  padding: var(--ac-boardroom-space-4) var(--ac-boardroom-space-6) var(--ac-boardroom-space-5);
}

.ac-boardroom.ac-ui-dialog .ac-ui-dialog__close {
  min-width: 40px;
  min-height: 40px;
  border-radius: var(--ac-boardroom-radius-sm);
  color: var(--ac-boardroom-ink-500);
}
</style>
