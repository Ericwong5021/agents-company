<script setup lang="ts">
import type {
  AgentInterestProfileRecord,
  CommonsSourceRecord,
  InterpretationRecord,
  ReadingAssignmentRecord,
} from "@agents-company/sdk/v2";

type ReadingWorkspace = {
  interpretations: InterpretationRecord[];
  assignments: ReadingAssignmentRecord[];
  profiles: AgentInterestProfileRecord[];
  sources: CommonsSourceRecord[];
};

const { data: snapshot } = useCompanySnapshot();
const {
  data: reading,
  pending,
  error,
  refresh,
} = useFetch<ReadingWorkspace>("/api/agent-company/reading", {
  default: () => ({ interpretations: [], assignments: [], profiles: [], sources: [] }),
});
const projectID = ref("");
const sourceID = ref("");
const scheduling = ref(false);
const scheduleError = ref("");
const profileAgentID = ref("");
const profileTopics = ref("");
const profileLenses = ref("");
const profileExcluded = ref("");
const profileNovelty = ref(0.45);
const profileBudget = ref(3);
const profileConcurrency = ref(1);
const profileScopes = ref<Array<"company" | "project" | "private">>(["company", "project"]);
const privacyScopeOptions = ["company", "project", "private"] as const;
const savingProfile = ref(false);
const profileError = ref("");
const sourceByID = computed(() => new Map(reading.value.sources.map(source => [source.id, source])));
const filtered = computed(() => projectID.value
  ? reading.value.interpretations.filter(interpretation =>
      interpretation.project_connections.some(connection => connection.project_id === projectID.value))
  : reading.value.interpretations);
const grouped = computed(() => [...new Set(filtered.value.map(interpretation => interpretation.source_id))]
  .map(id => ({
    source: sourceByID.value.get(id),
    interpretations: filtered.value.filter(interpretation => interpretation.source_id === id),
  })));
const readySources = computed(() =>
  reading.value.sources.filter(source =>
    source.capability_status === "supported" && source.ingestion_status === "ready"));
const activeAssignments = computed(() =>
  reading.value.assignments.filter(assignment =>
    ["scheduling", "scheduled", "running"].includes(assignment.status)));
const agreementLabel: Record<InterpretationRecord["agreement"], string> = {
  aligned: "一致",
  conflicted: "冲突",
  mixed: "部分一致",
  unknown: "尚未判断",
};
const profileByAgentID = computed(() =>
  new Map(reading.value.profiles.map(profile => [profile.agent_id, profile])));
const readerAgents = computed(() =>
  snapshot.value.agents.filter(agent => agent.employment === "employee"));

watch(profileAgentID, (agentID) => {
  const profile = profileByAgentID.value.get(agentID);
  profileTopics.value = profile?.topics.join("，") ?? "";
  profileLenses.value = profile?.preferred_lenses.join("，") ?? "";
  profileExcluded.value = profile?.excluded_topics.join("，") ?? "";
  profileNovelty.value = profile?.novelty_threshold ?? 0.45;
  profileBudget.value = profile?.weekly_reading_budget ?? 3;
  profileConcurrency.value = profile?.max_concurrency ?? 1;
  profileScopes.value = profile?.privacy_scopes ?? ["company", "project"];
  profileError.value = "";
});

function listValue(value: string) {
  return [...new Set(value.split(/[，,\n]/).map(item => item.trim()).filter(Boolean))];
}

function evidenceLink(sourceID: string, evidence: InterpretationRecord["evidence_refs"][number]) {
  return `/library/commons/${encodeURIComponent(sourceID)}?chunk=${encodeURIComponent(evidence.chunk_id)}&start=${evidence.start_offset}&end=${evidence.end_offset}`;
}

async function saveProfile() {
  if (!profileAgentID.value || savingProfile.value) return;
  savingProfile.value = true;
  profileError.value = "";
  const ok = await $fetch(
    `/api/agent-company/reading/profiles/${encodeURIComponent(profileAgentID.value)}`,
    {
      method: "PUT",
      body: {
        topics: listValue(profileTopics.value),
        preferred_lenses: listValue(profileLenses.value),
        excluded_topics: listValue(profileExcluded.value),
        novelty_threshold: profileNovelty.value,
        weekly_reading_budget: profileBudget.value,
        max_concurrency: profileConcurrency.value,
        privacy_scopes: profileScopes.value,
      },
    },
  ).then(() => true, () => false);
  savingProfile.value = false;
  if (!ok) {
    profileError.value = "Reader Profile 未保存。每家公司最多配置 3 个 Reader。";
    return;
  }
  await refresh();
}

