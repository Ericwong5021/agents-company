<!-- Adapted from yetone/cumora@5dbbdee under the MIT License. Reimplemented for Vue/Nuxt and AgentCompany domain models. -->
<script setup lang="ts">
defineProps<{
  pageTitle: string
  connection: string
  connectionLabel: string
}>()
</script>

<template>
  <header class="ac-app-titlebar">
    <div class="ac-app-titlebar__controls" aria-hidden="true">
      <span data-control="close" />
      <span data-control="minimize" />
      <span data-control="maximize" />
    </div>

    <div class="ac-app-titlebar__identity">
      <Logo />
      <strong>Agent Company</strong>
      <span aria-hidden="true">·</span>
      <em>{{ pageTitle }}</em>
    </div>

    <div class="ac-app-titlebar__status" :data-connection="connection" role="status">
      <span aria-hidden="true" />
      {{ connectionLabel }}
    </div>
  </header>
</template>

<style scoped>
.ac-app-titlebar {
  display: grid;
  height: 44px;
  flex: none;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  border-bottom: 1px solid var(--ac-boardroom-ink-100);
  background: var(--ac-boardroom-paper);
  padding: 0 16px;
  user-select: none;
}

.ac-app-titlebar__controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ac-app-titlebar__controls span {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  box-shadow: inset 0 -1px 0 rgb(0 0 0 / 0.1);
}

.ac-app-titlebar__controls [data-control="close"] {
  background: #ff6058;
}

.ac-app-titlebar__controls [data-control="minimize"] {
  background: #ffbd2e;
}

.ac-app-titlebar__controls [data-control="maximize"] {
  background: #28c940;
}

.ac-app-titlebar__identity {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--ac-boardroom-ink-500);
  font-size: 13px;
  white-space: nowrap;
}

.ac-app-titlebar__identity svg {
  width: 18px;
  height: 18px;
  flex: none;
  color: var(--ac-boardroom-accent-strong);
}

.ac-app-titlebar__identity strong {
  color: var(--ac-boardroom-ink-700);
  font-weight: 700;
}

.ac-app-titlebar__identity > span {
  color: var(--ac-boardroom-ink-200);
}

.ac-app-titlebar__identity em {
  overflow: hidden;
  max-width: 220px;
  color: var(--ac-boardroom-ink-500);
  font-size: 12px;
  font-style: normal;
  font-weight: 500;
  text-overflow: ellipsis;
}

.ac-app-titlebar__status {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
  color: var(--ac-boardroom-ink-500);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.ac-app-titlebar__status > span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ac-boardroom-resting);
}

.ac-app-titlebar__status[data-connection="ready"] > span {
  background: var(--ac-boardroom-success);
}

.ac-app-titlebar__status[data-connection="degraded"] > span,
.ac-app-titlebar__status[data-connection="recovering"] > span {
  background: var(--ac-boardroom-warning);
}

.ac-app-titlebar__status[data-connection="disconnected"] > span {
  background: var(--ac-boardroom-danger);
}

@media (max-width: 720px) {
  .ac-app-titlebar {
    display: none;
  }
}
</style>
