<script setup lang="ts">
import type { BoardroomArtifactVM } from "../../../types/boardroom"
defineProps<{ artifact: BoardroomArtifactVM }>()
</script>

<template>
  <article class="ac-boardroom-artifact-pane">
    <header><span><UIcon name="i-lucide-file-text" /></span><div><h2>{{ artifact.title }}</h2><p>{{ artifact.meta }}</p></div></header>
    <pre>{{ artifact.content }}</pre>
  </article>
</template>

<style scoped>
.ac-boardroom-artifact-pane { padding: 20px; }
.ac-boardroom-artifact-pane header { display: flex; align-items: center; gap: 11px; }
.ac-boardroom-artifact-pane header > span { display: grid; width: 40px; height: 40px; place-items: center; border-radius: var(--ac-boardroom-radius-sm); background: var(--ac-boardroom-accent-50); color: var(--ac-boardroom-accent-strong); }
.ac-boardroom-artifact-pane header svg { width: 19px; height: 19px; }
.ac-boardroom-artifact-pane h2 { margin: 0; color: var(--ac-boardroom-ink-900); font-size: 15px; }
.ac-boardroom-artifact-pane header p { margin: 2px 0 0; color: var(--ac-boardroom-ink-500); font-size: 10px; }
.ac-boardroom-artifact-pane pre { margin: 18px 0 0; border: 1px solid var(--ac-boardroom-ink-100); border-radius: var(--ac-boardroom-radius-sm); padding: 14px; background: var(--ac-boardroom-sidebar); color: var(--ac-boardroom-ink-700); font: 11px/1.65 var(--ac-boardroom-font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
