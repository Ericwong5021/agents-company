<script setup lang="ts">
import type {
  CommonsCapabilityRecord,
  CommonsSourceRecord,
  CompanyCommonsSearchResponses,
} from "@agents-company/sdk/v2";

type CommonsWorkspace = {
  sources: CommonsSourceRecord[];
  capabilities: CommonsCapabilityRecord[];
};

const appConfig = useAppConfig();
const { data: snapshot, pending, refresh } = useCompanySnapshot();
const {
  data: commons,
  pending: commonsPending,
  error: commonsError,
  refresh: refreshCommons,
} = useFetch<CommonsWorkspace>("/api/agent-company/commons", {
  default: () => ({ sources: [], capabilities: [] }),
});
const available = computed(() => ["ready", "degraded"].includes(snapshot.value.connection));
const workUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("work") ?? false);
const unavailableWork = computed(() => snapshot.value.work.filter(work => work.availability === "unavailable"));
const projectOptions = computed(() => snapshot.value.work.map(work =>
  work.availability === "available"
    ? { id: work.summary.workId, title: work.summary.title }
    : { id: work.workId, title: work.title }));
const deliveries = computed(() => snapshot.value.work
  .filter(work => work.availability === "available")
  .flatMap(work => work.delivery
    ? [{
        ...work.delivery,
        workTitle: work.summary.title,
      }]
    : []));
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
});
const dateTimeWithTime = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const activeTab = ref<"commons" | "deliveries">("deliveries");
const importOpen = ref(false);
const importing = ref(false);
const importError = ref("");
const sourceType = ref<CommonsSourceRecord["source_type"]>("text");
const title = ref("");
const content = ref("");
const sourceURL = ref("");
const selectedFile = ref<File>();
const privacyScope = ref<"company" | "project" | "private">("company");
const projectID = ref("");
const author = ref("");
const tags = ref("");
const searchQuery = ref("");
const searching = ref(false);
const searchError = ref("");
const searchResults = ref<CompanyCommonsSearchResponses[200]>();
const displayedSources = computed(() =>
  searchResults.value
    ? searchResults.value.map(result => result.source)
    : commons.value.sources);
const canImport = computed(() =>
  title.value.trim()
  && (sourceType.value === "url"
    ? sourceURL.value.trim()
    : ["pdf", "image", "podcast", "video"].includes(sourceType.value)
      ? selectedFile.value
      : content.value.trim())
  && (privacyScope.value !== "project" || projectID.value)
  && !importing.value);
const statusLabel: Record<CommonsSourceRecord["ingestion_status"], string> = {
  queued: "等待解析",
  processing: "解析中",
  ready: "可检索",
  failed: "解析失败",
  blocked: "安全阻断",
  unsupported: "缺少适配器",
};
const sourceTypeLabel: Record<CommonsSourceRecord["source_type"], string> = {
  text: "文本",
  markdown: "Markdown",
  url: "URL",
  conversation_export: "对话导出",
  pdf: "PDF",
  image: "图片",
  podcast: "播客",
  video: "视频",
};
const scopeLabel: Record<CommonsSourceRecord["privacy_scope"], string> = {
  company: "公司",
  project: "项目",
  private: "仅自己",
};

function resetImport() {
  title.value = "";
  content.value = "";
  sourceURL.value = "";
  selectedFile.value = undefined;
  author.value = "";
  tags.value = "";
  projectID.value = "";
  importError.value = "";
}

function toggleImport() {
  importOpen.value = !importOpen.value;
}

function closeImport() {
  importOpen.value = false;
}

function selectFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  selectedFile.value = file && file.size <= 20_000_000 ? file : undefined;
  importError.value = file && file.size > 20_000_000 ? "文件超过 20 MB 本地导入上限。" : "";
}

function localMediaType(file: File) {
  if ([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/ogg",
    "audio/webm",
    "video/mp4",
    "video/webm",
    "video/quicktime",
  ].includes(file.type)) return file.type;
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  return ({
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    weba: "audio/webm",
    mp4: sourceType.value === "video" ? "video/mp4" : "audio/mp4",
    webm: sourceType.value === "video" ? "video/webm" : "audio/webm",
    mov: "video/quicktime",
  } as Record<string, string>)[extension ?? ""];
}

