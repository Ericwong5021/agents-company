<script setup lang="ts">
import type {
  CompanyOperationCategory,
  CompanyOperationItem,
  CompanyOperationPage,
  CompanyOperationSeverity,
  CompanyOperationSummary,
} from "../../../modules/agent-company/runtime/shared/company-operations"

const { data: snapshot, signalVersion, streamStatus } = useCompanySnapshot()
const route = useRoute()
const category = ref<CompanyOperationCategory | "">("")
const severity = ref<CompanyOperationSeverity | "">("")
const importance = ref<"primary" | "normal" | "diagnostic" | "">("")
const projectID = ref("")
const agentID = ref("")
const timeRange = ref<"24h" | "7d" | "all">("24h")
const items = ref<CompanyOperationItem[]>([])
const nextCursor = ref<string>()
const summary = ref<CompanyOperationSummary>({ total24h: 0, errors24h: 0, warnings24h: 0, recoveries24h: 0 })
const status = ref<"pending" | "success" | "error">("pending")
const errorMessage = ref("")
const loadingMore = ref(false)
const newRecordsAvailable = ref(false)
const expanded = ref<string>()
const detailLoading = ref<string>()
const detailErrors = ref<Record<string, string>>({})
const detailItems = ref<Record<string, CompanyOperationItem>>({})
const rangeAnchor = ref(Date.now())
let requestGeneration = 0

const categoryLabels: Record<CompanyOperationCategory, string> = {
  governance: "治理",
  work: "工作",
  runtime: "运行",
  quality: "质量",
  delivery: "交付",
  organization: "组织",
  system: "系统",
}
const severityLabels: Record<CompanyOperationSeverity, string> = { info: "记录", warning: "注意", error: "异常" }
const importanceLabels = { primary: "主要", normal: "常规", diagnostic: "诊断" }
const dayFormatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" })
const timeFormatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
const relativeFormatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" })

function filterQuery(limit = "50") {
  return {
    ...(category.value ? { category: category.value } : {}),
    ...(severity.value ? { severity: severity.value } : {}),
    ...(importance.value ? { importance: importance.value } : {}),
    ...(projectID.value ? { project_id: projectID.value } : {}),
    ...(agentID.value ? { agent_id: agentID.value } : {}),
    ...(timeRange.value === "all" ? {} : { from: String(rangeAnchor.value - (timeRange.value === "24h" ? 24 : 7 * 24) * 60 * 60 * 1_000) }),
    limit,
  }
}
const groupedItems = computed(() => items.value.reduce<Array<{ date: string; items: CompanyOperationItem[] }>>((groups, item) => {
  const date = dayFormatter.format(item.occurredAt)
  const previous = groups.at(-1)
  if (previous?.date === date) previous.items.push(item)
  else groups.push({ date, items: [item] })
  return groups
}, []))
const hasMore = computed(() => Boolean(nextCursor.value))

function operationURL(cursor?: string, limit?: string) {
  const params = new URLSearchParams({ ...filterQuery(limit), ...(cursor ? { cursor } : {}) })
  return `/api/agent-company/operations?${params}`
}

function errorText(error: unknown) {
  if (error && typeof error === "object" && "statusMessage" in error && typeof error.statusMessage === "string") return error.statusMessage
  return "暂时无法读取运营记录。"
}

async function load(reset = true) {
  const generation = ++requestGeneration
  rangeAnchor.value = Date.now()
  if (reset) status.value = "pending"
  loadingMore.value = false
  errorMessage.value = ""
  const [page, nextSummary] = await Promise.all([
    $fetch<CompanyOperationPage>(operationURL()).then(value => ({ value }), error => ({ error })),
    $fetch<CompanyOperationSummary>("/api/agent-company/operations/summary").then(value => ({ value }), () => ({})),
  ])
  if (generation !== requestGeneration) return
  if (!("value" in page)) {
    status.value = "error"
    errorMessage.value = errorText(page.error)
    return
  }
  items.value = page.value.items
  nextCursor.value = page.value.nextCursor
  if ("value" in nextSummary) summary.value = nextSummary.value
  status.value = "success"
  newRecordsAvailable.value = false
  expanded.value = undefined
}

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return
  const generation = requestGeneration
  const cursor = nextCursor.value
  loadingMore.value = true
  errorMessage.value = ""
  const page = await $fetch<CompanyOperationPage>(operationURL(cursor)).then(value => ({ value }), error => ({ error }))
  if (generation !== requestGeneration || cursor !== nextCursor.value) return
  loadingMore.value = false
  if (!("value" in page)) {
    errorMessage.value = errorText(page.error)
    return
  }
  items.value = [...items.value, ...page.value.items]
  nextCursor.value = page.value.nextCursor
}

