<script setup lang="ts">
import {
  organizationActivityLabel,
  type OrganizationGraphNode,
} from "../../modules/agent-company/runtime/shared/organization-graph"

defineProps<{
  node?: OrganizationGraphNode
  projectId: string
}>()
</script>

<template>
  <aside class="ac-organization-facts" aria-label="组织事实">
    <template v-if="node?.kind === 'company'">
      <header><p class="ac-card-kicker">公司事实</p><h2>{{ node.title }}</h2></header>
      <dl>
        <div><dt>正式员工</dt><dd>{{ node.employeeCount }} 名</dd></div>
        <div><dt>临时成员</dt><dd>{{ node.temporaryCount }} 名</dd></div>
        <div><dt>组织单元</dt><dd>{{ node.departmentCount }} 个</dd></div>
      </dl>
    </template>
    <template v-else-if="node?.kind === 'department'">
      <header><p class="ac-card-kicker">组织单元</p><h2>{{ node.title }}</h2></header>
      <dl>
        <div><dt>成员规模</dt><dd>{{ node.memberCount }} 名</dd></div>
        <div><dt>执行中</dt><dd>{{ node.activeCount }} 名</dd></div>
      </dl>
    </template>
    <template v-else-if="node?.kind === 'agent'">
      <header><p class="ac-card-kicker">成员事实</p><h2>{{ node.name }}</h2></header>
      <dl>
        <div><dt>身份</dt><dd>{{ node.employment === "employee" ? "正式员工" : "项目临时成员" }}</dd></div>
        <div><dt>角色</dt><dd>{{ node.role || "未记录角色" }}</dd></div>
        <div><dt>组织单元</dt><dd>{{ node.department || "未归属部门" }}</dd></div>
        <div><dt>当前活动</dt><dd>{{ organizationActivityLabel(node.activity) }}</dd></div>
        <div><dt>工作负载</dt><dd>{{ node.workload.active }} 项进行中 · {{ node.workload.blocked }} 项受阻</dd></div>
      </dl>
      <section v-if="node.responsibilities.length">
        <h3>公司责任</h3>
        <ul><li v-for="responsibility in node.responsibilities" :key="responsibility">{{ responsibility }}</li></ul>
      </section>
      <NuxtLink :to="`/team/${encodeURIComponent(node.agentID)}?project=${encodeURIComponent(projectId)}`">打开成员档案 <UIcon name="i-lucide-arrow-up-right" /></NuxtLink>
    </template>
    <template v-else-if="node?.kind === 'responsibility'">
      <header><p class="ac-card-kicker">项目责任</p><h2>{{ node.role }}</h2></header>
      <p>{{ node.responsibility }}</p>
      <dl>
        <div><dt>负责人</dt><dd>{{ node.agentName }}</dd></div>
        <div><dt>状态</dt><dd>{{ node.status === "released" ? "执行分配已结束" : "当前在岗" }}</dd></div>
        <div><dt>能力需求</dt><dd>{{ node.needRole }}</dd></div>
        <div><dt>权限模式</dt><dd>{{ node.permissionMode }}</dd></div>
      </dl>
      <section><h3>加入原因</h3><p>{{ node.selectionReason }}</p></section>
      <NuxtLink :to="`/work/${encodeURIComponent(node.projectID)}`">打开关联工作 <UIcon name="i-lucide-arrow-up-right" /></NuxtLink>
    </template>
    <p v-else>选择画布中的公司、组织单元、成员或责任节点查看事实。</p>
  </aside>
</template>

<style scoped>
.ac-organization-facts { display: grid; align-content: start; gap: 24px; min-width: 0; border-left: 1px solid var(--ac-line); padding: 26px 22px 48px; }
.ac-organization-facts h2 { margin-top: 6px; color: var(--ac-ink); font-size: 21px; font-weight: 690; line-height: 1.35; letter-spacing: -.02em; overflow-wrap: anywhere; }
.ac-organization-facts > p, .ac-organization-facts section p { color: var(--ac-ink-muted); font-size: var(--ac-text-caption); line-height: 1.65; }
.ac-organization-facts dl { display: grid; border-top: 1px solid var(--ac-line); }
.ac-organization-facts dl div { display: grid; gap: 8px; border-bottom: 1px solid var(--ac-line); padding: 15px 0; }
.ac-organization-facts dt, .ac-organization-facts h3 { color: var(--ac-ink-dimmed); font-size: var(--ac-text-min); font-weight: 650; letter-spacing: .04em; }
.ac-organization-facts dd { color: var(--ac-ink); font-size: var(--ac-text-caption); line-height: 1.55; }
.ac-organization-facts section { display: grid; gap: 10px; }
.ac-organization-facts ul { display: grid; gap: 8px; padding-left: 18px; list-style: disc; }
.ac-organization-facts li { color: var(--ac-ink-muted); font-size: var(--ac-text-caption); line-height: 1.55; }
.ac-organization-facts > a { display: inline-flex; width: fit-content; min-height: 40px; align-items: center; gap: 7px; border: 1px solid var(--ac-line); border-radius: var(--ac-radius-control); padding: 8px 12px; color: var(--ac-ink); font-size: var(--ac-text-caption); font-weight: 620; }
.ac-organization-facts > a:hover { border-color: var(--ac-line-strong); background: var(--ac-surface-raised); }
.ac-organization-facts > a svg { width: 14px; height: 14px; }
@media (max-width: 960px) { .ac-organization-facts { border-top: 1px solid var(--ac-line); border-left: 0; padding: 24px 18px 44px; } }
</style>