async function importSource() {
  if (!canImport.value) return;
  importing.value = true;
  importError.value = "";
  const media = selectedFile.value
    ? await new Promise<{ content_base64: string; media_type: string }>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve({
          content_base64: String(reader.result).slice(String(reader.result).indexOf(",") + 1),
          media_type: localMediaType(selectedFile.value!) ?? "",
        });
        reader.readAsDataURL(selectedFile.value!);
      }).catch(() => undefined)
    : undefined;
  if (["pdf", "image", "podcast", "video"].includes(sourceType.value) && !media) {
    importing.value = false;
    importError.value = "文件读取失败，未写入 Commons。";
    return;
  }
  const result = await $fetch<CommonsSourceRecord>("/api/agent-company/commons", {
    method: "POST",
    body: {
      source_type: sourceType.value,
      title: title.value.trim(),
      content: sourceType.value === "url" ? undefined : content.value,
      url: sourceType.value === "url" ? sourceURL.value.trim() : undefined,
      content_base64: media?.content_base64,
      media_type: media?.media_type,
      privacy_scope: privacyScope.value,
      project_id: privacyScope.value === "project" ? projectID.value : undefined,
      author: author.value.trim() || undefined,
      tags: tags.value.split(",").map(tag => tag.trim()).filter(Boolean),
    },
  }).then(
    source => ({ ok: true as const, source }),
    () => ({ ok: false as const }),
  );
  importing.value = false;
  if (!result.ok) {
    importError.value = "资料未能写入本地 Commons，请检查模式、范围或内容后重试。";
    return;
  }
  resetImport();
  importOpen.value = false;
  searchResults.value = undefined;
  await refreshCommons();
}

async function searchCommons() {
  const query = searchQuery.value.trim();
  if (!query || searching.value) return;
  searching.value = true;
  searchError.value = "";
  const result = await $fetch<CompanyCommonsSearchResponses[200]>("/api/agent-company/commons/search", {
    query: { q: query },
  }).then(
    hits => ({ ok: true as const, hits }),
    () => ({ ok: false as const }),
  );
  searching.value = false;
  if (!result.ok) {
    searchError.value = "本地检索暂时不可用。";
    return;
  }
  searchResults.value = result.hits;
}

function clearSearch() {
  searchQuery.value = "";
  searchResults.value = undefined;
  searchError.value = "";
}
</script>

