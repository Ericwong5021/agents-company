<script setup lang="ts">
import {
  applyQuickIntent,
  canSubmit,
  composerIntentHint,
  composerQuickIntents,
  composerTargetLabel,
  draftStorageKey,
  MAX_COMPOSER_RESOURCES,
  MAX_MENTIONS,
  MAX_TEXT_ATTACHMENT_BYTES,
  mentionOptions,
  parseComposerDraft,
  pathResource,
  resourceImpact,
  resourceLabel,
  sendFailureText,
  serializeComposerDraft,
  shouldRotateRequestID,
  toggleMention,
  urlResource,
  type ComposerResource,
  type ComposerTarget,
} from "../../shared/company-composer";
import type { CompanyAgent } from "../../shared/company-contract";

// WORK-04 — 统一 Composer：明确发送对象与默认意图，支持 @Agent 提及、快捷意图、
// 草稿恢复与幂等发送。附件与目录引用后端暂无端点，本组件不虚构该能力。
// 暂停/停止等变更类干预由 WORK-07 运行控制条按投影如实呈现，不在此伪造。

const props = defineProps<{
  target: ComposerTarget;
  agents: CompanyAgent[];
  replyTo?: { id: string; author: string; body: string };
}>();

const emit = defineEmits<{ sent: []; cancelReply: [] }>();

const body = ref("");
const selectedMentions = ref<string[]>([]);
const selectedRoles = ref<("ceo" | "cto" | "product_lead")[]>([]);
const resources = ref<ComposerResource[]>([]);
const sending = ref(false);
const failure = ref("");
const sentAt = ref("");
const showMentions = ref(false);
const showResources = ref(false);
const resourceValue = ref("");
const resourceType = ref<"file" | "directory" | "unknown">("unknown");
const resourceFailure = ref("");
const filePicker = ref<HTMLInputElement>();
const requestID = ref("");
const routeMode = ref<"auto" | "execute" | "discuss">("auto");
const routeFeedback = ref("");
const correcting = ref(false);
const pendingCorrection = ref<{
  requestID: string;
  body: string;
  mentions: string[];
  roles: ("ceo" | "cto" | "product_lead")[];
  resources: ComposerResource[];
}>();

type MessageAccepted = {
  intent?: "casual" | "question" | "task" | "goal" | "intervention" | "approval";
  autoProjected?: boolean;
  needsIntentConfirmation?: boolean;
};

const options = computed(() => mentionOptions(props.agents));
const roleOptions = computed(() => ([
  { id: "ceo" as const, label: "首席执行官" },
  { id: "cto" as const, label: "技术负责人" },
  { id: "product_lead" as const, label: "产品负责人" },
]).filter(option => props.agents.some(agent => agent.role === option.id)));
const storageKey = computed(() => draftStorageKey(props.target));
const submittable = computed(() => canSubmit({ body: body.value, sending: sending.value }));

// 草稿按目标隔离：项目切换、断线与刷新后从 localStorage 恢复；request_id 随草稿轮换。
watch(storageKey, (key) => {
  const draft = parseComposerDraft(import.meta.client ? localStorage.getItem(key) : null);
  body.value = draft.body;
  resources.value = draft.resources;
  selectedMentions.value = [];
  selectedRoles.value = [];
  failure.value = "";
  sentAt.value = "";
  routeFeedback.value = "";
  pendingCorrection.value = undefined;
  resourceFailure.value = "";
  routeMode.value = "auto";
  requestID.value = import.meta.client ? crypto.randomUUID() : "";
}, { immediate: true });

watch([body, resources], () => {
  if (!import.meta.client) return;
  if (body.value || resources.value.length)
    return localStorage.setItem(storageKey.value, serializeComposerDraft(body.value, resources.value));
  localStorage.removeItem(storageKey.value);
}, { deep: true });

function pickMention(agentId: string) {
  if (!selectedMentions.value.includes(agentId) && selectedMentions.value.length + selectedRoles.value.length >= MAX_MENTIONS)
    return;
  selectedMentions.value = toggleMention(selectedMentions.value, agentId);
}

function pickRole(role: "ceo" | "cto" | "product_lead") {
  if (selectedRoles.value.includes(role)) {
    selectedRoles.value = selectedRoles.value.filter(value => value !== role);
    return;
  }
  if (selectedMentions.value.length + selectedRoles.value.length >= MAX_MENTIONS) return;
  selectedRoles.value = [...selectedRoles.value, role];
}

