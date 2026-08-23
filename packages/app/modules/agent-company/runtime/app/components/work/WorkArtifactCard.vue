<script setup lang="ts">
import type { WorkArtifactCardVM } from "../../types/work-room"

defineProps<{ artifact: WorkArtifactCardVM }>()
defineEmits<{ open: [string] }>()
</script>

<template>
  <button class="ac-artifact-card" type="button" @click="$emit('open', artifact.id)">
    <span><UIcon name="i-lucide-file-check-2" /></span>
    <span><small>最新成果 · {{ artifact.kind }}</small><strong>{{ artifact.title }}</strong></span>
    <UIcon name="i-lucide-chevron-right" />
  </button>
</template>

<style scoped>
.ac-artifact-card { display: grid; grid-template-columns: 32px minmax(0, 1fr) 16px; align-items: center; gap: 10px; width: 100%; min-height: 64px; border: 1px solid var(--ac-boardroom-ink-100); border-radius: var(--ac-boardroom-radius-md); padding: 9px 11px; background: var(--ac-boardroom-cloud); color: var(--ac-boardroom-ink-700); text-align: left; box-shadow: var(--ac-boardroom-shadow-control); transition: transform var(--ac-boardroom-motion-fast), background-color var(--ac-boardroom-motion-base); }
.ac-artifact-card:active { transform: scale(.98); }
.ac-artifact-card > span:first-child { display: grid; width: 32px; height: 32px; place-items: center; border-radius: var(--ac-boardroom-radius-sm); background: color-mix(in srgb, var(--ac-boardroom-success) 14%, var(--ac-boardroom-cloud)); color: var(--ac-boardroom-success); }
.ac-artifact-card > span:nth-child(2) { display: grid; min-width: 0; gap: 3px; }
.ac-artifact-card small { color: var(--ac-boardroom-ink-500); font-size: 9.5px; }
.ac-artifact-card strong { overflow: hidden; font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }
.ac-artifact-card > svg { color: var(--ac-boardroom-ink-300); }
@media (hover: hover) { .ac-artifact-card:hover { background: var(--ac-boardroom-accent-50); } }
</style>
