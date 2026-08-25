<script setup lang="ts">
const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{
  imported: [count: number];
}>();

const { importMemory, copyExportPrompt } = useMemory();
const toast = useToast();

const raw = ref("");
const importing = ref(false);
const copied = ref(false);

watch(open, (value) => {
  if (!value) {
    copied.value = false;
  }
});

async function handleCopyPrompt() {
  try {
    await copyExportPrompt();
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  }
  catch {
    toast.add({
      title: "提示词复制失败",
      color: "error",
    });
  }
}

async function handleImport() {
  const text = raw.value.trim();
  if (!text || importing.value) {
    return;
  }

  importing.value = true;
  try {
    const result = await importMemory(text);
    raw.value = "";
    open.value = false;
    emit("imported", result.created.length);
    toast.add({
      title: result.created.length
        ? `已导入 ${result.created.length} 条记忆`
        : "没有新的记忆",
      description: result.skipped.length
        ? `${result.skipped.length} 项已存在`
        : undefined,
      color: result.created.length ? "success" : "neutral",
    });
  }
  catch (error) {
    toast.add({
      title: "导入失败",
      description: error instanceof Error ? error.message : "请重试",
      color: "error",
    });
  }
  finally {
    importing.value = false;
  }
}

defineShortcuts({
  meta_enter: () => {
    if (open.value) {
      void handleImport();
    }
  },
});
</script>

<template>
  <UModal
    v-model:open="open"
    title="导入记忆"
    :ui="{
      content: 'w-[calc(100vw-2rem)] max-w-2xl',
      body: 'space-y-4 px-5 py-4 sm:px-6',
      footer: 'justify-end gap-2 px-5 py-3 sm:px-6',
    }"
  >
    <template #actions>
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
        @click="handleCopyPrompt"
      >
        {{ copied ? "已复制" : "复制导出提示词" }}
      </UButton>
    </template>

    <template #body>
      <ol class="list-decimal space-y-1.5 ps-5 text-sm leading-relaxed text-toned marker:text-dimmed">
        <li>复制导出提示词</li>
        <li>发送给原来的 AI 服务</li>
        <li>把返回内容粘贴到下方</li>
      </ol>

      <UTextarea
        v-model="raw"
        class="w-full"
        :rows="8"
        placeholder="粘贴记忆导出内容"
      />
    </template>

    <template #footer>
      <UButton
        color="neutral"
        variant="ghost"
        @click="() => { open = false }"
      >
        取消
      </UButton>

      <UButton
        color="primary"
        :disabled="!raw.trim()"
        :loading="importing"
        @click="handleImport"
      >
        导入
        <span class="ms-2 inline-flex items-center gap-0.5 opacity-80">
          <UKbd
            value="meta"
            size="sm"
            variant="subtle"
          />
          <UKbd
            size="sm"
            variant="subtle"
          >
            ↵
          </UKbd>
        </span>
      </UButton>
    </template>
  </UModal>
</template>
