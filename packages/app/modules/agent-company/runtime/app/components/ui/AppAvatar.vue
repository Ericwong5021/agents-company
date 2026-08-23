<!-- Adapted from yetone/cumora@5dbbdee under the MIT License. Reimplemented for Vue/Nuxt and AgentCompany domain models. -->
<script setup lang="ts">
import type { CSSProperties } from "vue"

const props = withDefaults(
  defineProps<{
    name: string
    src?: string
    alt?: string
    size?: number
    tone?: "sky" | "coral" | "gold" | "ink"
    status?: "available" | "working" | "thinking" | "waiting" | "resting" | "offline"
    showStatus?: boolean
    loading?: "eager" | "lazy"
  }>(),
  {
    src: undefined,
    alt: undefined,
    size: 44,
    tone: "sky",
    status: "offline",
    showStatus: true,
    loading: "lazy",
  },
)

const failedSource = ref<string>()
const showImage = computed(() => Boolean(props.src && failedSource.value !== props.src))
const initial = computed(() => Array.from(props.name.trim())[0]?.toLocaleUpperCase() || "?")
const style = computed<CSSProperties>(() => {
  const dotSize = Math.max(10, Math.round(props.size * 0.27))
  return {
    "--ac-avatar-size": `${props.size}px`,
    "--ac-avatar-font-size": `${Math.round(props.size * 0.36)}px`,
    "--ac-avatar-status-size": `${dotSize}px`,
    "--ac-avatar-status-ring": `${Math.max(2, dotSize / 5)}px`,
  }
})
</script>

<template>
  <span class="ac-boardroom ac-ui-avatar" :data-tone="tone" :style="style">
    <img
      v-if="showImage"
      class="ac-ui-avatar__image"
      :src="src"
      :alt="alt ?? name"
      :width="size"
      :height="size"
      :loading="loading"
      @error="failedSource = src"
    />
    <span v-else class="ac-ui-avatar__fallback" aria-hidden="true">{{ initial }}</span>
    <span v-if="showStatus" class="ac-ui-avatar__status" :data-status="status" :aria-label="status" role="img" />
  </span>
</template>

<style scoped>
.ac-ui-avatar {
  position: relative;
  display: inline-grid;
  width: var(--ac-avatar-size);
  height: var(--ac-avatar-size);
  flex: none;
  place-items: center;
  overflow: visible;
  border-radius: var(--ac-boardroom-radius-pill);
  background: var(--ac-boardroom-avatar-sky);
  color: var(--ac-boardroom-cloud);
  font: 650 var(--ac-avatar-font-size) / 1 var(--ac-boardroom-font-sans);
  letter-spacing: -0.02em;
}

.ac-ui-avatar[data-tone="coral"] {
  background: var(--ac-boardroom-avatar-coral);
}

.ac-ui-avatar[data-tone="gold"] {
  background: var(--ac-boardroom-avatar-gold);
}

.ac-ui-avatar[data-tone="ink"] {
  background: var(--ac-boardroom-avatar-ink);
}

.ac-ui-avatar__image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
  outline: 1px solid color-mix(in srgb, var(--ac-boardroom-ink-900) 10%, transparent);
  outline-offset: -1px;
}

.ac-ui-avatar__status {
  position: absolute;
  z-index: 1;
  right: -1px;
  bottom: -1px;
  width: var(--ac-avatar-status-size);
  height: var(--ac-avatar-status-size);
  border-radius: var(--ac-boardroom-radius-pill);
  background: var(--ac-boardroom-resting);
  box-shadow: 0 0 0 var(--ac-avatar-status-ring) var(--ac-boardroom-avatar-ring);
}

.ac-ui-avatar__status[data-status="available"] {
  background: var(--ac-boardroom-success);
}

.ac-ui-avatar__status[data-status="working"] {
  background: var(--ac-boardroom-warning);
}

.ac-ui-avatar__status[data-status="thinking"] {
  background: var(--ac-boardroom-thinking);
}

.ac-ui-avatar__status[data-status="waiting"] {
  background: var(--ac-boardroom-danger);
}

.ac-ui-avatar__status[data-status="resting"],
.ac-ui-avatar__status[data-status="offline"] {
  background: var(--ac-boardroom-resting);
}
</style>
