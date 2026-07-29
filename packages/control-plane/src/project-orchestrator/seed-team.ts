import z from "zod"
import { Effect } from "effect"
import { CompanyID } from "@/company/schema"
import type { Interface as CompanyProjectService } from "@/company-project/company-project"
import type { Project, WorkItem } from "@/company-project/schema"
import type { Interface as CompanyRecruitmentService } from "@/company-recruitment/company-recruitment"
import { stableLogicalKey } from "@/company-recruitment/identity"
import { CapabilityCatalog } from "@/capability/catalog"
import type { SeedPolicyVerdict } from "./schema"
import { WayfinderReceipt } from "./schema"

const permissionRank = {
  read_only: 0,
  workspace_write: 1,
  full_access: 2,
}

const capabilities = {
  coding: ["software-implementation@1"],
  decision: ["board-strategy@1"],
  research: ["research-analysis@1"],
  writing: ["document-authoring@1"],
  design: ["design-production@1"],
  analysis: ["research-analysis@1"],
}

export const assignmentConstraints = (references: string[]) => {
  const packs = references.map((reference) => CapabilityCatalog.resolve(reference))
  const permissionMode =
    packs
      .map((pack) => pack.permissionMode)
      .toSorted((left, right) => permissionRank[right] - permissionRank[left])[0] ?? "read_only"
  return {
    required_runtime_capabilities: [...new Set(packs.flatMap((pack) => pack.requiredRuntimeCapabilities))],
    required_tools: [...new Set(packs.flatMap((pack) => pack.tools))],
    allowed_permission_modes: [permissionMode],
  }
}

export const assignSeedWorkItem = Effect.fn("ProjectOrchestrator.assignSeedWorkItem")(function* (input: {
  project: Project
  item: WorkItem
  recruitment: CompanyRecruitmentService
  projects: CompanyProjectService
  exclude_agent_ids?: string[]
}) {
  const assignments = yield* input.recruitment.listAssignments({
    project_id: input.project.id,
    work_item_id: input.item.id,
  })
  const current = assignments.find((assignment) => assignment.status === "assigned" || assignment.status === "active")
  if (current) {
    if (input.exclude_agent_ids?.includes(current.agent_id))
      throw new Error(`Seed work item ${input.item.id} violates its Agent independence boundary`)
    if (input.item.owner_agent_id !== current.agent_id)
      throw new Error(`Seed work item ${input.item.id} owner differs from its current Assignment`)
    return input.item
  }
  if (input.item.owner_agent_id)
    throw new Error(`Seed work item ${input.item.id} has an owner without a current Assignment`)
  const need = yield* input.recruitment.createNeed({
    ...(input.project.company_id ? { company_id: CompanyID.parse(input.project.company_id) } : {}),
    project_id: input.project.id,
    work_item_id: input.item.id,
    need_key: stableLogicalKey(`seed-${input.item.source_task_key ?? input.item.id}`),
    role: input.item.role,
    work_type: input.item.work_type,
    capability_packs: input.item.capability_packs,
    risk_level: input.item.risk_level,
    demand_horizon: "project",
    ...assignmentConstraints(input.item.capability_packs),
    workspace_scopes: input.item.resource_scope.length ? input.item.resource_scope : [input.project.output_dir],
    independent_from_agent_ids: input.exclude_agent_ids ?? [],
  })
  yield* input.recruitment.selectAndAssign({
    capability_need_id: need.id,
    exclude_agent_ids: input.exclude_agent_ids ?? [],
  })
  const assigned = (yield* input.projects.listWorkItems(input.project.id)).find((item) => item.id === input.item.id)
  if (!assigned?.owner_agent_id)
    throw new Error(`Assignment did not update Seed work item ${input.item.id} owner`)
  return assigned
})

