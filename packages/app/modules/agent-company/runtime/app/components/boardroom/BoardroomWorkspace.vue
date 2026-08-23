<script setup lang="ts">
import type {
  BoardroomArtifactVM,
  BoardroomComparisonInput,
  BoardroomConvergenceInput,
  BoardroomDecisionVM,
  BoardroomEventVM,
  BoardroomInterventionInput,
  BoardroomPane,
  BoardroomPollInput,
  BoardroomProjection,
  BoardroomSendInput,
  BoardroomSendResult,
  BoardroomShadowInput,
} from "../../types/boardroom"
import BoardroomChatHeader from "./BoardroomChatHeader.vue"
import BoardroomComposer from "./BoardroomComposer.vue"
import BoardroomMessageTimeline from "./BoardroomMessageTimeline.vue"
import BoardroomArtifactPane from "./panes/BoardroomArtifactPane.vue"
import BoardroomDecisionPane from "./panes/BoardroomDecisionPane.vue"
import BoardroomGovernancePane from "./panes/BoardroomGovernancePane.vue"
import BoardroomInfoPane from "./panes/BoardroomInfoPane.vue"
import BoardroomThreadPane from "./panes/BoardroomThreadPane.vue"

const props = defineProps<{
  projection: BoardroomProjection
  pane: BoardroomPane
  thread?: { original: BoardroomEventVM; replies: BoardroomEventVM[] }
  decision?: BoardroomDecisionVM
  artifact?: BoardroomArtifactVM
  governanceOptions: {
    roomProjectID?: string
    companyGoal?: string
    projects: { id: string; title: string; status: string }[]
    agents: { id: string; name: string; role: string }[]
    messages: { id: string; author: string; body: string }[]
  }
  boardThreadID?: string
  loading: boolean
  projectMessagesLoading: boolean
  actionMessage: string
  sendResult?: BoardroomSendResult
}>()

const emit = defineEmits<{
  refresh: []
  send: [input: BoardroomSendInput]
  retry: [messageID: string]
  promote: [requestID: string]
  react: [messageID: string, emoji: string]
  vote: [messageID: string, optionID: string]
  poll: [input: BoardroomPollInput]
  read: [sequence: number]
  pane: [pane: BoardroomPane]
  intervene: [input: BoardroomInterventionInput]
  shadow: [input: BoardroomShadowInput]
  compare: [input: BoardroomComparisonInput]
  converge: [input: BoardroomConvergenceInput]
}>()

const contextOpen = computed(() => props.pane.kind !== "closed")
const contextTitle = computed(() => {
  if (props.pane.kind === "thread") return "线程回复"
  if (props.pane.kind === "governance") return "治理操作"
  if (props.pane.kind === "decision") return "决策详情"
  if (props.pane.kind === "artifact") return "治理资产"
  return "会话详情"
})
const contextSubtitle = computed(() => {
  if (props.pane.kind === "thread") return props.thread ? `${props.thread.replies.length} 条回复` : "原始消息不可用"
  if (props.pane.kind === "governance") return "权限、建议与人工接管"
  if (props.pane.kind === "decision") return props.decision?.status ?? "决策台账"
  if (props.pane.kind === "artifact") return props.artifact?.meta ?? "版本化资产"
  return props.projection.room.topic
})
const contextIcon = computed(() => ({
  thread: "i-lucide-messages-square",
  governance: "i-lucide-shield-check",
  decision: "i-lucide-landmark",
  artifact: "i-lucide-file-text",
  info: "i-lucide-info",
  closed: "i-lucide-panel-right",
})[props.pane.kind])

function command(command: "intervene" | "shadow" | "decision") {
  if (command === "intervene") emit("pane", { kind: "governance", section: "intervention" })
  if (command === "shadow") emit("pane", { kind: "governance", section: "shadow" })
  if (command === "decision") emit("pane", { kind: "info" })
}
</script>