async function toggleDetail(item: CompanyOperationItem) {
  if (expanded.value === item.id) {
    expanded.value = undefined
    return
  }
  expanded.value = item.id
  if (detailItems.value[item.id] || detailLoading.value === item.id) return
  await loadDetail(item.id)
}

async function loadDetail(operationID: string) {
  detailLoading.value = operationID
  const nextErrors = { ...detailErrors.value }
  delete nextErrors[operationID]
  detailErrors.value = nextErrors
  const item = await $fetch<CompanyOperationItem>(`/api/agent-company/operations/${encodeURIComponent(operationID)}`).then(value => ({ value }), error => ({ error }))
  if ("value" in item) {
    detailItems.value = { ...detailItems.value, [operationID]: item.value }
  } else {
    detailErrors.value = { ...detailErrors.value, [operationID]: errorText(item.error) }
  }
  if (detailLoading.value === operationID) detailLoading.value = undefined
}

function timeAgo(value: number) {
  const minutes = Math.round((value - Date.now()) / 60_000)
  if (Math.abs(minutes) < 60) return relativeFormatter.format(minutes, "minute")
  return timeFormatter.format(value)
}

function detailItem(operationID: string) {
  return detailItems.value[operationID]
}

async function probeNewRecords() {
  if (status.value !== "success") return
  const generation = requestGeneration
  const currentID = items.value[0]?.id
  const page = await $fetch<CompanyOperationPage>(operationURL(undefined, "1")).catch(() => undefined)
  if (generation !== requestGeneration || status.value !== "success") return
  if (page?.items[0]?.id && page.items[0].id !== currentID) newRecordsAvailable.value = true
}

watch([category, severity, importance, projectID, agentID, timeRange], () => void load())
watch(signalVersion, (version, previous) => {
  if (route.path !== "/company/operations") return
  if (version > previous) void probeNewRecords()
})

onMounted(() => void load())
</script>

