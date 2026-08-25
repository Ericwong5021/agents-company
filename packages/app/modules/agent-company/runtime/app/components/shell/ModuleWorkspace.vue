<script setup lang="ts">
withDefaults(defineProps<{
  eyebrow: string
  title: string
  description?: string
  narrow?: boolean
}>(), {
  narrow: false,
  description: "",
})
</script>

<template>
  <div class="ac-module-workspace" :data-narrow="narrow || undefined" lang="zh-CN">
    <header class="ac-module-workspace__header">
      <div>
        <p class="ac-module-workspace__eyebrow">{{ eyebrow }}</p>
        <h1>{{ title }}</h1>
        <p v-if="description" class="ac-module-workspace__description">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="ac-module-workspace__actions">
        <slot name="actions" />
      </div>
    </header>
    <slot />
  </div>
</template>

<style scoped>
.ac-module-workspace {
  width: min(100%, 1040px);
  margin: 0 auto;
  padding: 30px 34px 52px;
}

.ac-module-workspace[data-narrow] {
  width: min(100%, 760px);
}

.ac-module-workspace__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 24px;
}

.ac-module-workspace__eyebrow {
  color: var(--ac-boardroom-ink-500);
  font-size: 10px;
  font-weight: 680;
  letter-spacing: 0.12em;
  line-height: 1.4;
  text-transform: uppercase;
}

.ac-module-workspace h1 {
  margin-top: 5px;
  color: var(--ac-boardroom-ink-900);
  font-size: clamp(25px, 2.4vw, 30px);
  font-weight: 720;
  letter-spacing: -0.025em;
  line-height: 1.12;
  text-wrap: balance;
}

.ac-module-workspace__description {
  max-width: 620px;
  margin-top: 8px;
  color: var(--ac-boardroom-ink-500);
  font-size: 13px;
  line-height: 1.7;
  text-wrap: pretty;
}

.ac-module-workspace__actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 720px) {
  .ac-module-workspace {
    padding: 22px 18px calc(86px + env(safe-area-inset-bottom));
  }

  .ac-module-workspace__header {
    display: grid;
    gap: 14px;
  }

  .ac-module-workspace__actions {
    justify-content: flex-start;
  }
}
</style>