export const authorizeDiscoveryBuilder = Effect.fn(
  "ProjectOrchestrator.authorizeDiscoveryBuilder",
)(function* (input: {
  project: Project
  recruitment: CompanyRecruitmentService
  projects: CompanyProjectService
  work_item_id: string
}) {
  if (input.project.execution_strategy !== "seed_and_grow" || input.project.seed_mode !== "discovery_first")
    return
  const items = yield* input.projects.listWorkItems(input.project.id)
  const builder = items.find((item) => item.id === input.work_item_id && item.purpose === "first_slice")
  if (!builder) throw new Error(`Discovery project ${input.project.id} has no First Slice Builder`)
  const wayfinder = items.find((item) => item.purpose === "discovery")
  return yield* assignSeedWorkItem({
    project: input.project,
    item: builder,
    projects: input.projects,
    recruitment: input.recruitment,
    exclude_agent_ids: wayfinder?.owner_agent_id ? [wayfinder.owner_agent_id] : [],
  })
})

export const startSeedProject = Effect.fn("ProjectOrchestrator.startSeedProject")(function* (input: {
  project: Project
  verdict: SeedPolicyVerdict
  projects: CompanyProjectService
  recruitment: CompanyRecruitmentService
  authorize_builder_work_item_id?: string
}) {
  if (input.project.execution_strategy !== "seed_and_grow" || input.project.seed_mode !== input.verdict.mode)
    throw new Error(`Company project ${input.project.id} is not pinned to ${input.verdict.mode}`)
  const charter =
    (yield* input.projects.getCharter(input.project.id)) ??
    (yield* input.projects.createCharter({
      project_id: input.project.id,
      title: input.project.title,
      value: input.project.goal,
      deliverables: [input.verdict.first_slice.title],
      scope: input.verdict.first_slice.resource_scope.length
        ? input.verdict.first_slice.resource_scope
        : [input.project.output_dir],
      non_goals: ["不执行 First Slice 以外的完整任务树"],
      success_criteria: input.verdict.first_slice.acceptance_criteria,
      constraints: ["不越过当前权限与外部副作用边界"],
      resources: input.verdict.first_slice.resource_scope.map((scope) => ({
        kind: "other" as const,
        scope,
        disposition: "retain",
      })),
      risks: input.verdict.reason_codes.map((code) => ({
        description: code,
        mitigation: "以 Wayfinder Receipt 与运行时 ApprovalGate 收敛",
      })),
      acceptance_criteria: input.verdict.first_slice.acceptance_criteria,
    }))
  const plan =
    (yield* input.projects.listPlans(input.project.id))[0] ??
    (yield* input.projects.createPlan({
      project_id: input.project.id,
      phase: "execution",
      summary: `Seed-and-Grow ${input.verdict.mode} 初始切片`,
      assumptions: [],
      acceptance_criteria: input.verdict.first_slice.acceptance_criteria,
    }))
  const items = yield* input.projects.listWorkItems(input.project.id)
  const wayfinder =
    input.verdict.mode === "direct_single"
      ? undefined
      : (items.find((item) => item.source_task_key === "seed-wayfinder") ??
        (yield* input.projects.createWorkItem({
          project_id: input.project.id,
          plan_id: plan.id,
          source_task_key: "seed-wayfinder",
          title: "确认项目现实边界",
          description: "只读确认代码库、运行时、配置、未知项与第一可验证切片，不修改工作区或任务图。",
          kind: "worker",
          work_type: "research",
          role: "project-wayfinder",
          capability_packs: ["project-wayfinding@1"],
          decision_scope: ["现实事实", "未知项", "First Slice 建议"],
          resource_scope: input.verdict.first_slice.resource_scope.length
            ? input.verdict.first_slice.resource_scope
            : [input.project.output_dir],
          inputs: [input.project.goal],
          expected_outputs: ["WayfinderReceipt"],
          validators: ["只读", "事实有依据", "不创建完整任务树"],
          disposition: "retain",
          model_group: "standard",
          risk_level: input.verdict.mode === "discovery_first" ? "high" : "medium",
          review_status: "not_required",
          purpose: "discovery",
          origin_kind: "seed",
          validation_mode: "machine",
          acceptance_criteria: ["返回严格 WayfinderReceipt", "无工作区写入", "不执行外部副作用"],
          max_attempts: 2,
        })))
  const builder =
    items.find((item) => item.source_task_key === `seed-first-slice-${input.verdict.first_slice.id}`) ??
    (yield* input.projects.createWorkItem({
      project_id: input.project.id,
      plan_id: plan.id,
      source_task_key: `seed-first-slice-${input.verdict.first_slice.id}`,
      title: input.verdict.first_slice.title,
      description: input.verdict.first_slice.description,
      kind: "worker",
      work_type: input.verdict.first_slice.work_type,
      role: input.verdict.first_slice.role,
      capability_packs: input.verdict.first_slice.capability_packs.length
        ? input.verdict.first_slice.capability_packs
        : capabilities[input.verdict.first_slice.work_type],
      decision_scope: input.verdict.first_slice.decision_scope,
      resource_scope: input.verdict.first_slice.resource_scope,
      inputs: [input.project.goal, `Reality anchor: ${input.verdict.first_slice.reality_anchor}`],
      expected_outputs: [input.verdict.first_slice.title],
      validators: input.verdict.first_slice.acceptance_criteria,
      disposition: "retain",
      model_group: input.verdict.mode === "discovery_first" ? "ultra" : "standard",
      risk_level: input.verdict.mode === "discovery_first" ? "high" : "low",
      review_status: "not_required",
      purpose: "first_slice",
      origin_kind: "seed",
      validation_mode: "machine",
      acceptance_criteria: input.verdict.first_slice.acceptance_criteria,
      max_attempts: 3,
    }))
  const staffedWayfinder = wayfinder
    ? yield* assignSeedWorkItem({
        project: input.project,
        item: wayfinder,
        projects: input.projects,
        recruitment: input.recruitment,
      })
    : undefined
  if (input.authorize_builder_work_item_id && input.authorize_builder_work_item_id !== builder.id)
    throw new Error(`Risk approval does not belong to First Slice Builder ${builder.id}`)
  const staffedBuilder =
    input.verdict.mode !== "discovery_first" || input.authorize_builder_work_item_id
      ? yield* assignSeedWorkItem({
          project: input.project,
          item: builder,
          projects: input.projects,
          recruitment: input.recruitment,
          exclude_agent_ids: staffedWayfinder?.owner_agent_id ? [staffedWayfinder.owner_agent_id] : [],
        })
      : builder
  if (
    staffedWayfinder?.owner_agent_id &&
    staffedBuilder.owner_agent_id &&
    staffedWayfinder.owner_agent_id === staffedBuilder.owner_agent_id
  )
    throw new Error("Wayfinder and First Slice Builder must be different Agents")
  if ((yield* input.projects.listWorkItems(input.project.id)).some((item) => item.kind === "reviewer"))
    throw new Error("Seed startup cannot pre-create Reviewers")
  return { charter, plan, wayfinder: staffedWayfinder, builder: staffedBuilder, verdict: input.verdict }
})

