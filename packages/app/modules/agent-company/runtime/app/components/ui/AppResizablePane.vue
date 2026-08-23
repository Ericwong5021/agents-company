<!-- Adapted from yetone/cumora@5dbbdee under the MIT License. Reimplemented for Vue/Nuxt and AgentCompany domain models. -->
<script lang="ts">
let documentResizeOwner: symbol | undefined
let documentResizeCursor = ""
let documentResizeUserSelect = ""
</script>

<script setup lang="ts">
import type { CSSProperties } from "vue"

const props = withDefaults(
  defineProps<{
    min?: number
    max?: number
    side?: "left" | "right"
    step?: number
    disabled?: boolean
    label?: string
  }>(),
  {
    min: 240,
    max: 520,
    side: "left",
    step: 16,
    disabled: false,
    label: "调整面板宽度",
  },
)

const emit = defineEmits<{
  resizeStart: [size: number]
  resizeEnd: [size: number]
}>()
const size = defineModel<number>({ required: true })
const dragging = ref(false)
let startX = 0
let startSize = 0
const resizeOwner = Symbol()
let activePointerID: number | undefined
let activeHandle: HTMLElement | undefined

const clampedSize = computed(() => Math.min(props.max, Math.max(props.min, size.value)))
const style = computed<CSSProperties>(() => ({
  width: `${clampedSize.value}px`,
}))

function setSize(nextSize: number) {
  size.value = Math.min(props.max, Math.max(props.min, Math.round(nextSize)))
}

function restoreDocumentState() {
  if (documentResizeOwner !== resizeOwner) return
  document.body.style.cursor = documentResizeCursor
  document.body.style.userSelect = documentResizeUserSelect
  documentResizeOwner = undefined
}

function stopResize(event?: PointerEvent) {
  if (!dragging.value) return
  if (event && event.pointerId !== activePointerID) return
  dragging.value = false
  window.removeEventListener("pointermove", resize)
  window.removeEventListener("pointerup", stopResize)
  window.removeEventListener("pointercancel", stopResize)
  if (activePointerID !== undefined && activeHandle?.hasPointerCapture(activePointerID)) activeHandle.releasePointerCapture(activePointerID)
  activePointerID = undefined
  activeHandle = undefined
  restoreDocumentState()
  emit("resizeEnd", size.value)
}

function resize(event: PointerEvent) {
  if (event.pointerId !== activePointerID) return
  const delta = event.clientX - startX
  setSize(startSize + (props.side === "left" ? delta : -delta))
}

function startResize(event: PointerEvent) {
  if (props.disabled || dragging.value || documentResizeOwner) return
  event.preventDefault()
  dragging.value = true
  documentResizeOwner = resizeOwner
  activePointerID = event.pointerId
  activeHandle = event.currentTarget as HTMLElement
  activeHandle.setPointerCapture(activePointerID)
  startX = event.clientX
  startSize = clampedSize.value
  documentResizeCursor = document.body.style.cursor
  documentResizeUserSelect = document.body.style.userSelect
  document.body.style.cursor = "col-resize"
  document.body.style.userSelect = "none"
  window.addEventListener("pointermove", resize)
  window.addEventListener("pointerup", stopResize)
  window.addEventListener("pointercancel", stopResize)
  emit("resizeStart", startSize)
}

function resizeWithKeyboard(event: KeyboardEvent) {
  if (props.disabled) return
  if (event.key === "Home") setSize(props.min)
  if (event.key === "End") setSize(props.max)
  if (event.key === "ArrowLeft") setSize(size.value + (props.side === "left" ? -props.step : props.step))
  if (event.key === "ArrowRight") setSize(size.value + (props.side === "left" ? props.step : -props.step))
  if (!["Home", "End", "ArrowLeft", "ArrowRight"].includes(event.key)) return
  event.preventDefault()
  emit("resizeEnd", size.value)
}

onBeforeUnmount(() => {
  window.removeEventListener("pointermove", resize)
  window.removeEventListener("pointerup", stopResize)
  window.removeEventListener("pointercancel", stopResize)
  if (dragging.value) restoreDocumentState()
})
</script>

<template>
  <section
    class="ac-boardroom ac-ui-resizable-pane"
    :data-side="side"
    :data-resizing="dragging || undefined"
    :style="style"
  >
    <slot :size="clampedSize" />
    <button
      class="ac-ui-resizable-pane__handle"
      type="button"
      role="separator"
      aria-orientation="vertical"
      :aria-label="label"
      :aria-valuemin="min"
      :aria-valuemax="max"
      :aria-valuenow="clampedSize"
      :disabled="disabled"
      @pointerdown="startResize"
      @keydown="resizeWithKeyboard"
    >
      <span aria-hidden="true" />
    </button>
  </section>
</template>

<style scoped>
.ac-ui-resizable-pane {
  position: relative;
  min-width: 0;
  min-height: 0;
  flex: none;
}

.ac-ui-resizable-pane__handle {
  position: absolute;
  z-index: 20;
  top: 0;
  bottom: 0;
  width: 12px;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: col-resize;
  touch-action: none;
}

.ac-ui-resizable-pane[data-side="left"] .ac-ui-resizable-pane__handle {
  right: 0;
  transform: translateX(50%);
}

.ac-ui-resizable-pane[data-side="right"] .ac-ui-resizable-pane__handle {
  left: 0;
  transform: translateX(-50%);
}

.ac-ui-resizable-pane__handle > span {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
  background: transparent;
  transition: background-color var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard);
}

.ac-ui-resizable-pane[data-resizing] .ac-ui-resizable-pane__handle > span,
.ac-ui-resizable-pane__handle:focus-visible > span {
  background: var(--ac-boardroom-accent-300);
}

.ac-ui-resizable-pane__handle:disabled {
  cursor: default;
}

@media (hover: hover) {
  .ac-ui-resizable-pane__handle:hover:not(:disabled) > span {
    background: var(--ac-boardroom-accent-200);
  }
}
</style>
