<script setup lang="ts">
import type { ComposerResource } from "../../../shared/company-composer"
import {
  MAX_COMPOSER_RESOURCES,
  MAX_MENTIONS,
  MAX_TEXT_ATTACHMENT_BYTES,
  parseComposerDraft,
  pathResource,
  resourceImpact,
  resourceLabel,
  serializeComposerDraft,
  toggleMention,
  urlResource,
} from "../../../shared/company-composer"
import type {
  BoardroomParticipantVM,
  BoardroomPollInput,
  BoardroomRoomVM,
  BoardroomSendInput,
  BoardroomSendResult,
} from "../../types/boardroom"

const props = withDefaults(defineProps<{
  room: BoardroomRoomVM
  participants: BoardroomParticipantVM[]
  sendResult?: BoardroomSendResult
  replyTo?: { id: string; author: string; body: string }
  draftScope?: string
  compact?: boolean
}>(), {
  sendResult: undefined,
  replyTo: undefined,
  draftScope: "main",
  compact: false,
})

const emit = defineEmits<{
  send: [input: BoardroomSendInput]
  promote: [requestID: string]
  poll: [input: BoardroomPollInput]
  command: [command: "intervene" | "shadow" | "decision"]
  cancelReply: []
}>()

const body = ref("")
const mentions = ref<string[]>([])
const roles = ref<("ceo" | "cto" | "product_lead")[]>([])
const resources = ref<ComposerResource[]>([])
const intent = ref<"auto" | "execute" | "discuss">("auto")
const requestID = ref("")
const pendingRequestID = ref("")
const correctionRequestID = ref("")
const sending = ref(false)
const feedback = ref("")
const failure = ref("")
const menu = ref<"add" | "mention" | "command" | "resource" | "poll" | "intent" | "">("")
const resourceValue = ref("")
const resourceType = ref<"file" | "directory" | "unknown">("unknown")
const resourceFailure = ref("")
const filePicker = ref<HTMLInputElement>()
const input = ref<HTMLTextAreaElement>()
const pollQuestion = ref("")
const pollOptions = ref(["", ""])
const pollMultiple = ref(false)

const storageKey = computed(() => `agent-company-composer:${props.room.id}:${props.draftScope}`)
const slashOpen = computed(() => body.value.startsWith("/") && !body.value.includes(" "))
const mentionOpen = computed(() => /(?:^|\s)@[^\s@]*$/.test(body.value))
const roleOptions = [
  { id: "ceo" as const, label: "首席执行官" },
  { id: "cto" as const, label: "技术负责人" },
  { id: "product_lead" as const, label: "产品负责人" },
]
const commands = [
  { id: "poll", label: "发起投票", hint: "创建董事会投票", icon: "i-lucide-chart-no-axes-column" },
  { id: "goal", label: "作为目标", hint: "明确进入执行工作流", icon: "i-lucide-goal" },
  { id: "discuss", label: "仅讨论", hint: "保存为讨论消息", icon: "i-lucide-message-circle" },
  { id: "intervene", label: "人工接管", hint: "打开治理接管操作", icon: "i-lucide-hand" },
  { id: "shadow", label: "影子建议", hint: "打开只读建议操作", icon: "i-lucide-eye" },
  { id: "decision", label: "决策台账", hint: "打开董事会决策", icon: "i-lucide-landmark" },
] as const

function restoreDraft() {
  const draft = parseComposerDraft(import.meta.client ? localStorage.getItem(storageKey.value) : null)
  body.value = draft.body
  resources.value = draft.resources
  mentions.value = []
  roles.value = []
  intent.value = "auto"
  requestID.value = import.meta.client ? crypto.randomUUID() : ""
  pendingRequestID.value = ""
  correctionRequestID.value = ""
  sending.value = false
  failure.value = ""
  feedback.value = ""
  menu.value = ""
}

