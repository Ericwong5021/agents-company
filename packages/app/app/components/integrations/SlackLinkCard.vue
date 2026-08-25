<script setup lang="ts">
const {
  data: slackLink,
  pending,
  error,
  isLinked,
  pendingCode,
  generating,
  generateLinkCode,
  unlinkSlack,
} = useSlackLink();

const unlinking = ref(false);
const copied = ref(false);

const expiresLabel = computed(() => {
  const expiresAt = slackLink.value?.pendingExpiresAt;
  if (!expiresAt) {
    return undefined;
  }

  const minutes = Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
  return `${minutes} 分钟后失效`;
});

async function onUnlink() {
  unlinking.value = true;
  try {
    await unlinkSlack();
  }
  finally {
    unlinking.value = false;
  }
}

async function copyCode() {
  const code = pendingCode.value ?? slackLink.value?.pendingCode;
  if (!code) {
    return;
  }

  await navigator.clipboard.writeText(`link ${code}`);
  copied.value = true;
  setTimeout(() => {
    copied.value = false;
  }, 2000);
}
</script>

<template>
  <div>
    <div class="flex items-center gap-3 px-4 py-3">
      <div
        class="flex size-8 shrink-0 items-center justify-center rounded-md border border-default bg-elevated"
      >
        <UIcon
          name="i-simple-icons-slack"
          class="size-4 text-toned"
        />
      </div>

      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <h3 class="text-sm text-highlighted">
            Slack
          </h3>
          <span
            v-if="!pending"
            class="inline-flex items-center gap-1.5 text-[11px] text-muted"
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="isLinked
                ? 'bg-emerald-400/90'
                : 'bg-toned'"
            />
            {{ isLinked ? "已连接" : "未连接" }}
          </span>
        </div>
        <p class="truncate text-xs text-muted">
          <template v-if="isLinked && slackLink?.displayName">
            {{ slackLink.displayName }}
            <span
              v-if="slackLink.userName"
              class="text-dimmed"
            > · @{{ slackLink.userName }}</span>
          </template>
          <template v-else>
            在 Slack 中使用 Agent Company
          </template>
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-1.5">
        <UButton
          v-if="isLinked"
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-unlink"
          :loading="unlinking"
          aria-label="Unlink Slack"
          @click="onUnlink"
        />
        <UButton
          v-else
          color="neutral"
          variant="soft"
          size="xs"
          :loading="generating || pending"
          @click="generateLinkCode"
        >
          {{ pendingCode ? "换一个验证码" : "生成验证码" }}
        </UButton>
      </div>
    </div>

    <div
      v-if="!isLinked && pendingCode"
      class="border-t border-default px-4 py-3"
    >
      <ol class="space-y-2 text-xs text-muted">
        <li class="flex gap-2">
          <span class="text-dimmed">1.</span>
          <span>在 Slack 中发送 <code class="text-toned">@V link {{ pendingCode }}</code></span>
        </li>
        <li class="flex gap-2">
          <span class="text-dimmed">2.</span>
          <span>确认连接后刷新本页</span>
        </li>
      </ol>

      <div class="mt-3 flex items-center gap-2">
        <code class="rounded-md border border-default bg-elevated px-2.5 py-1 font-mono text-sm tracking-widest text-highlighted">
          {{ pendingCode }}
        </code>
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          @click="copyCode"
        >
          {{ copied ? "已复制" : "复制" }}
        </UButton>
        <span
          v-if="expiresLabel"
          class="text-[11px] text-dimmed"
        >{{ expiresLabel }}</span>
      </div>
    </div>

    <p
      v-if="error"
      class="border-t border-default px-4 py-2 text-xs text-error"
    >
      {{ error.message }}
    </p>
  </div>
</template>
