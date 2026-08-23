<script setup lang="ts">
import type { BoardroomEventVM, BoardroomParticipantVM, BoardroomRoomVM, BoardroomSendInput, BoardroomSendResult } from "../../../types/boardroom"
import BoardroomMessageRow from "../BoardroomMessageRow.vue"
import BoardroomComposer from "../BoardroomComposer.vue"

defineProps<{
  room: BoardroomRoomVM
  participants: BoardroomParticipantVM[]
  original: BoardroomEventVM
  replies: BoardroomEventVM[]
  sendResult?: BoardroomSendResult
}>()

defineEmits<{
  send: [input: BoardroomSendInput]
  promote: [requestID: string]
  react: [messageID: string, emoji: string]
}>()
</script>

<template>
  <div class="ac-boardroom-thread-pane">
    <div class="ac-boardroom-thread-pane__messages">
      <BoardroomMessageRow :event="original" @react="$emit('react', original.id, $event)" />
      <div class="ac-boardroom-thread-pane__divider"><span>{{ replies.length }} 条回复</span></div>
      <BoardroomMessageRow v-for="reply in replies" :key="reply.id" :event="reply" @react="$emit('react', reply.id, $event)" />
      <p v-if="!replies.length">暂无线程回复。</p>
    </div>
    <BoardroomComposer
      compact
      :room="room"
      :participants="participants"
      :send-result="sendResult"
      :draft-scope="`thread:${original.id}`"
      :reply-to="{ id: original.id, author: original.author, body: original.body }"
      @send="$emit('send', $event)"
      @promote="$emit('promote', $event)"
    />
  </div>
</template>

<style scoped>
.ac-boardroom-thread-pane { display: flex; min-height: 100%; flex-direction: column; }
.ac-boardroom-thread-pane__messages { display: grid; gap: 6px; min-height: 0; flex: 1; padding: 12px 8px 18px; }
.ac-boardroom-thread-pane__divider { display: flex; align-items: center; gap: 8px; margin: 6px 10px; color: var(--ac-boardroom-ink-300); font-size: 9.5px; }
.ac-boardroom-thread-pane__divider::after { height: 1px; flex: 1; background: var(--ac-boardroom-ink-100); content: ""; }
.ac-boardroom-thread-pane__messages > p { margin: 0; padding: 16px; color: var(--ac-boardroom-ink-300); font-size: 10.5px; text-align: center; }
</style>
