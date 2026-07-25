<script setup lang="ts">
definePageMeta({
  layout: false,
  prerender: true,
});

const route = useRoute();
const loading = ref(false);
const error = ref("");
const redirectTo = computed(() => {
  const value = route.query.redirect;
  return typeof value === "string"
    && value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("\\")
    ? value
    : "/inbox";
});

async function enterCompany() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  const result = await $fetch("/api/auth/local", { method: "POST" })
    .then(() => ({ ok: true as const }))
    .catch(() => ({ ok: false as const }));
  loading.value = false;
  if (!result.ok) {
    error.value = "本地账号暂时无法准备，请确认 WebUI 仍在本机运行后重试。";
    return;
  }

  window.location.replace(redirectTo.value);
}

onNuxtReady(() => void enterCompany());
</script>

<template>
  <main class="flex min-h-svh items-center justify-center bg-default px-6 py-10 text-default">
    <section class="w-full max-w-sm text-center">
      <Logo class="mx-auto size-10" />
      <p class="mt-6 text-xs font-medium uppercase tracking-[0.18em] text-muted">
        Local AI team
      </p>
      <h1 class="mt-2 text-2xl font-semibold tracking-tight text-highlighted">
        正在进入 Agent Company
      </h1>
      <p class="mt-3 text-sm leading-relaxed text-muted">
        使用本机默认账号准备工作区，无需注册或登录。
      </p>

      <div
        v-if="!error"
        class="mt-7 flex items-center justify-center gap-2 text-sm text-toned"
        role="status"
        aria-live="polite"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-4 animate-spin"
        />
        正在连接本地工作区
      </div>

      <div
        v-else
        class="mt-7"
      >
        <p
          class="text-sm leading-relaxed text-error"
          role="alert"
        >
          {{ error }}
        </p>
        <UButton
          class="mt-4"
          color="neutral"
          :loading="loading"
          @click="enterCompany"
        >
          重新进入
        </UButton>
      </div>
    </section>
  </main>
</template>