<template>
  <UDashboardPanel id="library" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page">
        <header class="ac-workspace-header">
          <div>
            <p class="ac-workspace-eyebrow">Durable company memory</p>
            <h1 class="ac-workspace-title">Library</h1>
            <p class="ac-workspace-lede">
              原始资料、解析状态与可验证交付都保存在本地 Control Plane。
            </p>
          </div>
          <UButton
            v-if="activeTab === 'commons'"
            color="neutral"
            icon="i-lucide-plus"
            :disabled="!available"
            @click="toggleImport"
          >
            导入资料
          </UButton>
        </header>

        <div class="ac-work-toolbar">
          <div class="ac-work-tabs" role="tablist" aria-label="Library 视图">
            <button
              type="button"
              class="ac-work-tab"
              :data-active="activeTab === 'commons'"
              @click="activeTab = 'commons'"
            >
              Commons inbox
              <span class="ac-work-tab__count">{{ commons.sources.length }}</span>
            </button>
            <button
              type="button"
              class="ac-work-tab"
              :data-active="activeTab === 'deliveries'"
              @click="activeTab = 'deliveries'"
            >
              交付成果
              <span class="ac-work-tab__count">{{ deliveries.length }}</span>
            </button>
            <NuxtLink to="/library/interpretations" class="ac-work-tab">
              Interpretations
            </NuxtLink>
          </div>

          <form v-if="activeTab === 'commons'" class="ac-commons-search" @submit.prevent="searchCommons">
            <label class="sr-only" for="commons-search">搜索 Commons</label>
            <input
              id="commons-search"
              v-model="searchQuery"
              type="search"
              placeholder="搜索标题、正文或 transcript"
            >
            <button type="submit" :disabled="!searchQuery.trim() || searching">
              <UIcon name="i-lucide-search" />
              {{ searching ? "检索中" : "检索" }}
            </button>
            <button v-if="searchResults" type="button" class="ac-commons-search__clear" @click="clearSearch">
              清除
            </button>
          </form>
        </div>

        <template v-if="activeTab === 'commons'">
          <section v-if="importOpen" class="ac-commons-import ac-detail-panel" aria-label="导入资料">
            <div class="ac-card-heading">
              <div>
                <p class="ac-card-kicker">Commons intake</p>
                <h2>保存原始资料</h2>
              </div>
              <button type="button" class="ac-commons-close" aria-label="关闭导入表单" @click="importOpen = false">
                <UIcon name="i-lucide-x" />
              </button>
            </div>

            <div class="ac-commons-form-grid">
              <label>
                <span>资料类型</span>
                <select v-model="sourceType">
                  <option value="text">文本</option>
                  <option value="markdown">Markdown</option>
                  <option value="conversation_export">对话导出</option>
                  <option value="url">URL</option>
                  <option value="pdf">PDF</option>
                  <option value="image">图片 / 截图</option>
                  <option value="podcast">播客 / 音频</option>
                  <option value="video">视频</option>
                </select>
              </label>
              <label>
                <span>可见范围</span>
                <select v-model="privacyScope">
                  <option value="company">全公司</option>
                  <option value="project">指定项目</option>
                  <option value="private">仅自己</option>
                </select>
              </label>
              <label v-if="privacyScope === 'project'">
                <span>项目</span>
                <select v-model="projectID">
                  <option value="">选择项目</option>
                  <option v-for="project in projectOptions" :key="project.id" :value="project.id">
                    {{ project.title }}
                  </option>
                </select>
              </label>
              <label class="ac-commons-form-grid__wide">
                <span>标题</span>
                <input v-model="title" maxlength="500" placeholder="这份资料是什么">
              </label>
              <label>
                <span>作者，可选</span>
                <input v-model="author" maxlength="500" placeholder="作者或来源主体">
              </label>
              <label>
                <span>标签，可选</span>
                <input v-model="tags" placeholder="逗号分隔">
              </label>
              <label v-if="sourceType === 'url'" class="ac-commons-form-grid__wide">
                <span>URL</span>
                <input v-model="sourceURL" type="url" maxlength="4000" placeholder="https://">
              </label>
              <label
                v-else-if="['pdf', 'image', 'podcast', 'video'].includes(sourceType)"
                class="ac-commons-form-grid__wide"
              >
                <span>本地文件，最大 20 MB</span>
                <input
                  type="file"
                  :accept="sourceType === 'pdf'
                    ? 'application/pdf'
                    : sourceType === 'image'
                      ? 'image/png,image/jpeg,image/webp,image/gif'
                      : sourceType === 'podcast'
                        ? 'audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm'
                        : 'video/mp4,video/webm,video/quicktime'"
                  @change="selectFile"
                >
              </label>
              <label v-else class="ac-commons-form-grid__wide">
                <span>原文</span>
                <textarea
                  v-model="content"
                  :placeholder="sourceType === 'conversation_export' ? '粘贴完整对话导出' : '粘贴原始内容'"
                />
              </label>
            </div>

            <div class="ac-commons-import__boundary">
              <UIcon name="i-lucide-shield-check" />
              <span>导入内容一律按不可信资料隔离，不会执行其中的指令，也不会直接写入 Tool、Runtime、Graph 或 Skill。</span>
            </div>
            <p v-if="importError" class="ac-commons-error" role="alert">{{ importError }}</p>
            <div class="ac-commons-import__actions">
              <UButton color="neutral" variant="ghost" @click="closeImport">取消</UButton>
              <UButton color="neutral" :loading="importing" :disabled="!canImport" @click="importSource">
                保存到 Commons
              </UButton>
            </div>
          </section>

          <div class="ac-commons-capabilities" aria-label="导入能力">
            <span
              v-for="capability in commons.capabilities"
              :key="capability.source_type"
              :data-available="capability.status === 'available'"
            >
              {{ sourceTypeLabel[capability.source_type] }}
              <small>
                {{ capability.status === "available"
                  ? "可用"
                  : capability.status === "blocked"
                    ? "本机阻断"
                    : "不支持" }}
              </small>
            </span>
          </div>

          <div v-if="commonsPending" class="ac-detail-panel" aria-live="polite">正在读取 Commons…</div>
          <div v-else-if="commonsError" class="ac-detail-panel ac-brief-state--error">
            <h2>Commons 暂时不可用</h2>
            <p>页面不会用浏览器缓存替代 Control Plane 的持久化事实。</p>
            <UButton color="neutral" variant="outline" @click="refreshCommons()">重新读取</UButton>
          </div>
          <p v-else-if="searchError" class="ac-commons-error" role="alert">{{ searchError }}</p>
          <section
            v-else-if="displayedSources.length"
            class="ac-card-list"
            aria-label="Commons 资料"
          >
            <NuxtLink
              v-for="source in displayedSources"
              :key="source.id"
              :to="`/library/commons/${encodeURIComponent(source.id)}`"
              class="ac-library-card ac-commons-card"
            >
              <div class="ac-card-heading">
                <div>
                  <p class="ac-card-kicker">
                    {{ sourceTypeLabel[source.source_type] }} · {{ scopeLabel[source.privacy_scope] }}
                  </p>
                  <h2>{{ source.title }}</h2>
                </div>
                <span class="ac-status-badge" :data-status="source.ingestion_status">
                  {{ statusLabel[source.ingestion_status] }}
                </span>
              </div>
              <p class="ac-card-reason">
                {{ source.error_message || source.origin || (source.author ? `作者：${source.author}` : "原文已保存到 Artifact") }}
              </p>
              <div class="ac-card-footer">
                <span>{{ dateTimeWithTime.format(new Date(source.updated_at)) }}</span>
                <span v-if="source.duplicate_of_source_id">已识别{{ source.deduplication_kind === "exact" ? "重复" : "近重复" }}</span>
                <span class="ac-card-action">
                  查看原文与来源
                  <UIcon name="i-lucide-arrow-right" />
                </span>
              </div>
            </NuxtLink>
          </section>
          <section v-else class="ac-empty-state">
            <div class="ac-empty-state__content">
              <span class="ac-empty-state__icon" aria-hidden="true">
                <UIcon name="i-lucide-library-big" />
              </span>
              <h2>{{ searchResults ? "没有匹配资料" : "Commons inbox 还是空的" }}</h2>
              <p>{{ searchResults ? "换一个更具体的关键词，或清除搜索查看全部资料。" : "导入文本、Markdown、对话或 URL，解析状态与原文会保存在这里。" }}</p>
            </div>
          </section>
        </template>

        <template v-else>
          <div v-if="!available || workUnavailable">
            <CompanyConnectionState
              :connection="snapshot.connection"
              :issue="snapshot.issue"
              :pending="pending"
              show-settings
              @retry="refresh()"
            />
          </div>

          <section
            v-else-if="deliveries.length || unavailableWork.length"
            class="ac-card-list"
            aria-label="交付成果"
          >
            <NuxtLink
              v-for="work in unavailableWork"
              :key="work.workId"
              :to="`/work/${encodeURIComponent(work.workId)}`"
              class="ac-library-card"
            >
              <div class="ac-card-heading">
                <div>
                  <p class="ac-card-kicker">成果状态待确认</p>
                  <h2>{{ work.title }}</h2>
                </div>
                <span class="ac-status-badge" data-status="unavailable">状态不可用</span>
              </div>
              <p class="ac-card-reason">{{ work.reason.text }}</p>
              <div class="ac-card-footer">
                <span>{{ work.diagnostics.length }} 项诊断</span>
                <span class="ac-card-action">
                  查看诊断
                  <UIcon name="i-lucide-arrow-right" />
                </span>
              </div>
            </NuxtLink>

            <NuxtLink
              v-for="delivery in deliveries"
              :key="delivery.id"
              :to="`/work/${encodeURIComponent(delivery.workId)}`"
              class="ac-library-card"
            >
              <div class="ac-card-heading">
                <div>
                  <p class="ac-card-kicker">版本 {{ delivery.version }}</p>
                  <h2>{{ delivery.workTitle }}</h2>
                </div>
                <time :datetime="delivery.updatedAt">{{ dateTime.format(new Date(delivery.updatedAt)) }}</time>
              </div>
              <p class="ac-card-reason">{{ delivery.reason.text }}</p>
              <div class="ac-card-footer">
                <span>{{ delivery.artifacts.length }} 项成果</span>
                <span
                  v-if="delivery.nextAction"
                  class="ac-card-action"
                  :aria-disabled="!delivery.nextAction.enabled"
                  :data-disabled="!delivery.nextAction.enabled"
                >
                  {{ appConfig.experience.actionLabels[delivery.nextAction.id] }}
                  <small v-if="!delivery.nextAction.enabled"> · 暂不可用</small>
                  <UIcon name="i-lucide-arrow-right" />
                </span>
              </div>
            </NuxtLink>
          </section>

          <section v-else class="ac-empty-state">
            <div class="ac-empty-state__content">
              <span class="ac-empty-state__icon" aria-hidden="true">
                <UIcon name="i-lucide-library" />
              </span>
              <h2>还没有归档成果</h2>
              <p>工作形成可验证交付后，会在这里保留版本、来源和下一步。</p>
            </div>
          </section>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
