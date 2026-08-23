<script setup lang="ts">
import type { WorkTaskCardVM } from "../../types/work-room"

defineProps<{ task: WorkTaskCardVM }>()
defineEmits<{ open: [string] }>()

const statusLabels: Record<string, string> = {
  running: "执行中",
  blocked: "受阻",
  failed: "失败",
  pending_review: "待复核",
}
</script>

<template>
  <button class="ac-work-card" :data-status="task.status" type="button" @click="$emit('open', task.id)">
    <span class="ac-work-card__icon"><UIcon name="i-lucide-list-checks" /></span>
    <span><small>任务 · {{ statusLabels[task.status] ?? task.status }}</small><strong>{{ task.title }}</strong><em>{{ task.owner }}</em></span>
    <UIcon name="i-lucide-chevron-right" />
  </button>
</template>

<style scoped>
.ac-work-card { display: grid; grid-template-columns: 32px minmax(0, 1fr) 16px; align-items: center; gap: 10px; width: 100%; min-height: 64px; border: 1px solid var(--ac-boardroom-ink-100); border-radius: var(--ac-boardroom-radius-md); padding: 9px 11px; background: var(--ac-boardroom-cloud); color: var(--ac-boardroom-ink-700); text-align: left; box-shadow: var(--ac-boardroom-shadow-control); transition: transform var(--ac-boardroom-motion-fast), background-color var(--ac-boardroom-motion-base); }
.ac-work-card:active { transform: scale(.98); }
.ac-work-card__icon { display: grid; width: 32px; height: 32px; place-items: center; border-radius: var(--ac-boardroom-radius-sm); background: var(--ac-boardroom-accent-50); color: var(--ac-boardroom-accent-strong); }
.ac-work-card > span:nth-child(2) { display: grid; min-width: 0; gap: 2px; }
.ac-work-card small, .ac-work-card em { color: var(--ac-boardroom-ink-500); font-size: 9.5px; font-style: normal; }
.ac-work-card strong { overflow: hidden; font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }
.ac-work-card > svg { color: var(--ac-boardroom-ink-300); }
.ac-work-card[data-status="blocked"] .ac-work-card__icon, .ac-work-card[data-status="failed"] .ac-work-card__icon { background: var(--ac-boardroom-danger-soft); color: var(--ac-boardroom-danger); }
@media (hover: hover) { .ac-work-card:hover { background: var(--ac-boardroom-accent-50); } }
</style>
