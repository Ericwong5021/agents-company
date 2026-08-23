<script setup lang="ts">
import type { WorkExecutionStepVM } from "../../types/work-room"

defineProps<{ steps: WorkExecutionStepVM[] }>()
defineEmits<{ open: [] }>()

const statusLabels: Record<string, string> = { queued: "排队", running: "执行中", completed: "完成", failed: "失败", interrupted: "已中断" }
</script>

<template>
  <button class="ac-execution-card" type="button" @click="$emit('open')">
    <span class="ac-execution-card__title"><UIcon name="i-lucide-activity" /><strong>执行记录</strong><small>{{ steps.length }} 条最近 Attempt</small></span>
    <span v-for="step in steps.slice(0, 3)" :key="step.id" class="ac-execution-card__step" :data-status="step.status"><i /><span>{{ step.label }}</span><em>{{ statusLabels[step.status] ?? step.status }}</em></span>
    <span v-if="!steps.length" class="ac-execution-card__empty">暂无执行 Attempt</span>
  </button>
</template>

<style scoped>
.ac-execution-card { display: grid; gap: 7px; width: 100%; min-height: 64px; border: 1px solid var(--ac-boardroom-ink-100); border-radius: var(--ac-boardroom-radius-md); padding: 10px 12px; background: var(--ac-boardroom-cloud); color: var(--ac-boardroom-ink-700); text-align: left; box-shadow: var(--ac-boardroom-shadow-control); transition: transform var(--ac-boardroom-motion-fast), background-color var(--ac-boardroom-motion-base); }
.ac-execution-card:active { transform: scale(.98); }
.ac-execution-card__title { display: flex; align-items: center; gap: 6px; }
.ac-execution-card__title svg { color: var(--ac-boardroom-accent-strong); }
.ac-execution-card__title strong { font-size: 11.5px; }
.ac-execution-card__title small { margin-left: auto; color: var(--ac-boardroom-ink-300); font-size: 9px; }
.ac-execution-card__step { display: grid; grid-template-columns: 6px minmax(0, 1fr) auto; align-items: center; gap: 6px; color: var(--ac-boardroom-ink-500); font-size: 9.5px; }
.ac-execution-card__step i { width: 6px; height: 6px; border-radius: 50%; background: var(--ac-boardroom-ink-200); }
.ac-execution-card__step[data-status="completed"] i { background: var(--ac-boardroom-success); }
.ac-execution-card__step[data-status="failed"] i { background: var(--ac-boardroom-danger); }
.ac-execution-card__step span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-execution-card__step em { font-style: normal; }
.ac-execution-card__empty { color: var(--ac-boardroom-ink-300); font-size: 10px; }
@media (hover: hover) { .ac-execution-card:hover { background: var(--ac-boardroom-accent-50); } }
</style>