async function scheduleReading() {
  if (!sourceID.value || !projectID.value || scheduling.value) return;
  scheduling.value = true;
  scheduleError.value = "";
  const ok = await $fetch("/api/agent-company/reading/schedule", {
    method: "POST",
    body: { source_id: sourceID.value, project_id: projectID.value },
  }).then(() => true, () => false);
  scheduling.value = false;
  if (!ok) {
    scheduleError.value = "没有可用 Interest Profile、预算或项目计划，阅读任务未创建。";
    return;
  }
  await refresh();
}

async function stopReading(assignmentID: string) {
  await $fetch(`/api/agent-company/reading/${encodeURIComponent(assignmentID)}/stop`, {
    method: "POST",
  }).then(refresh, () => undefined);
}
</script>

<template>
  <UDashboardPanel id="interpretations" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page">
        <header class="ac-workspace-header">
          <div>
            <p class="ac-workspace-eyebrow">Commons reading</p>
            <h1 class="ac-workspace-title">Interpretations</h1>
            <p class="ac-workspace-lede">
              同一资料保留多个 Agent 的判断、反证、实验想法和来源跨度。
            </p>
          </div>
          <NuxtLink to="/library" class="ac-back-link">
            <UIcon name="i-lucide-arrow-left" />
            返回 Library
          </NuxtLink>
        </header>

        <section class="ac-reading-control">
          <div>
            <p class="ac-card-kicker">Bounded scheduler</p>
            <h2>安排一次受限阅读</h2>
            <p>确定性评分只选 1–3 个有预算、兴趣匹配且有权限的 Agent。</p>
          </div>
          <div class="ac-reading-control__fields">
            <label>
              资料
              <select v-model="sourceID">
                <option value="">选择已解析资料</option>
                <option v-for="source in readySources" :key="source.id" :value="source.id">
                  {{ source.title }}
                </option>
              </select>
            </label>
            <label>
              项目
              <select v-model="projectID">
                <option value="">选择关联项目</option>
                <option
                  v-for="work in snapshot.work.filter(item => item.availability === 'available')"
                  :key="work.workId"
                  :value="work.workId"
                >
                  {{ work.summary.title }}
                </option>
              </select>
            </label>
            <UButton
              color="neutral"
              :loading="scheduling"
              :disabled="!sourceID || !projectID"
              @click="scheduleReading"
            >
              交给 Orchestrator
            </UButton>
          </div>
          <p v-if="scheduleError" class="ac-commons-error" role="alert">{{ scheduleError }}</p>
        </section>

        <section class="ac-reader-profile">
          <div class="ac-reader-profile__heading">
            <div>
              <p class="ac-card-kicker">Reader configuration</p>
              <h2>Interest Profiles</h2>
              <p>为 1–3 个在职 Agent 配置阅读主题、视角、预算与资料范围。</p>
            </div>
            <span>{{ reading.profiles.length }} / 3 Reader</span>
          </div>
          <div class="ac-reader-profile__form">
            <label>
              Reader
              <select v-model="profileAgentID">
                <option value="">选择 Agent</option>
                <option v-for="agent in readerAgents" :key="agent.id" :value="agent.id">
                  {{ agent.name }}
                </option>
              </select>
            </label>
            <label>
              关注主题
              <input v-model="profileTopics" type="text" placeholder="用户研究，组织设计" />
            </label>
            <label>
              阅读视角
              <input v-model="profileLenses" type="text" placeholder="反证，产品影响" />
            </label>
            <label>
              排除主题
              <input v-model="profileExcluded" type="text" placeholder="可留空" />
            </label>
            <label>
              每周预算
              <input v-model.number="profileBudget" type="number" min="0" max="168" />
            </label>
            <label>
              并发
              <select v-model.number="profileConcurrency">
                <option :value="1">1</option>
                <option :value="2">2</option>
                <option :value="3">3</option>
              </select>
            </label>
            <label>
              新颖度阈值
              <input v-model.number="profileNovelty" type="number" min="0" max="1" step="0.05" />
            </label>
            <fieldset>
              <legend>资料范围</legend>
              <label v-for="scope in privacyScopeOptions" :key="scope">
                <input v-model="profileScopes" type="checkbox" :value="scope" />
                {{ scope }}
              </label>
            </fieldset>
            <UButton
              color="neutral"
              :loading="savingProfile"
              :disabled="!profileAgentID || !profileScopes.length"
              @click="saveProfile"
            >
              保存 Reader
            </UButton>
          </div>
          <p v-if="profileError" class="ac-commons-error" role="alert">{{ profileError }}</p>
        </section>

        <section v-if="activeAssignments.length" class="ac-reading-queue">
          <article v-for="assignment in activeAssignments" :key="assignment.id">
            <div>
              <strong>{{ sourceByID.get(assignment.source_id)?.title || assignment.source_id }}</strong>
              <span>{{ assignment.status }} · score {{ assignment.total_score.toFixed(2) }}</span>
            </div>
            <button type="button" @click="stopReading(assignment.id)">停止</button>
          </article>
        </section>

        <div class="ac-work-toolbar">
          <div class="ac-work-tabs">
            <NuxtLink to="/library" class="ac-work-tab">Commons inbox</NuxtLink>
            <span class="ac-work-tab" data-active="true">
              Interpretations
              <span class="ac-work-tab__count">{{ filtered.length }}</span>
            </span>
            <NuxtLink to="/library/beliefs" class="ac-work-tab">Belief Lab</NuxtLink>
            <NuxtLink to="/library/patches" class="ac-work-tab">Patches</NuxtLink>
          </div>
          <label class="ac-reading-project-filter">
            <span class="sr-only">按项目过滤</span>
            <select v-model="projectID">
              <option value="">全部项目关联</option>
              <option
                v-for="work in snapshot.work.filter(item => item.availability === 'available')"
                :key="work.workId"
                :value="work.workId"
              >
                {{ work.summary.title }}
              </option>
            </select>
          </label>
        </div>

        <section v-if="pending" class="ac-detail-panel">正在读取 Interpretation…</section>
        <section v-else-if="error" class="ac-detail-panel ac-brief-state--error">
          <h2>Interpretations 暂时不可用</h2>
          <UButton color="neutral" variant="outline" @click="refresh()">重新读取</UButton>
        </section>
        <section v-else-if="grouped.length" class="ac-interpretation-stream">
          <article v-for="group in grouped" :key="group.source?.id || group.interpretations[0]?.source_id">
            <header>
              <p class="ac-card-kicker">Source</p>
              <h2>{{ group.source?.title || group.interpretations[0]?.source_id }}</h2>
              <span>{{ group.interpretations.length }} 个观点</span>
            </header>
            <div class="ac-interpretation-columns">
              <section v-for="interpretation in group.interpretations" :key="interpretation.id">
                <div class="ac-interpretation-agent">
                  <strong>{{ interpretation.reader_agent_name || interpretation.reader_role }}</strong>
                  <span :data-agreement="interpretation.agreement">
                    {{ agreementLabel[interpretation.agreement] }}
                  </span>
                </div>
                <h3>{{ interpretation.core_thesis }}</h3>
                <p>{{ interpretation.company_relevance }}</p>
                <div class="ac-interpretation-claims">
                  <h4>关键判断与来源</h4>
                  <ul>
                    <li v-for="claim in interpretation.important_claims" :key="claim">
                      <span>{{ claim }}</span>
                      <NuxtLink
                        v-for="evidence in interpretation.evidence_refs.filter(item => item.claim === claim)"
                        :key="`${evidence.chunk_id}:${evidence.start_offset}:${evidence.end_offset}`"
                        :to="evidenceLink(interpretation.source_id, evidence)"
                      >
                        查看原文 {{ evidence.start_offset }}–{{ evidence.end_offset }}
                      </NuxtLink>
                    </li>
                  </ul>
                </div>
                <dl>
                  <div>
                    <dt>反方论据</dt>
                    <dd>{{ interpretation.counter_arguments.join("；") }}</dd>
                  </div>
                  <div>
                    <dt>低成本实验</dt>
                    <dd>{{ interpretation.experiment_ideas.join("；") }}</dd>
                  </div>
                  <div>
                    <dt>项目关联</dt>
                    <dd>{{ interpretation.project_connections.map(item => item.impact).join("；") || "无" }}</dd>
                  </div>
                </dl>
                <footer>
                  <span>{{ interpretation.evidence_refs.length }} 条 source span</span>
                  <span>confidence {{ interpretation.confidence.toFixed(2) }}</span>
                  <span>{{ interpretation.disposition }}</span>
                </footer>
              </section>
            </div>
          </article>
        </section>
        <section v-else class="ac-empty-state">
          <UIcon name="i-lucide-book-open-text" />
          <h2>还没有 Interpretation</h2>
          <p>先为 Agent 配置 Interest Profile，再选择已解析资料与当前项目。</p>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
