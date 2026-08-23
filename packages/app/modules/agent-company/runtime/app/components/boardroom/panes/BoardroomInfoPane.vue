<script setup lang="ts">
import type { BoardroomGovernanceVM, BoardroomParticipantVM, BoardroomRoomVM } from "../../../types/boardroom"

defineProps<{
  room: BoardroomRoomVM
  participants: BoardroomParticipantVM[]
  governance: BoardroomGovernanceVM
}>()

defineEmits<{
  decision: [decisionID: string]
  artifact: [artifactID: string, version: number]
  governance: []
}>()
</script>

<template>
  <div class="ac-boardroom-info-pane">
    <section class="ac-boardroom-info-pane__room">
      <span aria-hidden="true">★</span>
      <div><strong>{{ room.title }}</strong><p>{{ room.topic }}</p></div>
    </section>
    <section>
      <header><h3>参与者</h3><span>{{ participants.length + 1 }}</span></header>
      <div class="ac-boardroom-info-pane__people">
        <article v-for="participant in participants" :key="participant.id">
          <AppAvatar :name="participant.name" :size="34" :tone="participant.tone" :status="participant.status" />
          <div><strong>{{ participant.name }}</strong><span>{{ participant.role }} · {{ participant.statusLabel }}</span></div>
        </article>
        <article><AppAvatar name="你" :size="34" tone="coral" status="available" /><div><strong>你</strong><span>创始人 · 在线</span></div></article>
      </div>
    </section>
    <section>
      <header><h3>治理</h3><button type="button" @click="$emit('governance')">打开操作</button></header>
      <p v-if="governance.error" class="ac-boardroom-info-pane__error" role="status">{{ governance.error }}</p>
      <dl>
        <div><dt>创始人代理</dt><dd>{{ governance.principal }}</dd></div>
        <div><dt>当前模式</dt><dd>{{ governance.mode }}</dd></div>
        <div><dt>治理授权</dt><dd>{{ governance.authorization }}</dd></div>
        <div><dt>顾问发言</dt><dd>{{ governance.advisorCanSpeak ? "允许" : "停止" }}</dd></div>
      </dl>
      <p>讨论形成结论与决策意图，执行仍需通过 Founder OS 权限与审批门槛。</p>
    </section>
    <section>
      <header><h3>决策历史</h3><span>{{ governance.decisions.length }}</span></header>
      <div class="ac-boardroom-info-pane__links">
        <button v-for="decision in governance.decisions" :key="decision.id" type="button" @click="$emit('decision', decision.id)">
          <span><strong>{{ decision.title }}</strong><small>{{ decision.authority }} · {{ decision.status }}</small></span><UIcon name="i-lucide-chevron-right" />
        </button>
        <p v-if="!governance.decisions.length">当前会话还没有决策台账记录。</p>
      </div>
    </section>
    <section>
      <header><h3>治理资产</h3><span>{{ governance.artifacts.length }}</span></header>
      <div class="ac-boardroom-info-pane__links">
        <button v-for="artifact in governance.artifacts" :key="`${artifact.id}:${artifact.version}`" type="button" @click="$emit('artifact', artifact.id, artifact.version)">
          <span><strong>{{ artifact.title }}</strong><small>{{ artifact.meta }}</small></span><UIcon name="i-lucide-file-text" />
        </button>
        <p v-if="!governance.artifacts.length">当前范围没有引用资产。</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ac-boardroom-info-pane { display: grid; gap: 1px; background: var(--ac-boardroom-ink-100); }
.ac-boardroom-info-pane > section { padding: 16px; background: var(--ac-boardroom-paper); }
.ac-boardroom-info-pane__room { display: flex; align-items: flex-start; gap: 11px; }
.ac-boardroom-info-pane__room > span { display: grid; width: 36px; height: 36px; flex: none; place-items: center; border-radius: 50%; background: var(--ac-boardroom-accent-50); color: var(--ac-boardroom-warning); }
.ac-boardroom-info-pane__room strong { color: var(--ac-boardroom-ink-900); font-size: 14px; }
.ac-boardroom-info-pane__room p,
.ac-boardroom-info-pane section > p { margin: 4px 0 0; color: var(--ac-boardroom-ink-500); font-size: 10.5px; line-height: 1.55; }
.ac-boardroom-info-pane section > .ac-boardroom-info-pane__error { margin-bottom: 10px; border-radius: var(--ac-boardroom-radius-sm); padding: 8px; background: var(--ac-boardroom-danger-soft); color: var(--ac-boardroom-danger); }
.ac-boardroom-info-pane section > header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 11px; }
.ac-boardroom-info-pane h3 { margin: 0; color: var(--ac-boardroom-ink-700); font-size: 11px; font-weight: 760; letter-spacing: 0.06em; }
.ac-boardroom-info-pane section > header span { color: var(--ac-boardroom-ink-300); font-size: 10px; }
.ac-boardroom-info-pane section > header button { border: 0; background: transparent; color: var(--ac-boardroom-accent-strong); cursor: pointer; font-size: 10px; font-weight: 700; }
.ac-boardroom-info-pane__people { display: grid; gap: 10px; }
.ac-boardroom-info-pane__people article { display: flex; min-width: 0; align-items: center; gap: 10px; }
.ac-boardroom-info-pane__people article > div { display: grid; min-width: 0; }
.ac-boardroom-info-pane__people strong { color: var(--ac-boardroom-ink-700); font-size: 11.5px; }
.ac-boardroom-info-pane__people span { overflow: hidden; color: var(--ac-boardroom-ink-500); font-size: 9.5px; text-overflow: ellipsis; white-space: nowrap; }
.ac-boardroom-info-pane dl { display: grid; gap: 8px; margin: 0; }
.ac-boardroom-info-pane dl div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.ac-boardroom-info-pane dt { color: var(--ac-boardroom-ink-500); font-size: 10.5px; }
.ac-boardroom-info-pane dd { margin: 0; color: var(--ac-boardroom-ink-700); font-size: 10.5px; font-weight: 650; text-align: right; }
.ac-boardroom-info-pane__links { display: grid; gap: 5px; }
.ac-boardroom-info-pane__links button { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 8px; border: 0; border-radius: var(--ac-boardroom-radius-sm); padding: 8px; background: var(--ac-boardroom-sidebar); color: var(--ac-boardroom-ink-500); cursor: pointer; text-align: left; }
.ac-boardroom-info-pane__links button > span { display: grid; min-width: 0; }
.ac-boardroom-info-pane__links strong { overflow: hidden; color: var(--ac-boardroom-ink-700); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.ac-boardroom-info-pane__links small { overflow: hidden; color: var(--ac-boardroom-ink-500); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.ac-boardroom-info-pane__links svg { width: 14px; height: 14px; flex: none; }
.ac-boardroom-info-pane__links p { margin: 0; padding: 8px 0; color: var(--ac-boardroom-ink-300); font-size: 10.5px; }
@media (hover: hover) { .ac-boardroom-info-pane__links button:hover { background: var(--ac-boardroom-accent-50); color: var(--ac-boardroom-accent-ink); } }
</style>