watch(storageKey, restoreDraft, { immediate: true })
watch([body, resources], () => {
  if (!import.meta.client) return
  if (body.value || resources.value.length) {
    localStorage.setItem(storageKey.value, serializeComposerDraft(body.value, resources.value))
    return
  }
  localStorage.removeItem(storageKey.value)
}, { deep: true })
watch(() => props.sendResult, (result) => {
  if (!result || result.requestID !== pendingRequestID.value && result.requestID !== correctionRequestID.value) return
  sending.value = false
  feedback.value = result.feedback
  if (result.status === "failed") {
    failure.value = result.feedback
    return
  }
  if (result.requestID === correctionRequestID.value) {
    correctionRequestID.value = ""
    failure.value = ""
    return
  }
  body.value = ""
  mentions.value = []
  roles.value = []
  resources.value = []
  intent.value = "auto"
  failure.value = ""
  correctionRequestID.value = result.canPromote ? result.requestID : ""
  pendingRequestID.value = ""
  requestID.value = crypto.randomUUID()
  menu.value = ""
}, { deep: true })

function pickMention(agentID: string) {
  if (!mentions.value.includes(agentID) && mentions.value.length + roles.value.length >= MAX_MENTIONS) return
  mentions.value = toggleMention(mentions.value, agentID)
  body.value = body.value.replace(/(^|\s)@[^\s@]*$/, "$1")
  menu.value = ""
  nextTick(() => input.value?.focus())
}

function pickRole(role: "ceo" | "cto" | "product_lead") {
  if (roles.value.includes(role)) {
    roles.value = roles.value.filter(value => value !== role)
  } else {
    if (mentions.value.length + roles.value.length >= MAX_MENTIONS) return
    roles.value = [...roles.value, role]
  }
  body.value = body.value.replace(/(^|\s)@[^\s@]*$/, "$1")
  menu.value = ""
  nextTick(() => input.value?.focus())
}

function chooseCommand(command: typeof commands[number]["id"]) {
  body.value = body.value.replace(/^\/\S*/, "").trimStart()
  menu.value = ""
  if (command === "goal") {
    intent.value = "execute"
    input.value?.focus()
    return
  }
  if (command === "discuss") {
    intent.value = "discuss"
    input.value?.focus()
    return
  }
  if (command === "poll") {
    menu.value = "poll"
    return
  }
  emit("command", command)
}

function addResource() {
  resourceFailure.value = ""
  if (resources.value.length >= MAX_COMPOSER_RESOURCES) {
    resourceFailure.value = `每条消息最多添加 ${MAX_COMPOSER_RESOURCES} 个资源。`
    return
  }
  const resource = urlResource(resourceValue.value) ?? pathResource(resourceValue.value, resourceType.value)
  if (!resource) {
    resourceFailure.value = "请输入有效的 http(s) URL 或不含换行的本地路径。"
    return
  }
  if (resources.value.some(item => resourceLabel(item) === resourceLabel(resource))) {
    resourceFailure.value = "这个资源已添加。"
    return
  }
  resources.value = [...resources.value, resource]
  resourceValue.value = ""
}

async function attachTextFiles(event: Event) {
  resourceFailure.value = ""
  const element = event.currentTarget as HTMLInputElement
  for (const file of [...(element.files ?? [])]) {
    if (resources.value.length >= MAX_COMPOSER_RESOURCES) {
      resourceFailure.value = `每条消息最多添加 ${MAX_COMPOSER_RESOURCES} 个资源。`
      break
    }
    if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
      resourceFailure.value = `${file.name} 超过 ${Math.round(MAX_TEXT_ATTACHMENT_BYTES / 1000)}KB，未添加。`
      continue
    }
    if (!file.type.startsWith("text/") && !/\.(md|txt|json|csv|ya?ml|xml|html?|css|[cm]?[jt]sx?|py|sh)$/i.test(file.name)) {
      resourceFailure.value = `${file.name} 不是受支持的文本附件，未添加。`
      continue
    }
    const content = await file.text()
    const byteLength = new TextEncoder().encode(content).byteLength
    if (byteLength > MAX_TEXT_ATTACHMENT_BYTES) {
      resourceFailure.value = `${file.name} 解码后超过 ${Math.round(MAX_TEXT_ATTACHMENT_BYTES / 1000)}KB，未添加。`
      continue
    }
    resources.value = [...resources.value, {
      kind: "text_attachment",
      name: file.name,
      media_type: file.type || "text/plain",
      byte_length: byteLength,
      content,
    }]
  }
  element.value = ""
}