const json = (value: unknown) => JSON.stringify(value)

export function wayfinderWorkflow(input: {
  project: Project
  item: WorkItem
  verdict: SeedPolicyVerdict
  model: string
}) {
  return [
    `export const meta = ${json({
      name: "company-project-wayfinder",
      description: "AgentCompany read-only project discovery",
    })}`,
    `phase("只读确认项目现实边界")`,
    `const result = await agent(${json(
      [
        `项目目标：${input.project.goal}`,
        `第一切片候选：${JSON.stringify(input.verdict.first_slice)}`,
        "你是 Wayfinder，只读检查现实环境、关键未知项和第一切片边界。",
        "不得修改工作区、Git、外部系统或任务图，不得创建 Agent，不得声称项目完成。",
        "返回严格 WayfinderReceipt；建议只作为 Receipt 事实，不直接扩展任务图。",
      ].join("\n"),
    )}, ${json({
      companyAgentID: input.item.owner_agent_id,
      role: input.item.role,
      capabilityPacks: ["project-wayfinding@1"],
      requiredRuntimeCapabilities: ["toolCalls", "structuredOutput", "workspaceRead"],
      permissionMode: "read_only",
      model: input.model,
      schema: z.toJSONSchema(WayfinderReceipt, { target: "draft-7" }),
      label: input.item.title,
      phase: "Discover",
      timeoutMs: 30 * 60_000,
    })})`,
    `if (!result) throw new Error("wayfinder failed")`,
    `return result`,
  ].join("\n")
}
