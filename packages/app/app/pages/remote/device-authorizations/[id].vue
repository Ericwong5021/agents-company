<script setup lang="ts">
definePageMeta({ layout: false })

const route = useRoute()
const loading = ref(true)
const approving = ref(false)
const approved = ref(false)
const error = ref("")
const code = computed(() => (typeof route.query.code === "string" ? route.query.code : ""))
const authorization = ref<{ status: "pending" | "approved" | "consumed"; device_name: string; expires_at: string }>()

async function loadAuthorization() {
  if (!code.value) {
    error.value = "授权链接缺少一次性代码。"
    loading.value = false
    return
  }
  authorization.value = await $fetch(
    `/api/remote/device-authorizations/${encodeURIComponent(String(route.params.id))}`,
    {
      query: { code: code.value },
    },
  ).catch(() => undefined)
  loading.value = false
  if (!authorization.value) error.value = "此授权请求不存在、已过期或已失效。"
  if (authorization.value?.status !== "pending") approved.value = true
}

async function approve() {
  if (approving.value || !authorization.value) return
  approving.value = true
  error.value = ""
  const result = await $fetch(
    `/api/remote/device-authorizations/${encodeURIComponent(String(route.params.id))}/approve`,
    {
      method: "POST",
      body: { user_code: code.value },
    },
  )
    .then(() => true)
    .catch(() => false)
  approving.value = false
  if (!result) {
    error.value = "设备授权没有完成，请确认请求仍在有效期内。"
    return
  }
  approved.value = true
}

useHead({ title: "设备授权" })
onMounted(() => void loadAuthorization())
</script>

<template>
  <main class="flex min-h-svh items-center justify-center bg-default px-5 py-10 text-default">
    <section
      class="w-full max-w-md rounded-[22px] bg-elevated p-6 shadow-[0_24px_70px_rgba(10,27,46,0.14),0_0_0_1px_var(--ac-line)] sm:p-8"
    >
      <div class="flex items-center gap-3">
        <Logo class="size-9 text-highlighted" />
        <div>
          <p class="text-xs font-medium uppercase tracking-[0.16em] text-muted">Agent Company</p>
          <h1 class="mt-1 text-xl font-semibold tracking-[-0.012em] text-highlighted">授权本机 Control Plane</h1>
        </div>
      </div>

      <div v-if="loading" class="mt-8 flex min-h-32 items-center justify-center gap-2 text-sm text-muted" role="status">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        正在读取授权请求
      </div>

      <div v-else-if="error && !authorization" class="mt-8">
        <p class="text-sm leading-7 text-error" role="alert">{{ error }}</p>
        <NuxtLink
          to="/inbox"
          class="mt-5 inline-flex min-h-10 items-center text-sm font-medium text-highlighted underline decoration-muted underline-offset-4"
        >
          返回工作区
        </NuxtLink>
      </div>

      <div v-else-if="authorization" class="mt-8">
        <div class="grid gap-5 border-y border-default py-5">
          <div>
            <p class="text-xs font-medium text-muted">设备</p>
            <p class="mt-1 text-sm font-semibold text-highlighted">{{ authorization.device_name }}</p>
          </div>
          <div>
            <p class="text-xs font-medium text-muted">一次性代码</p>
            <p class="mt-1 font-mono text-lg font-semibold tracking-[0.1em] text-highlighted">{{ code }}</p>
          </div>
        </div>

        <div v-if="approved" class="mt-6" role="status" aria-live="polite">
          <div class="flex items-start gap-3">
            <UIcon name="i-lucide-circle-check" class="mt-0.5 size-5 shrink-0 text-success" />
            <div>
              <h2 class="text-sm font-semibold text-highlighted">设备已授权</h2>
              <p class="mt-1 text-sm leading-6 text-muted">
                本机 Control Plane 会通过加密通道连接 Relay。你可以关闭此页面。
              </p>
            </div>
          </div>
          <NuxtLink
            to="/inbox"
            class="mt-6 inline-flex min-h-10 items-center text-sm font-medium text-highlighted underline decoration-muted underline-offset-4"
          >
            返回工作区
          </NuxtLink>
        </div>

        <template v-else>
          <p class="mt-5 text-sm leading-6 text-muted">
            批准后，这台设备可以连接远程 Relay。业务数据不会保存在 VPS Relay 数据库中。
          </p>
          <p v-if="error" class="mt-4 text-sm leading-6 text-error" role="alert">{{ error }}</p>
          <div class="mt-6 flex items-center gap-3">
            <button
              type="button"
              :disabled="approving"
              class="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-inverted px-4 text-sm font-medium text-inverted transition-[transform,opacity] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
              @click="approve"
            >
              <UIcon v-if="approving" name="i-lucide-loader-circle" class="size-4 animate-spin" />
              {{ approving ? "正在授权" : "批准此设备" }}
            </button>
            <NuxtLink
              to="/inbox"
              class="inline-flex min-h-10 items-center px-2 text-sm font-medium text-muted transition-colors hover:text-highlighted"
            >
              暂不授权
            </NuxtLink>
          </div>
        </template>
      </div>
    </section>
  </main>
</template>
