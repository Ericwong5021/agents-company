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

useHead({
  script: [{
    key: "agent-company-local-login-deadline",
    tagPosition: "bodyClose",
    innerHTML: `window.setTimeout(function(){document.documentElement.dataset.localLoginTimedOut="true";var pending=document.getElementById("local-login-pending");var failure=document.getElementById("local-login-failure");if(pending)pending.style.display="none";if(failure)failure.style.display="block"},10000)`,
  }],
});

async function enterCompany() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  const result = await $fetch("/api/auth/local", {
    method: "POST",
    retry: 0,
    signal: controller.signal,
  })
    .then(() => ({ ok: true as const }))
    .catch(() => ({ ok: false as const }));
  window.clearTimeout(timeout);
  loading.value = false;
  if (!result.ok) {
    error.value = "本地账号暂时无法准备，请确认 WebUI 仍在本机运行后重试。";
    return;
  }

  window.location.replace(redirectTo.value);
}

onNuxtReady(() => {
  if (document.documentElement.dataset.localLoginTimedOut === "true") {
    error.value = "连接本地工作区超过十秒，请重新进入。";
    return;
  }
  void enterCompany();
});
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
        使用本机默认账号准备工作区，无需注册或登录，通常十秒内完成。
      </p>

      <div
        id="local-login-pending"
        v-show="!error"
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
        id="local-login-failure"
        v-show="Boolean(error)"
        class="mt-7"
      >
        <p
          class="text-sm leading-relaxed text-error"
          role="alert"
        >
          {{ error || "连接本地工作区超过十秒，请重新进入。" }}
        </p>
        <a
          :href="route.fullPath"
          class="mt-4 inline-flex items-center justify-center rounded-md bg-inverted px-3 py-2 text-sm font-medium text-inverted"
          @click.prevent="enterCompany"
        >
          重新进入
        </a>
      </div>
    </section>
  </main>
</template>
