<script setup lang="ts">
import {
  applyQuickIntent,
  canSubmit,
  composerIntentHint,
  composerQuickIntents,
  composerTargetLabel,
  draftStorageKey,
  mentionOptions,
  sendFailureText,
  shouldRotateRequestID,
  toggleMention,
  type ComposerTarget,
} from "../../shared/company-composer";
import type { CompanyAgent } from "../../shared/company-contract";

// WORK-04 — 统一 Composer：明确发送对象与默认意图，支持 @Agent 提及、快捷意图、
// 草稿恢复与幂等发送。附件与目录引用后端暂无端点，本组件不虚构该能力。
// 暂停/停止等变更类干预由 WORK-07 运行控制条按投影如实呈现，不在此伪造。

const props = defineProps<{
  target: ComposerTarget;
  agents: CompanyAgent[];
}>();

const emit = defineEmits<{ sent: [] }>();

const body = ref("");
const selectedMentions = ref<string[]>([]);
const sending = ref(false);
const failure = ref("");
const sentAt = ref("");
const showMentions = ref(false);
const requestID = ref("");

const options = computed(() => mentionOptions(props.agents));
const storageKey = computed(() => draftStorageKey(props.target));
const submittable = computed(() => canSubmit({ body: body.value, sending: sending.value }));

// 草稿按目标隔离：项目切换、断线与刷新后从 localStorage 恢复；request_id 随草稿轮换。
watch(storageKey, (key) => {
  body.value = import.meta.client ? (localStorage.getItem(key) ?? "") : "";
  selectedMentions.value = [];
  failure.value = "";
  sentAt.value = "";
  requestID.value = import.meta.client ? crypto.randomUUID() : "";
}, { immediate: true });

watch(body, (value) => {
  if (!import.meta.client) return;
  if (value) return localStorage.setItem(storageKey.value, value);
  localStorage.removeItem(storageKey.value);
});

function pickMention(agentId: string) {
  selectedMentions.value = toggleMention(selectedMentions.value, agentId);
}

function quickIntent(prefix: string) {
  body.value = applyQuickIntent(body.value, prefix);
}

async function send() {
  if (!submittable.value) return;
  sending.value = true;
  failure.value = "";
  sentAt.value = "";
  // 同一草稿沿用同一 request_id：双击、Enter 重复、断线重试由本地服务按请求去重。
  await $fetch("/api/agent-company/messages", {
    method: "POST",
    body: {
      request_id: requestID.value,
      body: body.value.trim(),
      target: props.target.kind === "board"
        ? { kind: "board" }
        : { kind: "project", project_id: props.target.projectId },
      mentions: selectedMentions.value.map(agentId => ({ kind: "agent", agent_id: agentId })),
    },
  }).then(() => {
    // 仅在本地服务确认接受后清空草稿并轮换 request_id；失败保留全部内容。
    if (shouldRotateRequestID("accepted")) requestID.value = crypto.randomUUID();
    if (import.meta.client) localStorage.removeItem(storageKey.value);
    body.value = "";
    selectedMentions.value = [];
    showMentions.value = false;
    sentAt.value = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .format(new Date());
    emit("sent");
  }, (error: unknown) => {
    const status = typeof error === "object" && error !== null && "statusCode" in error
      && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
    failure.value = sendFailureText(status);
  });
  sending.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
  event.preventDefault();
  void send();
}
</script>

<template>
  <section class="ac-composer" aria-label="发送消息">
    <header class="ac-composer__head">
      <span class="ac-composer__target">
        发送到：<strong>{{ composerTargetLabel(target) }}</strong>
      </span>
      <small>{{ composerIntentHint(target) }}</small>
    </header>

    <textarea
      v-model="body"
      class="ac-composer__input"
      rows="3"
      maxlength="20000"
      :disabled="sending"
      placeholder="输入追问、补充材料或调整建议…（⌘/Ctrl+Enter 发送）"
      @keydown="onKeydown"
    />

    <div class="ac-composer__bar">
      <div class="ac-composer__tools">
        <button
          type="button"
          class="ac-composer__tool"
          :data-active="showMentions"
          :disabled="!options.length"
          :title="options.length ? '选择要提及的团队成员' : '公司名册为空，暂无可提及对象'"
          @click="showMentions = !showMentions"
        >
          @ 团队成员<template v-if="selectedMentions.length">（{{ selectedMentions.length }}）</template>
        </button>
        <button
          v-for="intent in composerQuickIntents"
          :key="intent.id"
          type="button"
          class="ac-composer__tool"
          @click="quickIntent(intent.prefix)"
        >
          {{ intent.label }}
        </button>
      </div>
      <button
        type="button"
        class="ac-composer__send"
        :disabled="!submittable"
        @click="send()"
      >
        {{ sending ? "发送中…" : "发送" }}
      </button>
    </div>

    <div v-if="showMentions" class="ac-composer__mentions" role="group" aria-label="选择提及对象">
      <button
        v-for="option in options"
        :key="option.agentId"
        type="button"
        class="ac-composer__mention"
        :data-active="selectedMentions.includes(option.agentId)"
        @click="pickMention(option.agentId)"
      >
        @{{ option.name }}<small v-if="option.role">（{{ option.role }}）</small>
      </button>
      <p class="ac-composer__mention-note">提及对象是否对目标频道可见由本地服务校验，不可见时发送会明确失败。</p>
    </div>

    <p v-if="failure" class="ac-composer__error" role="alert">{{ failure }}</p>
    <p v-else-if="sentAt" class="ac-composer__sent" role="status">
      已于 {{ sentAt }} 发送到{{ composerTargetLabel(target) }}。
    </p>
  </section>
</template>