function send() {
  if (!body.value.trim() || sending.value) return
  sending.value = true
  failure.value = ""
  feedback.value = ""
  pendingRequestID.value = requestID.value
  emit("send", {
    requestID: requestID.value,
    body: body.value.trim(),
    mentions: [...mentions.value],
    roles: [...roles.value],
    resources: [...resources.value],
    intent: intent.value,
    replyToID: props.replyTo?.id,
  })
}

function publishPoll() {
  const options = pollOptions.value.map(option => option.trim()).filter(Boolean)
  if (!pollQuestion.value.trim() || options.length < 2) return
  emit("poll", { question: pollQuestion.value.trim(), options, multiple: pollMultiple.value })
  pollQuestion.value = ""
  pollOptions.value = ["", ""]
  pollMultiple.value = false
  menu.value = ""
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
  event.preventDefault()
  send()
}
</script>

<template>
  <section class="ac-boardroom-composer" :data-compact="compact || undefined" aria-label="发送消息">
    <div v-if="replyTo" class="ac-boardroom-composer__reply">
      <UIcon name="i-lucide-reply" />
      <div><strong>回复 {{ replyTo.author }}</strong><span>{{ replyTo.body }}</span></div>
      <button type="button" aria-label="取消回复" @click="$emit('cancelReply')"><UIcon name="i-lucide-x" /></button>
    </div>
    <div v-if="intent !== 'auto'" class="ac-boardroom-composer__intent">
      <span>{{ intent === "execute" ? "作为目标执行" : "仅讨论" }}</span>
      <button type="button" @click="intent = 'auto'">恢复自动判断</button>
    </div>
    <div v-if="resources.length" class="ac-boardroom-composer__chips">
      <span v-for="(resource, index) in resources" :key="`${resource.kind}:${resourceLabel(resource)}:${index}`" :title="resourceImpact(resource)">
        <UIcon name="i-lucide-paperclip" />{{ resourceLabel(resource) }}
        <button type="button" :aria-label="`移除 ${resourceLabel(resource)}`" @click="resources = resources.filter((_, current) => current !== index)"><UIcon name="i-lucide-x" /></button>
      </span>
    </div>
    <div class="ac-boardroom-composer__surface">
      <textarea
        ref="input"
        v-model="body"
        rows="1"
        maxlength="20000"
        :disabled="sending"
        :placeholder="compact ? '回复线程…' : '输入消息，@ 提及团队成员，/ 打开命令…'"
        @keydown="onKeydown"
      />
      <div class="ac-boardroom-composer__toolbar">
        <button type="button" aria-label="添加内容" :data-active="menu === 'add' || undefined" @click="menu = menu === 'add' ? '' : 'add'"><UIcon name="i-lucide-plus" /></button>
        <button type="button" aria-label="提及成员" :data-active="menu === 'mention' || undefined" @click="menu = menu === 'mention' ? '' : 'mention'"><UIcon name="i-lucide-at-sign" /></button>
        <button type="button" aria-label="快捷命令" :data-active="menu === 'command' || undefined" @click="menu = menu === 'command' ? '' : 'command'"><UIcon name="i-lucide-command" /></button>
        <button class="ac-boardroom-composer__send" type="button" :disabled="!body.trim() || sending" @click="send">
          <UIcon :name="sending ? 'i-lucide-loader-circle' : 'i-lucide-send'" />
          <span>{{ sending ? "发送中" : "发送" }}</span>
        </button>
      </div>
    </div>

    <div v-if="menu === 'add'" class="ac-boardroom-composer__menu ac-boardroom-composer__menu--compact">
      <button type="button" @click="menu = 'resource'"><UIcon name="i-lucide-link-2" /><span>引用资源<small>URL、文件或目录路径</small></span></button>
      <button type="button" @click="filePicker?.click(); menu = ''"><UIcon name="i-lucide-file-text" /><span>文本附件<small>最多 200KB</small></span></button>
      <button v-if="room.kind === 'company'" type="button" @click="menu = 'poll'"><UIcon name="i-lucide-chart-no-axes-column" /><span>发起投票<small>发布到当前董事会</small></span></button>
    </div>

    <div v-if="menu === 'mention' || mentionOpen" class="ac-boardroom-composer__menu">
      <button v-for="role in roleOptions" :key="role.id" type="button" :data-active="roles.includes(role.id) || undefined" @click="pickRole(role.id)">
        <span class="ac-boardroom-composer__mention-mark">@</span><span>{{ role.label }}<small>角色</small></span>
      </button>
      <button v-for="participant in participants" :key="participant.id" type="button" :data-active="mentions.includes(participant.id) || undefined" @click="pickMention(participant.id)">
        <AppAvatar :name="participant.name" :size="26" :tone="participant.tone" :status="participant.status" /><span>{{ participant.name }}<small>{{ participant.role }}</small></span>
      </button>
    </div>

    <div v-if="menu === 'command' || slashOpen" class="ac-boardroom-composer__menu">
      <button v-for="command in commands" :key="command.id" type="button" @click="chooseCommand(command.id)">
        <UIcon :name="command.icon" /><span>/{{ command.id }} · {{ command.label }}<small>{{ command.hint }}</small></span>
      </button>
    </div>

    <form v-if="menu === 'resource'" class="ac-boardroom-composer__popover" @submit.prevent="addResource">
      <strong>引用资源</strong>
      <input v-model="resourceValue" maxlength="4000" placeholder="https:// URL 或本地路径">
      <select v-model="resourceType" aria-label="本地路径类型"><option value="unknown">自动识别路径</option><option value="file">本地文件</option><option value="directory">本地目录</option></select>
      <p v-if="resourceFailure" role="alert">{{ resourceFailure }}</p>
      <div><button type="button" @click="menu = ''">取消</button><AppButton type="submit" variant="primary" size="sm" :disabled="!resourceValue.trim()">添加</AppButton></div>
    </form>

    <form v-if="menu === 'poll'" class="ac-boardroom-composer__popover" @submit.prevent="publishPoll">
      <strong>发起投票</strong>
      <input v-model="pollQuestion" maxlength="500" placeholder="投票问题">
      <input v-for="(_, index) in pollOptions" :key="index" v-model="pollOptions[index]" maxlength="300" :placeholder="`选项 ${index + 1}`">
      <label><input v-model="pollMultiple" type="checkbox">允许多选</label>
      <div><button v-if="pollOptions.length < 12" type="button" @click="pollOptions.push('')">添加选项</button><AppButton type="submit" variant="primary" size="sm" :disabled="!pollQuestion.trim() || pollOptions.filter(option => option.trim()).length < 2">发布投票</AppButton></div>
    </form>

    <input ref="filePicker" type="file" class="ac-boardroom-composer__file" multiple accept="text/*,.md,.json,.csv,.yaml,.yml,.xml,.html,.css,.js,.ts,.tsx,.vue,.py,.sh" @change="attachTextFiles">
    <p v-if="failure" class="ac-boardroom-composer__error" role="alert">{{ failure }}</p>
    <div v-else-if="feedback" class="ac-boardroom-composer__feedback" role="status">
      <span>{{ feedback }}</span>
      <button v-if="sendResult?.canPromote" type="button" @click="correctionRequestID = sendResult.requestID; $emit('promote', sendResult.requestID)">作为目标执行</button>
    </div>
  </section>
