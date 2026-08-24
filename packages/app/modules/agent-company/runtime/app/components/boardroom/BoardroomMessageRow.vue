<script setup lang="ts">
import type { BoardroomEventVM } from "../../types/boardroom"
import BoardroomPollCard from "./BoardroomPollCard.vue"

const props = defineProps<{
  event: BoardroomEventVM
  highlighted?: boolean
}>()

defineEmits<{
  reply: []
  react: [emoji: string]
  vote: [optionID: string]
  jump: [messageID: string]
  retry: []
}>()

const reactionOpen = ref(false)
const quickReactions = ["👀", "✅", "🎯", "👍", "❤️"]
const tone = computed(() => props.event.kind === "human" ? "coral" : props.event.kind === "system" ? "ink" : "sky")
</script>

<template>
  <article
    :id="`boardroom-message-${event.id}`"
    class="ac-boardroom-message"
    :data-kind="event.kind"
    :data-highlighted="highlighted || undefined"
    tabindex="-1"
  >
    <AppAvatar :name="event.author" :size="36" :tone="tone" :show-status="false" />
    <div class="ac-boardroom-message__content">
      <header>
        <strong>{{ event.author }}</strong>
        <span v-if="event.role">{{ event.role }}</span>
        <time>{{ event.time }}</time>
      </header>
      <button v-if="event.reply" type="button" class="ac-boardroom-message__quote" @click="$emit('jump', event.reply.id)">
        <strong>{{ event.reply.author }}</strong>
        <span>{{ event.reply.body }}</span>
      </button>
      <div v-if="event.type === 'system'" class="ac-boardroom-message__system">
        <UIcon name="i-lucide-activity" />
        <div><p>{{ event.body }}</p><small v-if="event.detail">{{ event.detail }}</small></div>
      </div>
      <p v-else class="ac-boardroom-message__body">{{ event.body }}</p>
      <div v-if="event.mentions.length || event.resources.length" class="ac-boardroom-message__references">
        <span v-for="mention in event.mentions" :key="mention">@{{ mention }}</span>
        <span v-for="resource in event.resources" :key="`${resource.kind}:${resource.label}`">
          <UIcon name="i-lucide-paperclip" />{{ resource.label }}
        </span>
      </div>
      <BoardroomPollCard v-if="event.type === 'poll'" :event="event" @vote="$emit('vote', $event)" />
      <div class="ac-boardroom-message__footer">
        <button
          v-for="reaction in event.reactions"
          :key="reaction.emoji"
          type="button"
          class="ac-boardroom-message__reaction"
          :data-active="reaction.reacted || undefined"
          @click="$emit('react', reaction.emoji)"
        >{{ reaction.emoji }} <strong>{{ reaction.count }}</strong></button>
        <span v-if="event.activity" class="ac-boardroom-message__activity" :data-failed="event.deliveryStatus === 'failed' || undefined">
          {{ event.activity }}
        </span>
        <button v-if="event.deliveryStatus === 'failed'" type="button" class="ac-boardroom-message__retry" @click="$emit('retry')">重试</button>
      </div>
      <div v-if="event.kind !== 'system' && !event.id.startsWith('optimistic:')" class="ac-boardroom-message__actions">
        <div v-if="reactionOpen" class="ac-boardroom-message__reaction-menu">
          <button v-for="emoji in quickReactions" :key="emoji" type="button" @click="reactionOpen = false; $emit('react', emoji)">{{ emoji }}</button>
        </div>
        <button type="button" aria-label="添加表情回应" @click="reactionOpen = !reactionOpen"><UIcon name="i-lucide-smile-plus" /></button>
        <button type="button" aria-label="回复这条消息" @click="$emit('reply')"><UIcon name="i-lucide-reply" /></button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.ac-boardroom-message {
  position: relative;
  display: grid;
  contain-intrinsic-block-size: auto 76px;
  content-visibility: auto;
  grid-template-columns: 36px minmax(0, 1fr);
  gap: 11px;
  border-radius: var(--ac-boardroom-radius-sm);
  padding: 8px 10px;
  transition: background-color var(--ac-boardroom-motion-base);
}

.ac-boardroom-message[data-kind="human"] {
  margin-left: 28px;
  background: color-mix(in srgb, var(--ac-boardroom-accent-50) 54%, transparent);
}

.ac-boardroom-message[data-kind="system"] {
  grid-template-columns: 28px minmax(0, 1fr);
  margin-block: 5px;
  padding-block: 7px;
  color: var(--ac-boardroom-ink-500);
}

.ac-boardroom-message[data-kind="system"] :deep(.ac-ui-avatar) { width: 28px !important; height: 28px !important; }
.ac-boardroom-message[data-highlighted] { background: var(--ac-boardroom-accent-100); }
.ac-boardroom-message__content { position: relative; min-width: 0; }

.ac-boardroom-message header {
  display: flex;
  align-items: baseline;
  gap: 7px;
  line-height: 1.35;
}

