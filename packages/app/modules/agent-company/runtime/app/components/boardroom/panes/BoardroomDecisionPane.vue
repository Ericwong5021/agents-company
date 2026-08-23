<script setup lang="ts">
import type { BoardroomDecisionVM } from "../../../types/boardroom"
defineProps<{ decision: BoardroomDecisionVM }>()
</script>

<template>
  <article class="ac-boardroom-detail-pane">
    <header><span>{{ decision.authority }}</span><span>{{ decision.status }}</span></header>
    <h2>{{ decision.title }}</h2>
    <p>{{ decision.summary }}</p>
    <dl><div><dt>置信度</dt><dd>{{ decision.confidence === undefined ? "未记录" : `${Math.round(decision.confidence * 100)}%` }}</dd></div></dl>
    <section v-if="decision.principleRefs.length"><h3>原则</h3><span v-for="item in decision.principleRefs" :key="item">{{ item }}</span></section>
    <section v-if="decision.caseRefs.length"><h3>案例</h3><span v-for="item in decision.caseRefs" :key="item">{{ item }}</span></section>
    <section v-if="decision.evidenceRefs.length"><h3>证据</h3><span v-for="item in decision.evidenceRefs" :key="item">{{ item }}</span></section>
  </article>
</template>

<style scoped>
.ac-boardroom-detail-pane { padding: 20px; }
.ac-boardroom-detail-pane header { display: flex; gap: 6px; }
.ac-boardroom-detail-pane header span,
.ac-boardroom-detail-pane section span { display: inline-flex; margin: 0 5px 5px 0; border-radius: var(--ac-boardroom-radius-pill); padding: 4px 8px; background: var(--ac-boardroom-sidebar); color: var(--ac-boardroom-ink-500); font-size: 9.5px; }
.ac-boardroom-detail-pane h2 { margin: 16px 0 8px; color: var(--ac-boardroom-ink-900); font-size: 18px; line-height: 1.4; }
.ac-boardroom-detail-pane > p { margin: 0; color: var(--ac-boardroom-ink-700); font-size: 12.5px; line-height: 1.7; white-space: pre-wrap; }
.ac-boardroom-detail-pane dl { margin: 18px 0; border-block: 1px solid var(--ac-boardroom-ink-100); padding: 11px 0; }
.ac-boardroom-detail-pane dl div { display: flex; justify-content: space-between; color: var(--ac-boardroom-ink-500); font-size: 10.5px; }
.ac-boardroom-detail-pane dd { margin: 0; color: var(--ac-boardroom-ink-700); font-weight: 700; }
.ac-boardroom-detail-pane section { margin-top: 16px; }
.ac-boardroom-detail-pane h3 { margin: 0 0 8px; color: var(--ac-boardroom-ink-700); font-size: 10.5px; }
</style>