</template>

<style scoped>
.ac-boardroom-composer {
  position: relative;
  z-index: 4;
  width: min(760px, calc(100% - 36px));
  margin: 0 auto;
  padding: 0 0 18px;
}

.ac-boardroom-composer[data-compact] { width: 100%; padding: 12px; }

.ac-boardroom-composer__surface {
  overflow: hidden;
  border: 1px solid var(--ac-boardroom-ink-100);
  border-radius: 14px;
  background: var(--ac-boardroom-cloud);
  box-shadow: var(--ac-boardroom-shadow-control);
  transition: border-color var(--ac-boardroom-motion-base), box-shadow var(--ac-boardroom-motion-base);
}

.ac-boardroom-composer__surface:focus-within { border-color: var(--ac-boardroom-accent-300); box-shadow: var(--ac-boardroom-shadow-control), 0 0 0 3px var(--ac-boardroom-accent-50); }

.ac-boardroom-composer textarea {
  display: block;
  width: 100%;
  min-height: 50px;
  max-height: 160px;
  resize: vertical;
  border: 0;
  padding: 13px 14px 6px;
  background: transparent;
  color: var(--ac-boardroom-ink-900);
  font: 13px/1.55 var(--ac-boardroom-font-sans);
  outline: 0;
}

.ac-boardroom-composer textarea::placeholder { color: var(--ac-boardroom-ink-300); }
.ac-boardroom-composer__toolbar { display: flex; align-items: center; gap: 2px; padding: 5px 6px 6px; }
.ac-boardroom-composer__toolbar > button { display: grid; width: 32px; height: 32px; place-items: center; border: 0; border-radius: var(--ac-boardroom-radius-sm); background: transparent; color: var(--ac-boardroom-ink-500); cursor: pointer; }
.ac-boardroom-composer__toolbar > button[data-active] { background: var(--ac-boardroom-accent-50); color: var(--ac-boardroom-accent-ink); }
.ac-boardroom-composer__toolbar svg { width: 17px; height: 17px; }
.ac-boardroom-composer__toolbar .ac-boardroom-composer__send { display: flex; width: auto; min-width: 78px; margin-left: auto; padding: 0 12px; gap: 7px; background: var(--ac-boardroom-accent-strong); color: var(--ac-boardroom-cloud); font-size: 11.5px; font-weight: 720; }
.ac-boardroom-composer__send:disabled { opacity: 0.42; cursor: not-allowed; }
.ac-boardroom-composer__send svg[name*="loader"] { animation: ac-boardroom-spin 700ms linear infinite; }

