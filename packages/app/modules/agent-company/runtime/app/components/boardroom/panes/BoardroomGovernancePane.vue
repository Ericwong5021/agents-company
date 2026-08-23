<script setup lang="ts">
import type {
  BoardroomComparisonInput,
  BoardroomConvergenceInput,
  BoardroomGovernanceVM,
  BoardroomInterventionInput,
  BoardroomShadowInput,
} from "../../../types/boardroom"

const props = defineProps<{
  governance: BoardroomGovernanceVM
  roomProjectID?: string
  companyGoal?: string
  projects: { id: string; title: string; status: string }[]
  agents: { id: string; name: string; role: string }[]
  messages: { id: string; author: string; body: string }[]
  boardThreadID?: string
  loading: boolean
  message: string
  section?: "shadow" | "intervention"
}>()

const emit = defineEmits<{
  intervene: [input: BoardroomInterventionInput]
  shadow: [input: BoardroomShadowInput]
  compare: [input: BoardroomComparisonInput]
  converge: [input: BoardroomConvergenceInput]
}>()

const intervention = reactive<BoardroomInterventionInput>({ kind: "takeover", projectID: props.roomProjectID, reason: "", newGoal: "" })
const shadow = reactive<BoardroomShadowInput>({
  projectID: props.roomProjectID,
  currentGoal: props.projects.find(project => project.id === props.roomProjectID)?.title || props.companyGoal || "评估当前公司目标与讨论",
  companyScopeConfirmed: false,
})
const comparison = reactive<BoardroomComparisonInput>({ shadowDecisionID: "", actualDecisionID: "", actualDecision: "", alignment: "partial", rationale: "" })
const convergence = reactive<BoardroomConvergenceInput>({ shadowDecisionID: "", channelMessageID: "", driAgentID: "", subject: "", context: "", timeoutMinutes: 30 })

watch(() => props.roomProjectID, projectID => {
  intervention.projectID = projectID
  shadow.projectID = projectID
  shadow.companyScopeConfirmed = false
  shadow.currentGoal = props.projects.find(project => project.id === projectID)?.title || props.companyGoal || "评估当前公司目标与讨论"
}, { immediate: true })

watch(() => [props.governance.shadowDecisions, props.governance.decisions, props.messages, props.agents] as const, () => {
  comparison.shadowDecisionID ||= props.governance.shadowDecisions.at(0)?.id ?? ""
  comparison.actualDecisionID ||= props.governance.decisions.at(0)?.id ?? ""
  comparison.actualDecision ||= props.governance.decisions.at(0)?.summary ?? ""
  convergence.shadowDecisionID ||= props.governance.shadowDecisions.at(0)?.id ?? ""
  convergence.channelMessageID ||= [...props.messages].reverse().find(message => message.author === "你")?.id ?? props.messages.at(-1)?.id ?? ""
  convergence.driAgentID ||= props.agents.at(0)?.id ?? ""
  convergence.subject ||= [...props.messages].reverse().find(message => message.author === "你")?.body ?? ""
  convergence.context ||= props.messages.map(message => `${message.author}: ${message.body}`).join("\n")
}, { immediate: true, deep: true })

const interventionLabel = computed(() => ({ takeover: "接管", pause: "暂停", correct: "纠正", reject: "否决", redefine_goal: "重定义目标" })[intervention.kind])
</script>

