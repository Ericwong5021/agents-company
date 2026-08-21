<script setup lang="ts">
definePageMeta({
  layout: false,
  prerender: true,
})

const route = useRoute()
const mode = ref<"local" | "remote">("local")
const loading = ref(false)
const error = ref("")
const email = ref("")
const password = ref("")
const redirectTo = computed(() => {
  const value = route.query.redirect
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : "/inbox"
})

async function enterLocalCompany() {
  if (loading.value) return
  loading.value = true
  error.value = ""
  const result = await $fetch("/api/auth/local", {
    method: "POST",
    retry: 0,
    signal: AbortSignal.timeout(8_000),
  })
    .then(() => true)
    .catch(() => false)
  loading.value = false
  if (result) {
    window.location.replace(redirectTo.value)
    return
  }
  mode.value = "remote"
}

async function enterRemoteCompany() {
  if (loading.value) return
  loading.value = true
  error.value = ""
  const result = await $fetch("/api/auth/remote", {
    method: "POST",
    body: { email: email.value, password: password.value },
    retry: 0,
  })
    .then(() => true)
    .catch(() => false)
  loading.value = false
  if (!result) {
    error.value = "邮箱或密码不正确，请检查后重试。"
    return
  }
  window.location.replace(redirectTo.value)
}

onNuxtReady(() => void enterLocalCompany())
</script>

<template>
  <main class="flex min-h-svh items-center justify-center bg-default px-6 py-10 text-default">
    <section class="w-full max-w-sm">
      <div class="text-center">
        <Logo class="mx-auto size-10" />
        <p class="mt-6 text-xs font-medium uppercase tracking-[0.18em] text-muted">Agent Company</p>
        <h1 class="mt-2 text-2xl font-semibold tracking-tight text-highlighted">
          {{ mode === "local" ? "正在进入工作区" : "登录远程工作区" }}
        </h1>
        <p class="mt-3 text-sm leading-relaxed text-muted">
          {{
            mode === "local" ? "正在确认本机身份，通常几秒内完成。" : "远程 WebUI 只连接你已授权的本机 Control Plane。"
          }}
        </p>
      </div>

      <div
        v-if="mode === 'local'"
        class="mt-7 flex items-center justify-center gap-2 text-sm text-toned"
        role="status"
        aria-live="polite"
      >
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        正在连接本地工作区
      </div>

      <form v-else class="mt-7 space-y-4" @submit.prevent="enterRemoteCompany">
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-toned">邮箱</span>
          <input
            v-model.trim="email"
            type="email"
            name="email"
            autocomplete="username"
            required
            autofocus
            class="h-11 w-full rounded-lg border border-default bg-elevated px-3 text-sm text-highlighted outline-none transition-[border-color,box-shadow] focus:border-accented focus:ring-2 focus:ring-primary/20"
          />
        </label>
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-toned">密码</span>
          <input
            v-model="password"
            type="password"
            name="password"
            autocomplete="current-password"
            minlength="12"
            required
            class="h-11 w-full rounded-lg border border-default bg-elevated px-3 text-sm text-highlighted outline-none transition-[border-color,box-shadow] focus:border-accented focus:ring-2 focus:ring-primary/20"
          />
        </label>
        <p v-if="error" class="text-sm leading-relaxed text-error" role="alert">
          {{ error }}
        </p>
        <button
          type="submit"
          :disabled="loading"
          class="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-inverted px-4 text-sm font-medium text-inverted transition-[transform,opacity] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
        >
          <UIcon v-if="loading" name="i-lucide-loader-circle" class="size-4 animate-spin" />
          {{ loading ? "正在登录" : "进入工作区" }}
        </button>
      </form>
    </section>
  </main>
</template>