<template>
  <section class="ac-boardroom-workspace" :data-context-open="contextOpen || undefined" lang="zh">
    <main class="ac-boardroom-workspace__chat">
      <BoardroomChatHeader
        :room="projection.room"
        :participants="projection.participants"
        :responding="projection.responding"
        :connection="projection.connection"
        :loading="loading"
        @refresh="emit('refresh')"
        @open-info="emit('pane', { kind: 'info' })"
        @open-governance="emit('pane', { kind: 'governance' })"
      />
      <div v-if="projection.error" class="ac-boardroom-workspace__error" role="alert">
        <UIcon name="i-lucide-circle-alert" />{{ projection.error }}
      </div>
      <div v-else-if="projection.notice" class="ac-boardroom-workspace__notice" role="status">
        <UIcon name="i-lucide-info" />{{ projection.notice }}
      </div>
      <BoardroomMessageTimeline
        :room-id="projection.room.id"
        :events="projection.timeline"
        :loading="projectMessagesLoading"
        @reply="emit('pane', { kind: 'thread', messageID: $event })"
        @react="(messageID, emoji) => emit('react', messageID, emoji)"
        @vote="(messageID, optionID) => emit('vote', messageID, optionID)"
        @retry="emit('retry', $event)"
        @read="emit('read', $event)"
      />
      <BoardroomComposer
        :room="projection.room"
        :participants="projection.participants"
        :send-result="sendResult"
        @send="emit('send', $event)"
        @promote="emit('promote', $event)"
        @poll="emit('poll', $event)"
        @command="command"
      />
    </main>
    <ContextPane
      :open="contextOpen"
      :wide="pane.kind === 'artifact'"
      :title="contextTitle"
      :subtitle="contextSubtitle"
      :icon="contextIcon"
      @close="emit('pane', { kind: 'closed' })"
    >
      <BoardroomInfoPane
        v-if="pane.kind === 'info'"
        :room="projection.room"
        :participants="projection.participants"
        :governance="projection.governance"
        @decision="emit('pane', { kind: 'decision', decisionID: $event })"
        @artifact="(artifactID, version) => emit('pane', { kind: 'artifact', artifactID, version })"
        @governance="emit('pane', { kind: 'governance' })"
      />
      <BoardroomThreadPane
        v-else-if="pane.kind === 'thread' && thread"
        :room="projection.room"
        :participants="projection.participants"
        :original="thread.original"
        :replies="thread.replies"
        :send-result="sendResult"
        @send="emit('send', $event)"
        @promote="emit('promote', $event)"
        @react="(messageID, emoji) => emit('react', messageID, emoji)"
      />
      <BoardroomGovernancePane
        v-else-if="pane.kind === 'governance'"
        :governance="projection.governance"
        :room-project-i-d="governanceOptions.roomProjectID"
        :company-goal="governanceOptions.companyGoal"
        :projects="governanceOptions.projects"
        :agents="governanceOptions.agents"
        :messages="governanceOptions.messages"
        :board-thread-i-d="boardThreadID"
        :loading="loading"
        :message="actionMessage"
        :section="pane.section"
        @intervene="emit('intervene', $event)"
        @shadow="emit('shadow', $event)"
        @compare="emit('compare', $event)"
        @converge="emit('converge', $event)"
      />
      <BoardroomDecisionPane v-else-if="pane.kind === 'decision' && decision" :decision="decision" />
      <BoardroomArtifactPane v-else-if="pane.kind === 'artifact' && artifact" :artifact="artifact" />
      <div v-else class="ac-boardroom-workspace__missing">当前上下文已更新，请重新选择。</div>
    </ContextPane>
  </section>
</template>

<style scoped>
.ac-boardroom-workspace {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(0, 1fr);
  overflow: hidden;
  background: var(--ac-boardroom-paper);
}

.ac-boardroom-workspace[data-context-open] { grid-template-columns: minmax(0, 1fr) 420px; }
.ac-boardroom-workspace[data-context-open] :deep(.ac-context-pane[data-wide]) { width: clamp(420px, 42vw, 640px); }
.ac-boardroom-workspace[data-context-open]:has(.ac-context-pane[data-wide]) { grid-template-columns: minmax(0, 1fr) clamp(420px, 42vw, 640px); }
.ac-boardroom-workspace__chat { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; background: var(--ac-boardroom-paper); }
.ac-boardroom-workspace__error { display: flex; align-items: center; gap: 7px; border-bottom: 1px solid color-mix(in srgb, var(--ac-boardroom-danger) 25%, transparent); padding: 8px 16px; background: var(--ac-boardroom-danger-soft); color: var(--ac-boardroom-danger); font-size: 10.5px; }
.ac-boardroom-workspace__error svg { width: 14px; height: 14px; flex: none; }
.ac-boardroom-workspace__notice { display: flex; align-items: center; gap: 7px; border-bottom: 1px solid color-mix(in srgb, var(--ac-boardroom-warning) 30%, transparent); padding: 6px 16px; background: color-mix(in srgb, var(--ac-boardroom-warning) 12%, var(--ac-boardroom-paper)); color: var(--ac-boardroom-ink-500); font-size: 9.5px; }
.ac-boardroom-workspace__notice svg { width: 13px; height: 13px; flex: none; color: var(--ac-boardroom-warning); }
.ac-boardroom-workspace__missing { padding: 28px 18px; color: var(--ac-boardroom-ink-500); font-size: 11px; text-align: center; }

@media (max-width: 1180px) {
  .ac-boardroom-workspace[data-context-open],
  .ac-boardroom-workspace[data-context-open]:has(.ac-context-pane[data-wide]) { grid-template-columns: minmax(0, 1fr); }
}
</style>