<template>
  <div class="ac-boardroom-governance-pane">
    <p v-if="governance.error" class="ac-boardroom-governance-pane__notice" role="status">{{ governance.error }}</p>
    <p v-if="message" class="ac-boardroom-governance-pane__message" role="status">{{ message }}</p>
    <p v-if="governance.authorization !== '已授权'" class="ac-boardroom-governance-pane__notice">
      当前模式或真实授权尚未满足，顾问代理保持安全关闭，界面不会提高权限。
    </p>

    <details :open="section === 'intervention'">
      <summary><span><UIcon name="i-lucide-hand" />人工控制</span><small>接管、暂停、纠正或否决</small><UIcon name="i-lucide-chevron-down" /></summary>
      <form @submit.prevent="$emit('intervene', { ...intervention })">
        <label><span>动作</span><select v-model="intervention.kind"><option value="takeover">接管</option><option value="pause">暂停</option><option value="correct">纠正</option><option value="reject">否决</option><option value="redefine_goal">重定义目标</option></select></label>
        <label><span>关联项目</span><select v-model="intervention.projectID"><option :value="undefined">仅停止当前董事会代理</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.title }}</option></select></label>
        <label><span>原因</span><textarea v-model="intervention.reason" rows="3" /></label>
        <label v-if="intervention.kind === 'redefine_goal'"><span>新目标</span><textarea v-model="intervention.newGoal" rows="3" /></label>
        <AppButton type="submit" variant="danger" :loading="loading" :disabled="!boardThreadID || !intervention.reason.trim() || intervention.kind === 'redefine_goal' && !intervention.newGoal?.trim()" block>提交“{{ interventionLabel }}”</AppButton>
        <p>操作会锁定创始人代理；选择项目后也会暂停对应的在途工作。</p>
      </form>
    </details>

    <details :open="section === 'shadow' || undefined">
      <summary><span><UIcon name="i-lucide-eye" />影子建议</span><small>生成只读建议，不创建执行</small><UIcon name="i-lucide-chevron-down" /></summary>
      <form @submit.prevent="$emit('shadow', { ...shadow })">
        <label><span>目标</span><textarea v-model="shadow.currentGoal" rows="3" /></label>
        <label><span>项目范围</span><select v-model="shadow.projectID"><option :value="undefined">公司范围</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.title }} · {{ project.status }}</option></select></label>
        <label v-if="!shadow.projectID && projects.length" class="ac-boardroom-governance-pane__check"><input v-model="shadow.companyScopeConfirmed" type="checkbox"><span>确认综合多项工作的公司范围信息</span></label>
        <AppButton type="submit" variant="primary" :loading="loading" :disabled="!shadow.currentGoal.trim() || !shadow.projectID && projects.length > 0 && !shadow.companyScopeConfirmed" block>生成影子建议</AppButton>
      </form>
    </details>

    <details v-if="governance.shadowDecisions.length && governance.decisions.length">
      <summary><span><UIcon name="i-lucide-git-compare-arrows" />建议对照</span><small>与真实决定建立审计关系</small><UIcon name="i-lucide-chevron-down" /></summary>
      <form @submit.prevent="$emit('compare', { ...comparison })">
        <label><span>影子建议</span><select v-model="comparison.shadowDecisionID"><option v-for="decision in governance.shadowDecisions" :key="decision.id" :value="decision.id">{{ decision.title }}</option></select></label>
        <label><span>真实决定</span><select v-model="comparison.actualDecisionID" @change="comparison.actualDecision = governance.decisions.find(decision => decision.id === comparison.actualDecisionID)?.summary ?? comparison.actualDecision"><option v-for="decision in governance.decisions" :key="decision.id" :value="decision.id">{{ decision.title }}</option></select></label>
        <label><span>决定正文</span><textarea v-model="comparison.actualDecision" rows="3" /></label>
        <label><span>一致性</span><select v-model="comparison.alignment"><option value="match">一致</option><option value="partial">部分一致</option><option value="mismatch">不一致</option></select></label>
        <label><span>对照依据</span><textarea v-model="comparison.rationale" rows="2" /></label>
        <AppButton type="submit" variant="secondary" :loading="loading" :disabled="!comparison.shadowDecisionID || !comparison.actualDecisionID || !comparison.actualDecision.trim() || !comparison.rationale.trim()" block>写入对照</AppButton>
      </form>
    </details>

    <details v-if="governance.advisorCanSpeak && boardThreadID">
      <summary><span><UIcon name="i-lucide-landmark" />顾问代理收敛</span><small>只写入决策意图</small><UIcon name="i-lucide-chevron-down" /></summary>
      <form @submit.prevent="$emit('converge', { ...convergence })">
        <label><span>影子建议</span><select v-model="convergence.shadowDecisionID"><option v-for="decision in governance.shadowDecisions" :key="decision.id" :value="decision.id">{{ decision.title }}</option></select></label>
        <label><span>当前请求消息</span><select v-model="convergence.channelMessageID"><option v-for="item in messages" :key="item.id" :value="item.id">{{ item.author }} · {{ item.body }}</option></select></label>
        <label><span>直接负责人</span><select v-model="convergence.driAgentID"><option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }} · {{ agent.role }}</option></select></label>
        <label><span>超时分钟</span><input v-model.number="convergence.timeoutMinutes" type="number" min="1" max="1440"></label>
        <label><span>主题</span><textarea v-model="convergence.subject" rows="2" /></label>
        <label><span>上下文</span><textarea v-model="convergence.context" rows="4" /></label>
        <AppButton type="submit" variant="primary" :loading="loading" :disabled="!convergence.channelMessageID || !convergence.shadowDecisionID || !convergence.driAgentID || !convergence.subject.trim() || !convergence.context.trim()" block>写入决策意图</AppButton>
      </form>
    </details>

    <section>
      <header><h3>影子建议记录</h3><span>{{ governance.shadowDecisions.length }}</span></header>
      <article v-for="decision in governance.shadowDecisions" :key="decision.id">
        <strong>{{ decision.title }}</strong><small>{{ decision.authority }} · {{ decision.status }} · 只读</small>
        <p v-if="decision.blockReasons.length">阻断：{{ decision.blockReasons.join("、") }}</p>
      </article>
      <p v-if="!governance.shadowDecisions.length">当前范围暂无影子建议。</p>
    </section>
  </div>
