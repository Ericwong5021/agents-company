<script setup lang="ts">
import type { BoardroomPollEventVM } from "../../types/boardroom"

defineProps<{ event: BoardroomPollEventVM }>()
defineEmits<{ vote: [optionID: string] }>()
</script>

<template>
  <section class="ac-boardroom-poll" aria-label="董事会投票">
    <header>
      <span><UIcon name="i-lucide-chart-no-axes-column" />董事会投票</span>
      <small>{{ event.poll.closed ? "已结束" : "正在投票" }}</small>
    </header>
    <h3>{{ event.poll.question }}</h3>
    <div>
      <button
        v-for="option in event.poll.options"
        :key="option.id"
        type="button"
        :data-selected="option.selected || undefined"
        :disabled="event.poll.closed"
        @click="$emit('vote', option.id)"
      >
        <span>{{ option.label }}</span>
        <strong>{{ option.count }}</strong>
      </button>
    </div>
    <p>{{ event.poll.multiple ? "可选择多个选项" : "请选择一个选项" }}</p>
  </section>
</template>

<style scoped>
.ac-boardroom-poll {
  width: min(520px, 100%);
  margin-top: 10px;
  overflow: hidden;
  border: 1px solid var(--ac-boardroom-ink-100);
  border-radius: var(--ac-boardroom-radius-md);
  background: var(--ac-boardroom-cloud);
  box-shadow: var(--ac-boardroom-shadow-control);
}

.ac-boardroom-poll header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--ac-boardroom-ink-100);
  padding: 9px 12px;
  background: var(--ac-boardroom-sidebar);
}

.ac-boardroom-poll header span {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ac-boardroom-ink-700);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0.04em;
}

.ac-boardroom-poll header svg {
  width: 15px;
  height: 15px;
  color: var(--ac-boardroom-accent-strong);
}

.ac-boardroom-poll header small,
.ac-boardroom-poll > p {
  color: var(--ac-boardroom-ink-500);
  font-size: 10.5px;
}

.ac-boardroom-poll h3 {
  margin: 0;
  padding: 13px 14px 9px;
  color: var(--ac-boardroom-ink-900);
  font-size: 14px;
  font-weight: 680;
  line-height: 1.5;
}

.ac-boardroom-poll > div {
  display: grid;
  gap: 7px;
  padding: 0 12px;
}

.ac-boardroom-poll > div button {
  display: flex;
  min-height: 38px;
  align-items: center;
  justify-content: space-between;
  border: 1px solid var(--ac-boardroom-ink-100);
  border-radius: var(--ac-boardroom-radius-sm);
  padding: 0 11px;
  background: var(--ac-boardroom-paper);
  color: var(--ac-boardroom-ink-700);
  cursor: pointer;
  font-size: 12.5px;
  transition: border-color var(--ac-boardroom-motion-base), background-color var(--ac-boardroom-motion-base), transform var(--ac-boardroom-motion-fast);
}

.ac-boardroom-poll > div button[data-selected] {
  border-color: var(--ac-boardroom-accent-300);
  background: var(--ac-boardroom-accent-50);
  color: var(--ac-boardroom-accent-ink);
}

.ac-boardroom-poll > div button:active:not(:disabled) { transform: scale(0.99); }
.ac-boardroom-poll > p { margin: 9px 14px 11px; }

@media (hover: hover) {
  .ac-boardroom-poll > div button:hover:not(:disabled) {
    border-color: var(--ac-boardroom-accent-300);
    background: var(--ac-boardroom-accent-50);
  }
}
</style>
