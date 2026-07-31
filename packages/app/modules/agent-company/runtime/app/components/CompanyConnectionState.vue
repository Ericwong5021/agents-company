<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import type { CompanyConnection, CompanyConnectionIssue } from "../../shared/company-contract"

const props = defineProps<{
  connection: CompanyConnection
  issue?: CompanyConnectionIssue
  pending?: boolean
  showSettings?: boolean
}>()

defineEmits<{
  retry: []
}>()

const copyStatus = ref<"idle" | "copied" | "failed">("idle")
const startupVisible = ref(false)
const hydrated = ref(false)
const showStartup = computed(() =>
  props.issue?.kind === "service_unreachable" || props.issue?.kind === "invalid_configuration")
const icon = computed(() => {
  if (props.connection === "connecting" || props.connection === "recovering") return "i-lucide-loader-circle"
  if (props.issue?.kind === "authorization_required") return "i-lucide-key-round"
  if (props.issue?.kind === "migration_required") return "i-lucide-database-zap"
  if (props.connection === "degraded") return "i-lucide-triangle-alert"
  return "i-lucide-unplug"
})

onMounted(() => {
  hydrated.value = true
})

async function copyDiagnostic() {
  if (!props.issue) return
  const copied = await navigator.clipboard
    ?.writeText(JSON.stringify(props.issue.diagnostic, null, 2))
    .then(
      () => true,
      () => false,
    ) ?? false
  copyStatus.value = copied ? "copied" : "failed"
  setTimeout(() => {
    copyStatus.value = "idle"
  }, 2_000)
}

function toggleStartup() {
  startupVisible.value = !startupVisible.value
}
</script>

<template>
  <section class="company-connection-state" aria-live="polite">
    <span class="company-connection-state__icon" aria-hidden="true">
      <UIcon
        :name="icon"
        :class="{ 'animate-spin motion-reduce:animate-none': connection === 'connecting' || connection === 'recovering' }"
      />
    </span>
    <div>
      <p class="company-eyebrow">本地运行服务</p>
      <h2>{{ issue?.title ?? "正在连接本地服务" }}</h2>
      <p>{{ issue?.detail ?? "正在读取真实公司状态，请稍候。" }}</p>
      <p v-if="issue" class="company-connection-state__impact">
        {{ issue.impact }} {{ issue.nextAction }}
      </p>
      <div
        v-if="showStartup && startupVisible"
        id="company-startup-instructions"
        class="company-connection-state__startup"
      >
        <p><strong>仓库根目录</strong><code>bun run dev</code></p>
        <p><strong>packages/control-plane</strong><code>bun run dev</code></p>
      </div>
    </div>
    <div class="company-connection-state__actions">
      <UButton
        color="neutral"
        :loading="pending || connection === 'connecting' || connection === 'recovering'"
        :disabled="!hydrated || issue?.retryable === false"
        @click="$emit('retry')"
      >
        重新连接
      </UButton>
      <UButton
        v-if="issue"
        color="neutral"
        variant="ghost"
        :disabled="!hydrated"
        @click="copyDiagnostic"
      >
        {{ copyStatus === "copied" ? "已复制诊断" : copyStatus === "failed" ? "复制失败" : "复制诊断" }}
      </UButton>
      <UButton
        v-if="showStartup"
        color="neutral"
        variant="ghost"
        aria-controls="company-startup-instructions"
        :aria-expanded="startupVisible"
        :disabled="!hydrated"
        @click="toggleStartup"
      >
        {{ startupVisible ? "收起启动说明" : "查看启动说明" }}
      </UButton>
      <NuxtLink v-if="showSettings" to="/settings" class="company-text-link">打开设置</NuxtLink>
    </div>
  </section>
</template>
