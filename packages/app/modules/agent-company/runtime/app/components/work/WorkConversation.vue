<script setup lang="ts">
import type {
  BoardroomPollInput,
  BoardroomProjection,
  BoardroomSendInput,
  BoardroomSendResult,
} from "../../types/boardroom"
import type { WorkRoomContextVM } from "../../types/work-room"
import BoardroomChatHeader from "../boardroom/BoardroomChatHeader.vue"
import BoardroomComposer from "../boardroom/BoardroomComposer.vue"
import BoardroomMessageTimeline from "../boardroom/BoardroomMessageTimeline.vue"
import WorkApprovalCard from "./WorkApprovalCard.vue"
import WorkArtifactCard from "./WorkArtifactCard.vue"
import WorkExecutionTimeline from "./WorkExecutionTimeline.vue"
import WorkTaskCard from "./WorkTaskCard.vue"

const props = defineProps<{
  projection: BoardroomProjection
  context: WorkRoomContextVM
  loading: boolean
  messagesLoading: boolean
  sendResult?: BoardroomSendResult
  phase: string
  progressLabel: string
  statusLabel: string
}>()

const emit = defineEmits<{
  refresh: []
  send: [BoardroomSendInput]
  retry: [string]
  promote: [string]
  react: [string, string]
  vote: [string, string]
  poll: [BoardroomPollInput]
  read: [number]
  panel: ["task" | "approval" | "artifact" | "thread" | "diagnostics" | "goal_brief", string?]
}>()

const signalCount = computed(() => props.context.tasks.length + props.context.approvals.length + props.context.artifacts.length + (props.context.execution.length ? 1 : 0))
const signalsOpen = ref(true)

function command(command: "intervene" | "shadow" | "decision") {
  emit("panel", command === "decision" ? "goal_brief" : "diagnostics")
}
</script>

<template>
  <section class="ac-boardroom ac-work-conversation" aria-label="项目协作会话">
    <BoardroomChatHeader
      :room="projection.room"
      :participants="projection.participants"
      :responding="projection.responding"
      :connection="projection.connection"
      :loading="loading"
      @refresh="emit('refresh')"
      @open-info="emit('panel', 'goal_brief')"
      @open-governance="emit('panel', 'diagnostics')"
    />
    <div class="ac-work-conversation__progress">
      <span>{{ phase }}</span><strong>{{ progressLabel }}</strong><em>{{ statusLabel }}</em>
    </div>
    <div v-if="projection.error" class="ac-work-conversation__status" data-tone="error"><UIcon name="i-lucide-circle-alert" />{{ projection.error }}</div>
    <div v-else-if="projection.notice" class="ac-work-conversation__status"><UIcon name="i-lucide-info" />{{ projection.notice }}</div>

    <div v-if="signalCount" class="ac-work-signals" :data-open="signalsOpen || undefined">
      <button type="button" class="ac-work-signals__toggle" :aria-expanded="signalsOpen" @click="signalsOpen = !signalsOpen">
        <span><UIcon name="i-lucide-pin" />当前工作上下文</span><small>{{ signalCount }} 项真实信号</small><UIcon :name="signalsOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
      </button>
      <div v-if="signalsOpen" class="ac-work-signals__grid">
        <WorkApprovalCard v-if="context.approvals[0]" :approval="context.approvals[0]" @open="emit('panel', 'approval', $event)" />
        <WorkTaskCard v-if="context.tasks[0]" :task="context.tasks[0]" @open="emit('panel', 'task', $event)" />
        <WorkArtifactCard v-if="context.artifacts[0]" :artifact="context.artifacts[0]" @open="emit('panel', 'artifact', $event)" />
        <WorkExecutionTimeline :steps="context.execution" @open="emit('panel', 'diagnostics')" />
      </div>
    </div>

    <BoardroomMessageTimeline
      :room-id="projection.room.id"
      :events="projection.timeline"
      :loading="messagesLoading"
      @reply="emit('panel', 'thread', $event)"
      @react="(messageID, emoji) => emit('react', messageID, emoji)"
      @vote="(messageID, optionID) => emit('vote', messageID, optionID)"
      @retry="emit('retry', $event)"
      @read="emit('read', $event)"
    />
    <BoardroomComposer
      :room="projection.room"
      :participants="projection.participants"
      :send-result="sendResult"
      command-scope="project"
      @send="emit('send', $event)"
      @promote="emit('promote', $event)"
      @poll="emit('poll', $event)"
      @command="command"
    />
  </section>
</template>

<style scoped>
.ac-work-conversation { display: flex; min-width: 0; height: clamp(620px, 78vh, 860px); min-height: 0; flex-direction: column; overflow: hidden; border: 1px solid var(--ac-boardroom-ink-100); border-radius: var(--ac-boardroom-radius-xl); background: var(--ac-boardroom-paper); box-shadow: var(--ac-boardroom-shadow-popover); }
.ac-work-conversation__status { display: flex; align-items: center; gap: 7px; border-bottom: 1px solid var(--ac-boardroom-ink-100); padding: 7px 14px; background: var(--ac-boardroom-accent-50); color: var(--ac-boardroom-ink-500); font-size: 10px; }
.ac-work-conversation__status[data-tone="error"] { background: var(--ac-boardroom-danger-soft); color: var(--ac-boardroom-danger); }
.ac-work-conversation__progress { display: flex; align-items: center; gap: 9px; min-height: 36px; border-bottom: 1px solid var(--ac-boardroom-ink-100); padding: 0 16px; color: var(--ac-boardroom-ink-500); font-size: 10px; }
.ac-work-conversation__progress strong { color: var(--ac-boardroom-ink-700); font-size: 11px; }
.ac-work-conversation__progress em { margin-left: auto; padding: 4px 8px; border-radius: var(--ac-boardroom-radius-pill); background: var(--ac-boardroom-accent-50); color: var(--ac-boardroom-accent-ink); font-style: normal; font-weight: 700; }
.ac-work-signals { border-bottom: 1px solid var(--ac-boardroom-ink-100); background: var(--ac-boardroom-sidebar); }
.ac-work-signals__toggle { display: grid; grid-template-columns: minmax(0, 1fr) auto 16px; align-items: center; gap: 10px; width: 100%; min-height: 38px; border: 0; padding: 0 16px; background: transparent; color: var(--ac-boardroom-ink-500); text-align: left; }
.ac-work-signals__toggle > span { display: flex; align-items: center; gap: 7px; color: var(--ac-boardroom-ink-700); font-size: 10.5px; font-weight: 720; }
.ac-work-signals__toggle small { font-size: 9.5px; }
.ac-work-signals__grid { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 8px; padding: 0 12px 12px; overflow-x: auto; }
@media (max-width: 720px) { .ac-work-conversation { height: calc(100dvh - 205px); border: 0; border-radius: 0; box-shadow: none; } .ac-work-signals__grid { grid-template-columns: repeat(4, 240px); } }
</style>