<template>
  <UDashboardPanel id="company-operations" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar>
        <span class="ac-operations__stream" :data-state="streamStatus">
          <span />{{ streamStatus === "live" ? "实时连接" : streamStatus === "connecting" ? "正在连接" : "连接不稳定" }}
        </span>
      </Navbar>
    </template>

    <template #body>
      <div class="ac-operations">
        <header class="ac-operations__header">
          <div>
            <p class="company-eyebrow">公司运营日志</p>
            <h1>每一项运行，都有据可查</h1>
            <p>按发生时间记录工作、治理、交付与异常信号。日志只反映已持久化的本地事实。</p>
          </div>
          <button v-if="newRecordsAvailable" class="ac-operations__new" type="button" @click="load()">
            <UIcon name="i-lucide-arrow-up" />有新记录，刷新查看
          </button>
        </header>

        <section class="ac-operations__summary" aria-label="近 24 小时摘要">
          <div><span>近 24 小时</span><strong>{{ summary.total24h }}</strong><small>全部记录</small></div>
          <div data-tone="error"><span>异常</span><strong>{{ summary.errors24h }}</strong><small>需要关注</small></div>
          <div data-tone="warning"><span>注意</span><strong>{{ summary.warnings24h }}</strong><small>待持续观察</small></div>
          <div data-tone="positive"><span>恢复与完成</span><strong>{{ summary.recoveries24h }}</strong><small>已恢复推进</small></div>
        </section>

        <section class="ac-operations__filters" aria-label="筛选运营日志">
          <label>类别
            <select v-model="category">
              <option value="">全部类别</option>
              <option v-for="(label, value) in categoryLabels" :key="value" :value="value">{{ label }}</option>
            </select>
          </label>
          <label>级别
            <select v-model="severity">
              <option value="">全部级别</option>
              <option v-for="(label, value) in severityLabels" :key="value" :value="value">{{ label }}</option>
            </select>
          </label>
          <label>重要性
            <select v-model="importance">
              <option value="">全部重要性</option>
              <option v-for="(label, value) in importanceLabels" :key="value" :value="value">{{ label }}</option>
            </select>
          </label>
          <label>时间
            <select v-model="timeRange">
              <option value="24h">近 24 小时</option>
              <option value="7d">近 7 天</option>
              <option value="all">全部时间</option>
            </select>
          </label>
          <label>工作
            <select v-model="projectID">
              <option value="">全部工作</option>
              <option v-for="project in snapshot.projects" :key="project.id" :value="project.id">{{ project.title }}</option>
            </select>
          </label>
          <label>Agent
            <select v-model="agentID">
              <option value="">全部 Agent</option>
              <option v-for="agent in snapshot.agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
            </select>
          </label>
          <button type="button" :disabled="status === 'pending'" @click="load()"><UIcon name="i-lucide-refresh-cw" />刷新</button>
        </section>

        <section v-if="status === 'pending'" class="ac-operations__state" aria-live="polite">
          <UIcon name="i-lucide-loader-circle" class="animate-spin" />正在读取运营记录
        </section>
        <section v-else-if="status === 'error'" class="ac-operations__state" data-state="error" role="alert">
          <UIcon name="i-lucide-circle-alert" /><div><strong>运营记录暂时不可用</strong><span>{{ errorMessage }}</span></div><button type="button" @click="load()">重试</button>
        </section>
        <section v-else-if="!items.length" class="ac-operations__state">
          <UIcon name="i-lucide-list-x" /><div><strong>还没有符合条件的运营记录</strong><span>公司开始产生可持久化的运行事件后，会在这里按时间出现。</span></div>
        </section>

        <div v-else class="ac-operations__timeline">
          <section v-for="group in groupedItems" :key="group.date" class="ac-operations__day">
            <h2>{{ group.date }}</h2>
            <ol>
              <li v-for="item in group.items" :key="item.id" :data-severity="item.severity">
                <time :datetime="new Date(item.occurredAt).toISOString()">{{ timeAgo(item.occurredAt) }}</time>
                <article>
                  <button class="ac-operations__row" type="button" :aria-expanded="expanded === item.id" @click="toggleDetail(item)">
                    <span class="ac-operations__marker" aria-hidden="true" />
                    <span class="ac-operations__content">
                      <span class="ac-operations__meta"><span>{{ categoryLabels[item.category] }}</span><span>{{ severityLabels[item.severity] }}</span><span v-if="item.importance === 'primary'">主要</span></span>
                      <strong>{{ item.title }}</strong>
                      <small v-if="item.summary">{{ item.summary }}</small>
                      <small v-else-if="item.context.project">{{ item.context.project.title }}</small>
                    </span>
                    <UIcon :name="expanded === item.id ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
                  </button>
                  <div v-if="expanded === item.id" class="ac-operations__detail">
                    <span v-if="detailLoading === item.id">正在读取详情</span>
                    <template v-else-if="detailItem(item.id)">
                      <dl v-if="detailItem(item.id)?.details?.length">
                        <div v-for="detail in detailItem(item.id)?.details ?? []" :key="detail.label"><dt>{{ detail.label }}</dt><dd>{{ detail.value }}</dd></div>
                      </dl>
                      <p v-else>这条记录没有更多可展示的安全详情。</p>
                      <NuxtLink :to="detailItem(item.id)?.href ?? item.href">打开关联工作<UIcon name="i-lucide-arrow-up-right" /></NuxtLink>
                    </template>
                    <div v-else data-state="error"><span>{{ detailErrors[item.id] ?? "详情暂时不可用" }}</span><button type="button" @click="loadDetail(item.id)">重试</button></div>
                  </div>
                </article>
              </li>
            </ol>
          </section>
          <button v-if="nextCursor" class="ac-operations__more" type="button" :disabled="loadingMore" @click="loadMore">
            <UIcon v-if="loadingMore" name="i-lucide-loader-circle" class="animate-spin" />{{ loadingMore ? "正在加载" : "加载更早记录" }}
          </button>
          <p v-if="errorMessage" class="ac-operations__load-error" role="alert">{{ errorMessage }}</p>
          <p v-else-if="!hasMore" class="ac-operations__end">已显示全部符合条件的记录</p>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