.ac-boardroom-composer__reply,
.ac-boardroom-composer__intent,
.ac-boardroom-composer__chips { display: flex; align-items: center; gap: 8px; margin: 0 8px -1px; border: 1px solid var(--ac-boardroom-ink-100); border-bottom: 0; border-radius: 10px 10px 0 0; padding: 7px 10px 8px; background: var(--ac-boardroom-sidebar); color: var(--ac-boardroom-ink-500); font-size: 10.5px; }
.ac-boardroom-composer__reply > svg { width: 14px; height: 14px; flex: none; color: var(--ac-boardroom-accent-strong); }
.ac-boardroom-composer__reply > div { display: grid; min-width: 0; flex: 1; }
.ac-boardroom-composer__reply strong { color: var(--ac-boardroom-ink-700); }
.ac-boardroom-composer__reply span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-boardroom-composer__reply > button,
.ac-boardroom-composer__intent button { border: 0; background: transparent; color: var(--ac-boardroom-accent-strong); cursor: pointer; font-size: 10px; }
.ac-boardroom-composer__reply > button svg { width: 14px; height: 14px; }
.ac-boardroom-composer__intent { justify-content: space-between; color: var(--ac-boardroom-accent-ink); }
.ac-boardroom-composer__chips { flex-wrap: wrap; border-radius: 10px 10px 0 0; }
.ac-boardroom-composer__chips > span { display: flex; max-width: 240px; align-items: center; gap: 4px; border-radius: var(--ac-boardroom-radius-pill); padding: 3px 7px; background: var(--ac-boardroom-cloud); color: var(--ac-boardroom-ink-700); }
.ac-boardroom-composer__chips > span > svg { width: 11px; height: 11px; flex: none; }
.ac-boardroom-composer__chips > span > button { display: grid; width: 15px; height: 15px; place-items: center; border: 0; padding: 0; background: transparent; color: var(--ac-boardroom-ink-300); cursor: pointer; }

