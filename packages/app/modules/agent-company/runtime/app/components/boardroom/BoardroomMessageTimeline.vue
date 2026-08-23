<script setup lang="ts">
import type { BoardroomEventVM } from "../../types/boardroom"
import BoardroomMessageRow from "./BoardroomMessageRow.vue"

const props = defineProps<{
  roomId: string
  events: BoardroomEventVM[]
  loading?: boolean
}>()

const emit = defineEmits<{
  reply: [messageID: string]
  react: [messageID: string, emoji: string]
  vote: [messageID: string, optionID: string]
  retry: [messageID: string]
  read: [sequence: number]
}>()

const feed = ref<HTMLElement>()
const readSequenceAtOpen = ref(0)
const lastMarkedSequence = ref(0)
const knownIDs = ref(new Set<string>())
const followLatest = ref(true)
const initialScrollDone = ref(false)
const newMessageCount = ref(0)
const highlightedID = ref("")

function readKey() {
  return `agent-company:board-read:${props.roomId}`
}

function nearLatest() {
  if (!feed.value) return true
  return feed.value.scrollHeight - feed.value.scrollTop - feed.value.clientHeight < 180
}

function markLatestRead() {
  const sequence = props.events.at(-1)?.sequence
  if (sequence === undefined || sequence <= lastMarkedSequence.value) return
  lastMarkedSequence.value = sequence
  emit("read", sequence)
}

function scrollToLatest(force = false) {
  if (!feed.value || !force && initialScrollDone.value && !followLatest.value) return
  feed.value.scrollTop = feed.value.scrollHeight
  initialScrollDone.value = true
  followLatest.value = true
  newMessageCount.value = 0
  markLatestRead()
}

function onScroll() {
  followLatest.value = nearLatest()
  if (!followLatest.value) return
  newMessageCount.value = 0
  markLatestRead()
}

function startsUnread(index: number) {
  const message = props.events[index]
  const previous = props.events[index - 1]
  return Boolean(message && message.sequence > readSequenceAtOpen.value && (!previous || previous.sequence <= readSequenceAtOpen.value))
}

function jump(messageID: string) {
  highlightedID.value = messageID
  const element = document.getElementById(`boardroom-message-${messageID}`)
  element?.scrollIntoView({ behavior: "smooth", block: "center" })
  element?.focus({ preventScroll: true })
  window.setTimeout(() => {
    if (highlightedID.value === messageID) highlightedID.value = ""
  }, 1600)
}

function initializeRoom() {
  readSequenceAtOpen.value = import.meta.client ? Number(localStorage.getItem(readKey())) || 0 : 0
  lastMarkedSequence.value = readSequenceAtOpen.value
  knownIDs.value = new Set(props.events.map(event => event.id))
  initialScrollDone.value = false
  followLatest.value = true
  newMessageCount.value = 0
  nextTick(() => scrollToLatest(true))
}

onMounted(initializeRoom)
watch(() => props.roomId, initializeRoom)
watch(() => props.events.map(event => event.id), (ids) => {
  const added = ids.filter(id => !knownIDs.value.has(id)).length
  ids.forEach(id => knownIDs.value.add(id))
  if (!added) return
  if (followLatest.value) {
    nextTick(() => scrollToLatest(true))
    return
  }
  newMessageCount.value += added
}, { deep: true })
</script>

