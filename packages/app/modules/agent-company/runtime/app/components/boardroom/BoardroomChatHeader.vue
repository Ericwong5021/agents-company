<script setup lang="ts">
import type { BoardroomParticipantVM, BoardroomRoomVM } from "../../types/boardroom"

const props = defineProps<{
  room: BoardroomRoomVM
  participants: BoardroomParticipantVM[]
  responding: BoardroomParticipantVM[]
  connection: string
  loading: boolean
}>()

defineEmits<{
  refresh: []
  openInfo: []
  openGovernance: []
}>()

const connectionLabel = computed(() => ({
  ready: "本地已连接",
  degraded: "部分可用",
  disconnected: "本地未连接",
  recovering: "正在恢复",
  connecting: "正在连接",
})[props.connection] ?? "连接状态未知")
</script>

<template>
  <header class="ac-boardroom-chat-header">
    <div class="ac-boardroom-chat-header__identity">
      <div class="ac-boardroom-chat-header__title">
        <span aria-hidden="true">★</span>
        <h1>{{ room.title }}</h1>
        <small>{{ room.status }}</small>
      </div>
      <p>{{ room.topic }}</p>
      <span v-if="responding.length" class="ac-boardroom-chat-header__responding" role="status">
        <i aria-hidden="true"><b /><b /><b /></i>{{ responding.map(agent => agent.name).join("、") }} 正在组织回复
      </span>
    </div>
    <button type="button" class="ac-boardroom-chat-header__members" aria-label="打开会话详情" @click="$emit('openInfo')">
      <AppAvatar
        v-for="agent in participants.slice(0, 4)"
        :key="agent.id"
        :name="agent.name"
        :size="30"
        :tone="agent.tone"
        :status="agent.status"
      />
      <span>我</span>
    </button>
    <div class="ac-boardroom-chat-header__actions">
      <NuxtLink
        to="/settings"
        class="ac-connection-pill ac-boardroom-chat-header__connection"
        :data-connection="connection"
        :aria-label="`本地连接状态：${connectionLabel}`"
      ><i aria-hidden="true" /><span>{{ connectionLabel }}</span></NuxtLink>
      <AppButton variant="ghost" size="icon" :loading="loading" aria-label="刷新董事会" @click="$emit('refresh')">
        <template #leading><UIcon name="i-lucide-refresh-cw" /></template>
      </AppButton>
      <AppButton variant="ghost" size="icon" aria-label="打开治理操作" @click="$emit('openGovernance')">
        <template #leading><UIcon name="i-lucide-shield-check" /></template>
      </AppButton>
      <AppButton variant="ghost" size="icon" aria-label="打开会话详情" @click="$emit('openInfo')">
        <template #leading><UIcon name="i-lucide-panel-right" /></template>
      </AppButton>
    </div>
  </header>
</template>

<style scoped>
.ac-boardroom-chat-header {
  display: grid;
  min-height: 76px;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 18px;
  border-bottom: 1px solid var(--ac-boardroom-ink-100);
  padding: 11px 18px 10px 22px;
  background: var(--ac-boardroom-paper);
}

.ac-boardroom-chat-header__identity {
  min-width: 0;
}

.ac-boardroom-chat-header__title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.ac-boardroom-chat-header__title > span {
  color: var(--ac-boardroom-warning);
  font-size: 14px;
}

.ac-boardroom-chat-header h1 {
  overflow: hidden;
  margin: 0;
  color: var(--ac-boardroom-ink-900);
  font-size: 18px;
  font-weight: 680;
  letter-spacing: -0.025em;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-boardroom-chat-header__title small {
  flex: none;
  border-radius: var(--ac-boardroom-radius-pill);
  padding: 3px 7px;
  background: var(--ac-boardroom-accent-50);
  color: var(--ac-boardroom-accent-ink);
  font-size: 10px;
  font-weight: 700;
}

.ac-boardroom-chat-header p,
.ac-boardroom-chat-header__responding {
  overflow: hidden;
  margin: 2px 0 0 22px;
  color: var(--ac-boardroom-ink-500);
  font-size: 11.5px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-boardroom-chat-header__responding {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ac-boardroom-thinking);
}

.ac-boardroom-chat-header__responding i {
  display: flex;
  gap: 2px;
}

.ac-boardroom-chat-header__responding b {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentcolor;
  animation: ac-boardroom-typing 900ms ease-in-out infinite alternate;
}

.ac-boardroom-chat-header__responding b:nth-child(2) { animation-delay: 120ms; }
.ac-boardroom-chat-header__responding b:nth-child(3) { animation-delay: 240ms; }

.ac-boardroom-chat-header__members {
  display: flex;
  align-items: center;
  border: 0;
  padding: 3px 6px;
  background: transparent;
  cursor: pointer;
}

.ac-boardroom-chat-header__members :deep(.ac-ui-avatar) {
  margin-left: -7px;
  box-shadow: 0 0 0 2px var(--ac-boardroom-paper);
}

.ac-boardroom-chat-header__members :deep(.ac-ui-avatar:first-child) {
  margin-left: 0;
}

.ac-boardroom-chat-header__members > span {
  display: grid;
  width: 30px;
  height: 30px;
  margin-left: -7px;
  place-items: center;
  border: 2px solid var(--ac-boardroom-paper);
  border-radius: 50%;
  background: var(--ac-boardroom-danger-soft);
  color: var(--ac-boardroom-danger);
  font-size: 10px;
  font-weight: 750;
}

.ac-boardroom-chat-header__actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.ac-boardroom-chat-header__connection {
  display: flex;
  min-height: 32px;
  align-items: center;
  gap: 6px;
  border-radius: var(--ac-boardroom-radius-pill);
  padding: 0 9px;
  background: var(--ac-boardroom-sidebar);
  color: var(--ac-boardroom-ink-500);
  font-size: 9.5px;
  font-weight: 650;
}

.ac-boardroom-chat-header__connection i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ac-boardroom-resting);
}

.ac-boardroom-chat-header__connection[data-connection="ready"] i { background: var(--ac-boardroom-success); }
.ac-boardroom-chat-header__connection[data-connection="degraded"] i,
.ac-boardroom-chat-header__connection[data-connection="recovering"] i { background: var(--ac-boardroom-warning); }
.ac-boardroom-chat-header__connection[data-connection="disconnected"] i { background: var(--ac-boardroom-danger); }

@keyframes ac-boardroom-typing {
  from { transform: translateY(1px); opacity: 0.35; }
  to { transform: translateY(-1px); opacity: 1; }
}

@media (max-width: 760px) {
  .ac-boardroom-chat-header {
    min-height: 66px;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    padding: 9px 8px 8px 14px;
  }

  .ac-boardroom-chat-header__members,
  .ac-boardroom-chat-header__connection span,
  .ac-boardroom-chat-header__actions > :first-child,
  .ac-boardroom-chat-header__actions > :nth-child(2),
  .ac-boardroom-chat-header__title small {
    display: none;
  }
}
</style>