</template>

<style scoped>
.ac-boardroom-governance-pane { display: grid; gap: 1px; background: var(--ac-boardroom-ink-100); }
.ac-boardroom-governance-pane > details,
.ac-boardroom-governance-pane > section,
.ac-boardroom-governance-pane__message,
.ac-boardroom-governance-pane__notice { margin: 0; background: var(--ac-boardroom-paper); }
.ac-boardroom-governance-pane__message,
.ac-boardroom-governance-pane__notice { padding: 11px 16px; color: var(--ac-boardroom-success); font-size: 10.5px; line-height: 1.5; }
.ac-boardroom-governance-pane__notice { background: var(--ac-boardroom-danger-soft); color: var(--ac-boardroom-danger); }
.ac-boardroom-governance-pane summary { display: grid; grid-template-columns: minmax(0, 1fr) auto 16px; align-items: center; gap: 7px; padding: 14px 16px; cursor: pointer; list-style: none; }
.ac-boardroom-governance-pane summary::-webkit-details-marker { display: none; }
.ac-boardroom-governance-pane summary > span { display: flex; align-items: center; gap: 7px; color: var(--ac-boardroom-ink-700); font-size: 11px; font-weight: 740; }
.ac-boardroom-governance-pane summary > span svg { width: 15px; height: 15px; color: var(--ac-boardroom-accent-strong); }
.ac-boardroom-governance-pane summary > small { color: var(--ac-boardroom-ink-300); font-size: 9px; }
.ac-boardroom-governance-pane summary > svg { width: 14px; height: 14px; color: var(--ac-boardroom-ink-300); transition: transform var(--ac-boardroom-motion-base); }
.ac-boardroom-governance-pane details[open] summary > svg { transform: rotate(180deg); }
.ac-boardroom-governance-pane form { display: grid; gap: 10px; border-top: 1px solid var(--ac-boardroom-ink-100); padding: 14px 16px 16px; }
.ac-boardroom-governance-pane label { display: grid; gap: 5px; color: var(--ac-boardroom-ink-500); font-size: 10px; }
.ac-boardroom-governance-pane input:not([type="checkbox"]),
.ac-boardroom-governance-pane select,
.ac-boardroom-governance-pane textarea { width: 100%; border: 1px solid var(--ac-boardroom-ink-100); border-radius: var(--ac-boardroom-radius-sm); padding: 8px 9px; background: var(--ac-boardroom-cloud); color: var(--ac-boardroom-ink-700); font: 11px/1.45 var(--ac-boardroom-font-sans); outline: 0; }
.ac-boardroom-governance-pane textarea { resize: vertical; }
.ac-boardroom-governance-pane input:focus,
.ac-boardroom-governance-pane select:focus,
.ac-boardroom-governance-pane textarea:focus { border-color: var(--ac-boardroom-accent-300); }
.ac-boardroom-governance-pane__check { display: flex !important; grid-template-columns: auto 1fr; align-items: flex-start; }
.ac-boardroom-governance-pane form > p { margin: 0; color: var(--ac-boardroom-ink-500); font-size: 9.5px; line-height: 1.5; }
.ac-boardroom-governance-pane > section { padding: 16px; }
.ac-boardroom-governance-pane > section header { display: flex; justify-content: space-between; margin-bottom: 8px; }
.ac-boardroom-governance-pane h3 { margin: 0; color: var(--ac-boardroom-ink-700); font-size: 11px; }
.ac-boardroom-governance-pane > section header span { color: var(--ac-boardroom-ink-300); font-size: 10px; }
.ac-boardroom-governance-pane > section article { display: grid; gap: 2px; border-top: 1px solid var(--ac-boardroom-ink-100); padding: 9px 0; }
.ac-boardroom-governance-pane > section article strong { color: var(--ac-boardroom-ink-700); font-size: 10.5px; }
.ac-boardroom-governance-pane > section article small,
.ac-boardroom-governance-pane > section article p,
.ac-boardroom-governance-pane > section > p { margin: 0; color: var(--ac-boardroom-ink-500); font-size: 9.5px; line-height: 1.5; }
</style>