function addResourceReference() {
  resourceFailure.value = "";
  if (resources.value.length >= MAX_COMPOSER_RESOURCES) {
    resourceFailure.value = `每条消息最多添加 ${MAX_COMPOSER_RESOURCES} 个资源。`;
    return;
  }
  const resource = urlResource(resourceValue.value) ?? pathResource(resourceValue.value, resourceType.value);
  if (!resource) {
    resourceFailure.value = "请输入有效的 http(s) URL 或不含换行的本地路径。";
    return;
  }
  if (resources.value.some(item => resourceLabel(item) === resourceLabel(resource))) {
    resourceFailure.value = "这个资源已添加。";
    return;
  }
  resources.value = [...resources.value, resource];
  resourceValue.value = "";
}

async function attachTextFiles(event: Event) {
  resourceFailure.value = "";
  const input = event.currentTarget as HTMLInputElement;
  const files = [...(input.files ?? [])];
  for (const file of files) {
    if (resources.value.length >= MAX_COMPOSER_RESOURCES) {
      resourceFailure.value = `每条消息最多添加 ${MAX_COMPOSER_RESOURCES} 个资源。`;
      break;
    }
    if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
      resourceFailure.value = `${file.name} 超过 ${Math.round(MAX_TEXT_ATTACHMENT_BYTES / 1000)}KB，未添加。`;
      continue;
    }
    if (!file.type.startsWith("text/") && !/\.(md|txt|json|csv|ya?ml|xml|html?|css|[cm]?[jt]sx?|py|sh)$/i.test(file.name)) {
      resourceFailure.value = `${file.name} 不是受支持的文本附件，未添加。`;
      continue;
    }
    const content = await file.text();
    const byteLength = new TextEncoder().encode(content).byteLength;
    if (byteLength > MAX_TEXT_ATTACHMENT_BYTES) {
      resourceFailure.value = `${file.name} 解码后超过 ${Math.round(MAX_TEXT_ATTACHMENT_BYTES / 1000)}KB，未添加。`;
      continue;
    }
    resources.value = [...resources.value, {
      kind: "text_attachment",
      name: file.name,
      media_type: file.type || "text/plain",
      byte_length: byteLength,
      content,
    }];
  }
  input.value = "";
}

function removeResource(index: number) {
  resources.value = resources.value.filter((_, current) => current !== index);
  resourceFailure.value = "";
}

function quickIntent(prefix: string) {
  body.value = applyQuickIntent(body.value, prefix);
}