.ac-boardroom-message header strong { color: var(--ac-boardroom-ink-900); font-size: 13px; font-weight: 720; }
.ac-boardroom-message header span { color: var(--ac-boardroom-ink-500); font-size: 10.5px; }
.ac-boardroom-message header time { color: var(--ac-boardroom-ink-300); font-size: 10px; }

.ac-boardroom-message__body {
  margin: 4px 0 0;
  color: var(--ac-boardroom-ink-700);
  font-size: 13.5px;
  line-height: 1.62;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ac-boardroom-message__quote {
  position: relative;
  display: grid;
  max-width: 520px;
  margin-top: 6px;
  border: 0;
  padding: 4px 9px 4px 15px;
  background: transparent;
  color: var(--ac-boardroom-ink-500);
  cursor: pointer;
  text-align: left;
}

.ac-boardroom-message__quote::before {
  position: absolute;
  top: 9px;
  left: 3px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ac-boardroom-accent-300);
  content: "";
}

.ac-boardroom-message__quote strong { color: var(--ac-boardroom-accent-ink); font-size: 10.5px; }
.ac-boardroom-message__quote span { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }

.ac-boardroom-message__system {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 3px;
  font-size: 12px;
}

.ac-boardroom-message__system > svg { width: 15px; height: 15px; margin-top: 2px; color: var(--ac-boardroom-accent-strong); }
.ac-boardroom-message__system p { margin: 0; line-height: 1.5; }
.ac-boardroom-message__system small { display: block; margin-top: 3px; color: var(--ac-boardroom-ink-300); line-height: 1.45; }

.ac-boardroom-message__references,
.ac-boardroom-message__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  margin-top: 7px;
}

.ac-boardroom-message__references span,
.ac-boardroom-message__reaction {
  display: inline-flex;
  min-height: 24px;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--ac-boardroom-ink-100);
  border-radius: var(--ac-boardroom-radius-pill);
  padding: 2px 8px;
  background: var(--ac-boardroom-cloud);
  color: var(--ac-boardroom-ink-500);
  font-size: 10.5px;
}

.ac-boardroom-message__references span:first-child { color: var(--ac-boardroom-accent-ink); background: var(--ac-boardroom-accent-50); }
.ac-boardroom-message__references svg { width: 12px; height: 12px; }
.ac-boardroom-message__reaction { cursor: pointer; }
.ac-boardroom-message__reaction[data-active] { border-color: var(--ac-boardroom-accent-300); background: var(--ac-boardroom-accent-50); color: var(--ac-boardroom-accent-ink); }

.ac-boardroom-message__activity { color: var(--ac-boardroom-thinking); font-size: 10.5px; }
.ac-boardroom-message__activity[data-failed] { color: var(--ac-boardroom-danger); }
.ac-boardroom-message__retry { border: 0; background: transparent; color: var(--ac-boardroom-accent-strong); cursor: pointer; font-size: 10.5px; font-weight: 700; }

.ac-boardroom-message__actions {
  position: absolute;
  top: -10px;
  right: 0;
  display: flex;
  gap: 2px;
  border: 1px solid var(--ac-boardroom-ink-100);
  border-radius: var(--ac-boardroom-radius-sm);
  padding: 2px;
  background: var(--ac-boardroom-cloud);
  box-shadow: var(--ac-boardroom-shadow-control);
  opacity: 0;
  transform: translateY(3px);
  transition: opacity var(--ac-boardroom-motion-base), transform var(--ac-boardroom-motion-base);
}

.ac-boardroom-message__actions > button,
.ac-boardroom-message__reaction-menu button {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 0;
  border-radius: var(--ac-boardroom-radius-xs);
  background: transparent;
  color: var(--ac-boardroom-ink-500);
  cursor: pointer;
}

.ac-boardroom-message__actions svg { width: 15px; height: 15px; }
.ac-boardroom-message__reaction-menu { position: absolute; right: 0; bottom: 34px; display: flex; border: 1px solid var(--ac-boardroom-ink-100); border-radius: var(--ac-boardroom-radius-sm); padding: 3px; background: var(--ac-boardroom-cloud); box-shadow: var(--ac-boardroom-shadow-popover); }

@media (hover: hover) {
  .ac-boardroom-message:hover { background: var(--ac-boardroom-sidebar); }
  .ac-boardroom-message:hover .ac-boardroom-message__actions,
  .ac-boardroom-message:focus-within .ac-boardroom-message__actions { opacity: 1; transform: translateY(0); }
  .ac-boardroom-message__actions > button:hover,
  .ac-boardroom-message__reaction-menu button:hover { background: var(--ac-boardroom-accent-50); color: var(--ac-boardroom-accent-ink); }
}

@media (max-width: 720px) {
  .ac-boardroom-message { padding-inline: 3px; }
  .ac-boardroom-message[data-kind="human"] { margin-left: 12px; }
  .ac-boardroom-message__actions { position: static; margin-top: 6px; width: fit-content; opacity: 1; transform: none; }
}
</style>