<template>
  <div class="ac-boardroom-timeline">
    <div ref="feed" class="ac-boardroom-timeline__feed" role="region" aria-label="消息时间线" @scroll.passive="onScroll">
      <div class="ac-boardroom-timeline__inner" role="log" aria-live="polite" aria-relevant="additions">
        <template v-for="(event, index) in events" :key="event.id">
          <div v-if="startsUnread(index)" class="ac-boardroom-timeline__unread"><span>未读消息</span></div>
          <BoardroomMessageRow
            :event="event"
            :highlighted="highlightedID === event.id"
            @reply="emit('reply', event.id)"
            @react="emit('react', event.id, $event)"
            @vote="emit('vote', event.id, $event)"
            @jump="jump"
            @retry="emit('retry', event.id)"
          />
        </template>
        <div v-if="loading && !events.length" class="ac-boardroom-timeline__loading" aria-label="正在加载消息">
          <span v-for="index in 4" :key="index" />
        </div>
        <div v-else-if="!events.length" class="ac-boardroom-timeline__empty">
          <span><UIcon name="i-lucide-messages-square" /></span>
          <strong>这间会议室还很安静</strong>
          <p>发出第一条消息，董事会成员会根据真实状态独立判断是否回应。</p>
        </div>
      </div>
    </div>
    <button v-if="newMessageCount" type="button" class="ac-boardroom-timeline__latest" @click="scrollToLatest(true)">
      <UIcon name="i-lucide-arrow-down" />{{ newMessageCount }} 条新消息
    </button>
  </div>
</template>

<style scoped>
.ac-boardroom-timeline {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: hidden;
  background: var(--ac-boardroom-paper);
}

.ac-boardroom-timeline__feed {
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: var(--ac-boardroom-scrollbar) transparent;
  scrollbar-width: thin;
}

.ac-boardroom-timeline__inner {
  width: min(760px, 100%);
  min-height: 100%;
  margin: 0 auto;
  padding: 18px 22px 24px;
}

.ac-boardroom-timeline__unread {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 0;
  color: var(--ac-boardroom-danger);
  font-size: 10px;
  font-weight: 750;
}

.ac-boardroom-timeline__unread::before,
.ac-boardroom-timeline__unread::after {
  height: 1px;
  flex: 1;
  background: color-mix(in srgb, var(--ac-boardroom-danger) 35%, transparent);
  content: "";
}

.ac-boardroom-timeline__latest {
  position: absolute;
  right: 22px;
  bottom: 16px;
  display: flex;
  min-height: 34px;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--ac-boardroom-accent-200);
  border-radius: var(--ac-boardroom-radius-pill);
  padding: 0 12px;
  background: var(--ac-boardroom-cloud);
  color: var(--ac-boardroom-accent-ink);
  box-shadow: var(--ac-boardroom-shadow-popover);
  cursor: pointer;
  font-size: 11px;
  font-weight: 700;
}

.ac-boardroom-timeline__latest svg { width: 14px; height: 14px; }

.ac-boardroom-timeline__empty {
  display: grid;
  min-height: 380px;
  place-items: center;
  align-content: center;
  padding: 36px;
  text-align: center;
}

.ac-boardroom-timeline__empty > span {
  display: grid;
  width: 50px;
  height: 50px;
  margin-bottom: 14px;
  place-items: center;
  border-radius: 50%;
  background: var(--ac-boardroom-accent-50);
  color: var(--ac-boardroom-accent-strong);
}

.ac-boardroom-timeline__empty svg { width: 22px; height: 22px; }
.ac-boardroom-timeline__empty strong { color: var(--ac-boardroom-ink-700); font-size: 13px; }
.ac-boardroom-timeline__empty p { max-width: 330px; margin: 6px 0 0; color: var(--ac-boardroom-ink-500); font-size: 11.5px; line-height: 1.55; }

.ac-boardroom-timeline__loading { display: grid; gap: 18px; padding: 20px 0; }
.ac-boardroom-timeline__loading span { width: min(580px, 80%); height: 54px; border-radius: var(--ac-boardroom-radius-sm); background: linear-gradient(90deg, var(--ac-boardroom-sidebar), var(--ac-boardroom-ink-100), var(--ac-boardroom-sidebar)); background-size: 200% 100%; animation: ac-boardroom-skeleton 1.2s linear infinite; }
.ac-boardroom-timeline__loading span:nth-child(even) { width: min(480px, 68%); margin-left: 48px; }

@keyframes ac-boardroom-skeleton { to { background-position: -200% 0; } }

@media (max-width: 720px) {
  .ac-boardroom-timeline__inner { padding: 12px 10px 18px; }
  .ac-boardroom-timeline__latest { right: 12px; bottom: 10px; }
}
</style>