async function send() {
  if (!submittable.value) return;
  sending.value = true;
  failure.value = "";
  sentAt.value = "";
  routeFeedback.value = "";
  const submittedBody = body.value.trim();
  const submittedMentions = [...selectedMentions.value];
  const submittedRoles = [...selectedRoles.value];
  const submittedResources = [...resources.value];
  const submittedRequestID = requestID.value;
  // 同一草稿沿用同一 request_id：双击、Enter 重复、断线重试由本地服务按请求去重。
  await $fetch<MessageAccepted>("/api/agent-company/messages", {
    method: "POST",
    body: {
      request_id: requestID.value,
      body: submittedBody,
      target: props.target.kind === "board"
        ? { kind: "board" }
        : { kind: "project", project_id: props.target.projectId },
      mentions: [
        ...submittedMentions.map(agentId => ({ kind: "agent" as const, agent_id: agentId })),
        ...submittedRoles.map(role => ({ kind: "role" as const, role })),
      ],
      resources: submittedResources,
      ...(props.replyTo ? { reply_to: props.replyTo.id } : {}),
      ...(props.target.kind === "board" && routeMode.value !== "auto"
        ? { intent_override: routeMode.value }
        : {}),
    },
  }).then((accepted) => {
    // 仅在本地服务确认接受后清空草稿并轮换 request_id；失败保留全部内容。
    if (shouldRotateRequestID("accepted")) requestID.value = crypto.randomUUID();
    if (import.meta.client) localStorage.removeItem(storageKey.value);
    body.value = "";
    selectedMentions.value = [];
    selectedRoles.value = [];
    resources.value = [];
    showMentions.value = false;
    pendingCorrection.value = accepted.needsIntentConfirmation
      ? {
          requestID: submittedRequestID,
          body: submittedBody,
          mentions: submittedMentions,
          roles: submittedRoles,
          resources: submittedResources,
        }
      : undefined;
    routeFeedback.value = accepted.autoProjected
      ? "已识别为可执行目标并进入工作流。"
      : accepted.needsIntentConfirmation
        ? "已保留为讨论；如果这是明确目标，可以立即改为执行。"
        : "已按讨论消息保存，没有自动创建工作。";
    routeMode.value = "auto";
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

async function promoteToGoal() {
  if (!pendingCorrection.value || correcting.value || props.target.kind !== "board") return;
  correcting.value = true;
  failure.value = "";
  const correction = pendingCorrection.value;
  await $fetch<MessageAccepted>("/api/agent-company/messages", {
    method: "POST",
    body: {
      request_id: correction.requestID,
      body: correction.body,
      target: { kind: "board" },
      mentions: [
        ...correction.mentions.map(agentId => ({ kind: "agent" as const, agent_id: agentId })),
        ...correction.roles.map(role => ({ kind: "role" as const, role })),
      ],
      resources: correction.resources,
      intent_override: "execute",
    },
  }).then(() => {
    pendingCorrection.value = undefined;
    routeFeedback.value = "已按你的纠正转为可执行目标并进入工作流。";
    emit("sent");
  }, (error: unknown) => {
    const status = typeof error === "object" && error !== null && "statusCode" in error
      && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
    failure.value = sendFailureText(status);
  });
  correcting.value = false;
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

    <div v-if="replyTo" class="ac-composer__reply">
      <span>回复 {{ replyTo.author }}：{{ replyTo.body }}</span>
      <button type="button" @click="emit('cancelReply')">取消</button>
    </div>

    <div v-if="target.kind === 'board'" class="ac-composer__routing" role="radiogroup" aria-label="消息用途">
      <button type="button" role="radio" :aria-checked="routeMode === 'auto'" :data-active="routeMode === 'auto'" @click="routeMode = 'auto'">
        自动判断
      </button>
      <button type="button" role="radio" :aria-checked="routeMode === 'execute'" :data-active="routeMode === 'execute'" @click="routeMode = 'execute'">
        作为目标执行
      </button>
      <button type="button" role="radio" :aria-checked="routeMode === 'discuss'" :data-active="routeMode === 'discuss'" @click="routeMode = 'discuss'">
        仅讨论
      </button>
    </div>

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
          :disabled="!options.length && !roleOptions.length"
          :title="options.length || roleOptions.length ? '选择要提及的团队成员或角色' : '公司名册为空，暂无可提及对象'"
          @click="showMentions = !showMentions"
        >
          @ 团队成员<template v-if="selectedMentions.length + selectedRoles.length">（{{ selectedMentions.length + selectedRoles.length }}）</template>
        </button>
        <button
          type="button"
          class="ac-composer__tool"
          :data-active="showResources"
          @click="showResources = !showResources"
        >
          添加资源<template v-if="resources.length">（{{ resources.length }}）</template>
        </button>
        <button type="button" class="ac-composer__tool" :disabled="sending || resources.length >= MAX_COMPOSER_RESOURCES" @click="filePicker?.click()">
          文本附件
        </button>
        <input
          ref="filePicker"
          class="ac-composer__file-input"
          type="file"
          multiple
          accept="text/*,.md,.json,.csv,.yaml,.yml,.xml,.html,.css,.js,.ts,.tsx,.vue,.py,.sh"
          @change="attachTextFiles"
        >
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
        v-for="role in roleOptions"
        :key="role.id"
        type="button"
        class="ac-composer__mention"
        :data-active="selectedRoles.includes(role.id)"
        @click="pickRole(role.id)"
      >
        @{{ role.label }}<small>（角色）</small>
      </button>
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

    <div v-if="showResources" class="ac-composer__resources">
      <div class="ac-composer__resource-form">
        <input
          v-model="resourceValue"
          type="text"
          maxlength="4000"
          placeholder="粘贴 https:// URL 或本地文件/目录路径"
          @keydown.enter.prevent="addResourceReference"
        >
        <select v-model="resourceType" aria-label="本地路径类型">
          <option value="unknown">自动识别路径</option>
          <option value="file">本地文件</option>
          <option value="directory">本地目录</option>
        </select>
        <button type="button" :disabled="!resourceValue.trim()" @click="addResourceReference">添加</button>
      </div>
      <p>本地路径仅作为只读线索，不会提升权限；URL 可能需要外部网络，但不会自动授权登录或发布。</p>
    </div>

    <ul v-if="resources.length" class="ac-composer__resource-list" aria-label="待发送资源">
      <li v-for="(resource, index) in resources" :key="`${resource.kind}:${resourceLabel(resource)}:${index}`">
        <div>
          <strong>{{ resourceLabel(resource) }}</strong>
          <small>{{ resourceImpact(resource) }}</small>
        </div>
        <button type="button" :aria-label="`移除 ${resourceLabel(resource)}`" @click="removeResource(index)">移除</button>
      </li>
    </ul>

    <p v-if="resourceFailure" class="ac-composer__error" role="alert">{{ resourceFailure }}</p>

    <p v-if="failure" class="ac-composer__error" role="alert">{{ failure }}</p>
    <div v-else-if="sentAt" class="ac-composer__sent" role="status">
      <p>已于 {{ sentAt }} 发送到{{ composerTargetLabel(target) }}。{{ routeFeedback }}</p>
      <button v-if="pendingCorrection" type="button" :disabled="correcting" @click="promoteToGoal">
        {{ correcting ? "正在纠正…" : "作为目标执行" }}
      </button>
    </div>
  </section>
</template>