.ac-boardroom-composer__menu,
.ac-boardroom-composer__popover { position: absolute; z-index: 12; left: 0; bottom: calc(100% - 4px); display: grid; width: min(330px, 100%); max-height: 320px; overflow: auto; border: 1px solid var(--ac-boardroom-ink-100); border-radius: var(--ac-boardroom-radius-md); padding: 5px; background: var(--ac-boardroom-cloud); box-shadow: var(--ac-boardroom-shadow-popover); }
.ac-boardroom-composer__menu--compact { width: 270px; }
.ac-boardroom-composer__menu > button { display: grid; grid-template-columns: 30px minmax(0, 1fr); align-items: center; gap: 8px; border: 0; border-radius: var(--ac-boardroom-radius-sm); padding: 7px 8px; background: transparent; color: var(--ac-boardroom-ink-700); cursor: pointer; text-align: left; }
.ac-boardroom-composer__menu > button[data-active] { background: var(--ac-boardroom-accent-50); color: var(--ac-boardroom-accent-ink); }
.ac-boardroom-composer__menu > button > svg { width: 17px; height: 17px; justify-self: center; color: var(--ac-boardroom-ink-500); }
.ac-boardroom-composer__menu > button > span:not(.ac-ui-avatar) { display: grid; min-width: 0; font-size: 11.5px; font-weight: 650; }
.ac-boardroom-composer__menu small { color: var(--ac-boardroom-ink-500); font-size: 9.5px; font-weight: 450; }
.ac-boardroom-composer__mention-mark { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 50%; background: var(--ac-boardroom-accent-50); color: var(--ac-boardroom-accent-strong); font-weight: 800; }

.ac-boardroom-composer__popover { gap: 8px; padding: 12px; }
.ac-boardroom-composer__popover > strong { color: var(--ac-boardroom-ink-900); font-size: 12px; }
.ac-boardroom-composer__popover input:not([type="checkbox"]),
.ac-boardroom-composer__popover select { width: 100%; min-height: 36px; border: 1px solid var(--ac-boardroom-ink-100); border-radius: var(--ac-boardroom-radius-sm); padding: 0 9px; background: var(--ac-boardroom-paper); color: var(--ac-boardroom-ink-700); font-size: 11px; outline: 0; }
.ac-boardroom-composer__popover label { display: flex; align-items: center; gap: 7px; color: var(--ac-boardroom-ink-500); font-size: 10.5px; }
.ac-boardroom-composer__popover > p { margin: 0; color: var(--ac-boardroom-danger); font-size: 10px; }
.ac-boardroom-composer__popover > div { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.ac-boardroom-composer__popover > div > button:not(.ac-ui-button) { border: 0; background: transparent; color: var(--ac-boardroom-ink-500); cursor: pointer; font-size: 10.5px; }

.ac-boardroom-composer__file { display: none; }
.ac-boardroom-composer__error,
.ac-boardroom-composer__feedback { margin: 6px 8px 0; color: var(--ac-boardroom-danger); font-size: 10.5px; }
.ac-boardroom-composer__feedback { color: var(--ac-boardroom-success); }
.ac-boardroom-composer__feedback { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ac-boardroom-composer__feedback button { border: 0; background: transparent; color: var(--ac-boardroom-accent-strong); cursor: pointer; font-size: 10.5px; font-weight: 700; }

@media (hover: hover) {
  .ac-boardroom-composer__toolbar > button:hover:not(:disabled),
  .ac-boardroom-composer__menu > button:hover { background: var(--ac-boardroom-accent-50); color: var(--ac-boardroom-accent-ink); }
  .ac-boardroom-composer__toolbar .ac-boardroom-composer__send:hover:not(:disabled) { background: var(--ac-boardroom-accent-ink); color: var(--ac-boardroom-cloud); }
}

@media (max-width: 720px) {
  .ac-boardroom-composer { width: calc(100% - 20px); padding-bottom: 10px; }
  .ac-boardroom-composer textarea { min-height: 46px; }
  .ac-boardroom-composer__toolbar .ac-boardroom-composer__send { min-width: 34px; padding: 0 8px; }
  .ac-boardroom-composer__send span { display: none; }
}
</style>
