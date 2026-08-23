<script setup lang="ts">
import type { WorkApprovalCardVM } from "../../types/work-room"

defineProps<{ approval: WorkApprovalCardVM }>()
defineEmits<{ open: [string] }>()
</script>

<template>
  <button class="ac-approval-card" type="button" @click="$emit('open', approval.id)">
    <span><UIcon name="i-lucide-shield-question" /></span>
    <span><small>需要你的决定</small><strong>{{ approval.title }}</strong><em>{{ approval.summary }}</em></span>
    <UIcon name="i-lucide-chevron-right" />
  </button>
</template>

<style scoped>
.ac-approval-card { display: grid; grid-template-columns: 32px minmax(0, 1fr) 16px; align-items: center; gap: 10px; width: 100%; min-height: 64px; border: 1px solid color-mix(in srgb, var(--ac-boardroom-warning) 45%, var(--ac-boardroom-ink-100)); border-radius: var(--ac-boardroom-radius-md); padding: 9px 11px; background: color-mix(in srgb, var(--ac-boardroom-warning) 8%, var(--ac-boardroom-cloud)); color: var(--ac-boardroom-ink-700); text-align: left; box-shadow: var(--ac-boardroom-shadow-control); transition: transform var(--ac-boardroom-motion-fast), background-color var(--ac-boardroom-motion-base); }
.ac-approval-card:active { transform: scale(.98); }
.ac-approval-card > span:first-child { display: grid; width: 32px; height: 32px; place-items: center; border-radius: var(--ac-boardroom-radius-sm); background: color-mix(in srgb, var(--ac-boardroom-warning) 18%, var(--ac-boardroom-cloud)); color: var(--ac-boardroom-warning); }
.ac-approval-card > span:nth-child(2) { display: grid; min-width: 0; gap: 2px; }
.ac-approval-card small { color: var(--ac-boardroom-warning); font-size: 9.5px; font-weight: 750; }
.ac-approval-card strong, .ac-approval-card em { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-approval-card strong { font-size: 11.5px; }
.ac-approval-card em { color: var(--ac-boardroom-ink-500); font-size: 9.5px; font-style: normal; }
.ac-approval-card > svg { color: var(--ac-boardroom-ink-300); }
@media (hover: hover) { .ac-approval-card:hover { background: color-mix(in srgb, var(--ac-boardroom-warning) 13%, var(--ac-boardroom-cloud)); } }
</style>
