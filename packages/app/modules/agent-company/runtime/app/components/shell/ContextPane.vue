<!-- Adapted from yetone/cumora@5dbbdee under the MIT License. Reimplemented for Vue/Nuxt and AgentCompany domain models. -->
<script setup lang="ts">
withDefaults(defineProps<{
  open?: boolean
  title: string
  subtitle?: string
  icon?: string
  wide?: boolean
}>(), {
  open: false,
  subtitle: "",
  icon: "i-lucide-panel-right",
  wide: false,
})

defineEmits<{
  close: []
}>()
</script>

<template>
  <Teleport to="body" :disabled="!open">
    <button v-if="open" type="button" class="ac-context-pane__scrim" aria-label="关闭上下文" @click="$emit('close')" />
  </Teleport>
  <aside v-if="open" class="ac-context-pane ac-motion-rise" :data-wide="wide || undefined" :aria-label="title">
    <header class="ac-context-pane__header">
      <span><UIcon :name="icon" /></span>
      <div>
        <strong>{{ title }}</strong>
        <small v-if="subtitle">{{ subtitle }}</small>
      </div>
      <button type="button" aria-label="关闭上下文" @click="$emit('close')">
        <UIcon name="i-lucide-x" />
      </button>
    </header>
    <AppScrollArea class="ac-context-pane__body">
      <slot />
    </AppScrollArea>
  </aside>
</template>

<style scoped>
.ac-context-pane {
  display: flex;
  width: 420px;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  border-left: 1px solid var(--ac-boardroom-ink-100);
  background: var(--ac-boardroom-paper);
}

.ac-context-pane[data-wide] {
  width: clamp(420px, 42vw, 640px);
}

.ac-context-pane__header {
  display: grid;
  min-height: 64px;
  flex: none;
  grid-template-columns: 36px minmax(0, 1fr) 40px;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--ac-boardroom-ink-100);
  padding: 10px 12px 10px 16px;
}

.ac-context-pane__header > span,
.ac-context-pane__header > button {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: var(--ac-boardroom-radius-sm);
  color: var(--ac-boardroom-ink-500);
}

.ac-context-pane__header > span {
  background: var(--ac-boardroom-sidebar);
}

.ac-context-pane__header > span svg,
.ac-context-pane__header > button svg {
  width: 18px;
  height: 18px;
}

.ac-context-pane__header > button {
  width: 40px;
  height: 40px;
  transition: background-color var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard), color var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard), transform var(--ac-boardroom-motion-fast) var(--ac-boardroom-ease-standard);
}

.ac-context-pane__header > button:active {
  transform: scale(0.96);
}

.ac-context-pane__header > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.ac-context-pane__header strong,
.ac-context-pane__header small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-context-pane__header strong {
  color: var(--ac-boardroom-ink-900);
  font-size: 13.5px;
  font-weight: 720;
}

.ac-context-pane__header small {
  color: var(--ac-boardroom-ink-500);
  font-size: 10.5px;
}

.ac-context-pane__body {
  min-height: 0;
  flex: 1;
}

.ac-context-pane__scrim {
  display: none;
}

@media (hover: hover) {
  .ac-context-pane__header > button:hover {
    background: var(--ac-boardroom-sidebar);
    color: var(--ac-boardroom-ink-900);
  }
}

@media (max-width: 1180px) {
  .ac-context-pane {
    position: fixed;
    z-index: 91;
    top: 44px;
    right: 0;
    bottom: 0;
    width: min(420px, calc(100vw - 28px));
    box-shadow: var(--ac-boardroom-shadow-dialog);
  }

  .ac-context-pane[data-wide] {
    width: min(640px, calc(100vw - 28px));
  }

  .ac-context-pane__scrim {
    position: fixed;
    z-index: 90;
    inset: 44px 0 0;
    display: block;
    background: var(--ac-boardroom-overlay);
  }
}

@media (max-width: 720px) {
  .ac-context-pane,
  .ac-context-pane[data-wide] {
    top: 0;
    width: 100%;
  }

  .ac-context-pane__scrim {
    inset: 0;
  }
}
</style>
