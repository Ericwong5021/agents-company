import path from "node:path"
import z from "zod"
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect"
import { AgentRun } from "@/agent-run/agent-run"
import { CapabilityCatalog } from "@/capability/catalog"
import { CompanyAgent } from "@/company-agent"
import { CompanyRecruitment, stableLogicalKey } from "@/company-recruitment"
import * as CompanyRollout from "@/company-rollout/company-rollout"
import { CompanyID, type ApprovalPreset } from "@/company/schema"
import { Conversation } from "@/conversation"
import { orchestrationPlan } from "./orchestration"
import { ConversationThreadID } from "@/conversation/schema"
import { KnowledgeReadingReceipt } from "@/company-reading/schema"
import { Delegation } from "@/delegation/delegation"
import { SubTask } from "@/delegation/schema"
import { GoalBriefStore } from "@/goal-brief"
import { Config } from "@/config"
import { Provider } from "@/provider"
import { isContextOverflowMessage } from "@/provider/error"
import { ModelID, ProviderID } from "@/provider/schema"
import * as Reputation from "@/reputation/reputation"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import * as WorkType from "@/work-type/work-type"
import type { VerifyResult, WorkTypeID } from "@/work-type/schema"
import { WorkflowRuntime } from "@/workflow/runtime"
import { verificationCommands } from "@/runtime/pi/tools"
import {
  SeedPolicyFacts,
  type ProjectExecutionStrategy as ProjectExecutionStrategyValue,
  type SeedPolicyFacts as SeedPolicyFactsValue,
} from "@agents-company/shared/project-orchestration"
import { SeedPolicyVerdict, WayfinderReceipt } from "@/project-orchestrator/schema"
import { evaluateSeedPolicy } from "@/project-orchestrator/seed-policy"
import { startSeedProject, wayfinderWorkflow } from "@/project-orchestrator/seed-team"
import { ReceiptProcessor } from "@/project-orchestrator/receipt-processor"
import { withProjectDispatchLock } from "@/project-orchestrator/dispatch-lock"
import { CompanyProject } from "./company-project"
import * as CompanyAttention from "./attention"
import { CompanyValidationGate } from "./validation-gate"
import {
  acceptanceCriterionVerification,
  Service as CompanyAcceptanceFactService,
  defaultLayer as acceptanceFactLayer,
} from "./acceptance-fact"
import {
  assertTaskPromptBudget,
  contextOverflowDiagnostic,
  defaultTaskContextBudget,
  taskContextBudget,
  taskEvidenceSnapshot,
  type TaskContextBudget,
} from "./execution-context"
import {
  BoardProjectCharter,
  BoardProjectDecisionConflict,
  type ApprovalGate,
  type AcceptanceCriterion,
  type Artifact,
  type DeliveryPolicy,
  type Plan,
  type Project,
  type ProjectCharter,
  type WorkItem,
  type WorktreeRun,
} from "./schema"

const workTypes = ["coding", "decision", "research", "writing", "design", "analysis", "knowledge_reading"] as const
const modelGroups = ["standard", "lite"] as const
const mechanicalReviewerTools = new Set([
  "grep",
  "rg",
  ...[...verificationCommands].filter((command) => command !== "file"),
])
const reviewerToolEvent = z
  .object({
    piEvent: z.literal("tool"),
    toolCallID: z.string(),
    toolName: z.string(),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .passthrough()

function policyForApprovalPreset(preset?: ApprovalPreset): DeliveryPolicy | undefined {
  if (!preset) return
  return {
    source_approval_preset: preset,
    allow_workspace_write: preset !== "strict",
    require_high_risk_approval: true,
    require_human_merge: preset !== "autonomous",
    require_clean_worktree: true,
    require_main_branch_verification: true,
  }
}

const artifactPromptReference = (project: Project, artifact?: Artifact) =>
  artifact
    ? {
        artifact_id: artifact.id,
        attempt_id: artifact.attempt_id,
        version: artifact.version,
        kind: artifact.kind,
        title: artifact.title,
        path: artifact.path ? path.relative(project.output_dir, artifact.path) : undefined,
        content_sha256: artifact.content_sha256,
        materialized_sha256: artifact.materialized_sha256,
        integrity_sha256: artifact.integrity_sha256,
      }
    : undefined
function defaultSeedPolicy(input: { goal: string; charter?: BoardProjectCharter }) {
  const resources = input.charter?.resources ?? []
  const text = [
    input.goal,
    ...(input.charter?.deliverables ?? []),
    ...(input.charter?.scope ?? []),
    ...resources.flatMap((resource) => [resource.scope, resource.disposition]),
  ].join("\n")
  const external_side_effect =
    /(?:deploy|publish|release|send|upload|production|external write|部署|发布|上线|发送|上传|外部写入)/i.test(text)
  const destructive = /(?:delete|remove|overwrite|truncate|drop|删除|移除|覆盖|清空)/i.test(text)
  const acceptance_criteria = input.charter?.acceptance_criteria ?? ["第一块工作有可复核的现实证据与明确限制"]
  return SeedPolicyFacts.parse({
    risk_level: external_side_effect || destructive ? "high" : "medium",
    scope_defined: Boolean(input.charter),
    reversible: !destructive,
    stable_sop: false,
    unfamiliar_workspace:
      !input.charter || resources.some((resource) => ["repository", "application"].includes(resource.kind)),
    cross_module: resources.length > 1,
    external_side_effect,
    blocking_unknowns: [],
    slice_candidates: [
      {
        id: "initial-reality-slice",
        title: input.charter?.deliverables[0] ?? `验证第一块：${input.goal.slice(0, 120)}`,
        description:
          input.charter?.acceptance_criteria.join("\n") ?? "先接触真实环境，形成一份可复核发现，再决定后续任务图。",
        work_type: /(?:code|implement|software|repository|代码|实现|开发)/i.test(text)
          ? "coding"
          : /(?:write|document|report|文档|撰写|报告)/i.test(text)
            ? "writing"
            : /(?:design|设计)/i.test(text)
              ? "design"
              : /(?:research|调查|研究)/i.test(text)
                ? "research"
                : "analysis",
        role: "first-slice-builder",
        capability_packs: [],
        decision_scope: input.charter?.scope ?? ["第一块工作边界"],
        resource_scope: resources.map((resource) => resource.scope),
        acceptance_criteria,
        reality_contact: 3,
        information_gain: 3,
        user_value: 2,
        reversible: !destructive,
        dependency_count: 0,
        reality_anchor: resources[0]?.scope ?? input.goal,
        within_authorized_scope: true,
        external_side_effect,
      },
    ],
  })
}

const charterResult = z.object({
  summary: z.string(),
  scope: z.array(z.string()).min(1),
  success_criteria: z.array(z.string()).min(1),
  constraints: z.array(z.string()),
  acceptance_criteria: z.array(z.string()).min(1),
  assumptions: z.array(z.string()),
})

const optionalString = <T extends z.ZodType>(value: T) =>
  z.preprocess((input) => (input === "" ? undefined : input), value.optional())

const projectionTask = SubTask.extend({
  key: optionalString(z.string().min(1)),
  parentKey: optionalString(z.string().min(1)),
  suggestedAgent: optionalString(z.string()),
  workType: optionalString(z.enum(workTypes)),
  role: optionalString(z.string().min(1)),
  modelGroup: optionalString(z.enum(modelGroups)),
  riskLevel: optionalString(z.enum(["low", "medium", "high"])),
})

const plannerProjection = z.object({
  charter: BoardProjectCharter,
  tasks: z.array(projectionTask).min(1).max(6),
})

const submissions = {
  coding: z.object({
    testsPassed: z.boolean(),
    lintClean: z.boolean(),
    buildSucceeds: z.boolean(),
    testOutput: z.string().optional(),
    lintOutput: z.string().optional(),
    buildOutput: z.string().optional(),
    verificationCommands: z.array(z.string()).min(1),
  }),
  decision: z.object({
    question: z.string(),
    approaches: z
      .array(
        z.object({
          id: z.string(),
          title: z.string(),
          description: z.string(),
          pros: z.array(z.string()),
          cons: z.array(z.string()),
          score: z.number().optional(),
          rationale: z.string().optional(),
        }),
      )
      .min(2),
    recommendedId: z.string(),
    reasoning: z.string(),
  }),
  research: z.object({
    question: z.string(),
    summary: z.string(),
    findings: z.array(z.string()).min(1),
    sources: z.array(z.object({ url: z.string().optional(), title: z.string(), relevantExcerpt: z.string() })).min(1),
    crossValidated: z.boolean(),
  }),
  writing: z.object({
    content: z.string(),
    sections: z.array(z.string()).optional(),
    wordCount: z.number().optional(),
  }),
  design: z.object({
    artifacts: z.array(z.object({ type: z.string(), description: z.string() })).min(1),
    constraints: z.array(z.string()).min(1),
    notes: z.string().optional(),
  }),
  analysis: z.object({
    question: z.string(),
    dataSources: z.array(z.string()).min(1),
    methodology: z.string(),
    findings: z.array(z.string()).min(1),
    conclusions: z.array(z.string()).min(1),
    limitations: z.array(z.string()).optional(),
  }),
  knowledge_reading: KnowledgeReadingReceipt,
} satisfies Record<(typeof workTypes)[number], z.ZodType>

const reviewResult = z.object({
  accepted: z.boolean(),
  summary: z.string(),
  findings: z.array(z.string()),
  evidence_checked: z.array(z.string()),
  criterion_results: z
    .array(
      z
        .object({
          criterion_id: z.string().optional(),
          criterion_statement: z.string().optional(),
          verdict: z.enum(["passed", "failed"]),
          summary: z.string(),
          evidence_checked: z.array(z.string()).min(1),
        })
        .refine((result) => Boolean(result.criterion_id || result.criterion_statement)),
    )
    .optional(),
})

const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: "draft-7" })
const json = (value: unknown) => JSON.stringify(value)
const workflow = (name: string, body: string) =>
  [`export const meta = ${json({ name, description: `AgentCompany adaptive project node: ${name}` })}`, body].join("\n")

const stableBoardCloseoutRequestID = (projectID: string, workItemID: string, artifactID: string) => {
  const hash = new Bun.CryptoHasher("sha256")
    .update(["board-closeout-v1", projectID, workItemID, artifactID].join("\0"))
    .digest("hex")
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${((Number.parseInt(hash[16]!, 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-")
}

const projectionFactsMatch = (
  item: WorkItem,
  input: {
    parent_id?: string
    reviews_work_item_id?: string
    title: string
    description: string
    kind: "worker" | "reviewer"
    work_type: (typeof workTypes)[number]
    role: string
    capability_packs: string[]
    decision_scope: string[]
    resource_scope: string[]
    inputs: string[]
    expected_outputs: string[]
    validators: string[]
    disposition: string
    model_group: "ultra" | "standard" | "lite"
    risk_level: "low" | "medium" | "high"
    review_status: "pending" | "not_required"
    purpose: "delivery" | "verification"
    validation_mode: "self_check" | "machine" | "independent_review" | "review_and_user_gate"
    validation_contract_version: 1 | 2
    owner_agent_id?: string
    acceptance_criteria: string[]
    max_attempts: number
    depends_on: string[]
  },
) =>
  JSON.stringify({
    parent_id: item.parent_id,
    reviews_work_item_id: item.reviews_work_item_id,
    title: item.title,
    description: item.description,
    kind: item.kind,
    work_type: item.work_type,
    role: item.role,
    capability_packs: item.capability_packs,
    decision_scope: item.decision_scope,
    resource_scope: item.resource_scope,
    inputs: item.inputs,
    expected_outputs: item.expected_outputs,
    validators: item.validators,
    disposition: item.disposition,
    model_group: item.model_group,
    risk_level: item.risk_level,
    review_status: item.review_status,
    purpose: item.purpose,
    validation_mode: item.validation_mode,
    validation_contract_version: item.validation_contract_version,
    owner_agent_id: item.owner_agent_id,
    acceptance_criteria: item.acceptance_criteria,
    max_attempts: item.max_attempts,
    depends_on: [...new Set(item.depends_on)].sort(),
  }) ===
  JSON.stringify({
    parent_id: input.parent_id,
    reviews_work_item_id: input.reviews_work_item_id,
    title: input.title,
    description: input.description,
    kind: input.kind,
    work_type: input.work_type,
    role: input.role,
    capability_packs: input.capability_packs,
    decision_scope: input.decision_scope,
    resource_scope: input.resource_scope,
    inputs: input.inputs,
    expected_outputs: input.expected_outputs,
    validators: input.validators,
    disposition: input.disposition,
    model_group: input.model_group,
    risk_level: input.risk_level,
    review_status: input.review_status,
    purpose: input.purpose,
    validation_mode: input.validation_mode,
    validation_contract_version: input.validation_contract_version,
    owner_agent_id: input.owner_agent_id,
    acceptance_criteria: input.acceptance_criteria,
    max_attempts: input.max_attempts,
    depends_on: [...new Set(input.depends_on)].sort(),
  })

const reviewedWorkItemID = (item: Pick<WorkItem, "parent_id" | "reviews_work_item_id">) =>
  item.reviews_work_item_id ?? item.parent_id

const inferWorkType = (task: SubTask): (typeof workTypes)[number] => {
  if (task.workType) return task.workType
  const text = `${task.summary} ${task.acceptanceCriteria}`.toLowerCase()
  if (/code|implement|software|repository|测试|代码|实现|开发/.test(text)) return "coding"
  if (/research|source|market|调查|研究|来源/.test(text)) return "research"
  if (/write|document|report|文档|撰写|报告/.test(text)) return "writing"
  if (/design|architecture|ux|设计|架构/.test(text)) return "design"
  if (/decide|choose|strategy|决策|选择|策略/.test(text)) return "decision"
  return "analysis"
}

const localExecutionBoundary =
  "任务必须能由当前本地只读 Agent 在本轮完成。不得把真人访谈、向外发送问卷、联系或招募、报名收费、发布、实地踩点、现场核验、线下试运行，或尚未发生的真实反馈与经营数据作为自动任务的完成条件。相关事项必须改写为本地执行准备包与明确的人工检查点：提供脚本、模板、筛选规则、证据字段、停止条件和放行标准；区分已知事实、假设与未验证项；不得声称外部行动已经发生。下游任务应使用标注限制的临时假设继续形成可交付方案，不能因等待现实世界证据而耗尽重试预算。"

const conciseManualTaskSummary = (summary: string) => {
  const text = summary.replace(/\s+/g, " ").trim()
  const subject = text.split(/[。；;]/, 1)[0] ?? text
  const bounded = subject.length > 180 ? `${subject.slice(0, 176)}…` : subject
  return `${bounded.replace(/[，。；;：:]+$/g, "")}（本地准备与人工核验）`
}

const conciseWorkItemTitle = (summary: string) => {
  const text = summary.replace(/\s+/g, " ").trim()
  const numbered = text.match(/\bD\d+(?:[–-]D\d+)?\s*《[^》]+》/)
  if (numbered) return `完成 ${numbered[0]}`
  const subject = text.split(/[。；;\n]/, 1)[0] ?? text
  return subject.length > 80 ? `${subject.slice(0, 76).replace(/[，、：:]+$/g, "")}…` : subject
}

const manualEvidencePattern =
  /(?:开展.{0,40}(?:访谈|问卷)|(?:访谈|问卷).{0,30}(?:反馈|答卷|样本|家庭|参与者)|样本不少于|至少[一二三四五六七八九十\d]+(?:个|份|组|场).{0,40}(?:家庭|访谈|反馈|报名|付费|试运行|试运营)|(?:实地|现场|踩点|远程).{0,35}(?:核验|验证|检查|测试)|场地.{0,35}(?:核验|许可|审批|照片|通信|撤离)|(?:招募|报名|收费|付费|订金|购买承诺|对外发布|发送问卷)|(?:实施|完成|组织|举行).{0,35}(?:试运行|试运营|线下活动|首场活动)|确认参与家庭.{0,35}(?:健康|过敏|同意|签到)|(?:到场率|满意度|复购意愿|推荐意愿|实际成本|每家庭收入|真实市场验证)|(?:conduct|run|complete|collect|obtain|contact|recruit|enroll|charge|publish|send|inspect|verify).{0,60}(?:interview|survey response|participant|family|venue|on-site|field visit|payment|deposit|pilot|attendance|satisfaction))/i

const manualEvidenceTermPattern =
  /(?:访谈|问卷|样本|家庭|参与者|实地|现场|踩点|远程|场地|招募|报名|收费|付费|订金|购买承诺|对外发布|发送问卷|试运行|试运营|线下活动|首场活动|到场率|满意度|复购意愿|推荐意愿|实际成本|真实市场验证|interview|survey|participant|family|venue|on-site|field visit|payment|deposit|pilot|attendance|satisfaction)/i

const hasRequiredManualEvidence = (value: string) =>
  value
    .split(/[。；;\n]/)
    .filter((clause) => {
      const term = clause.search(manualEvidenceTermPattern)
      if (term < 0) return true
      return !/(?:不得|禁止|不应|不能|无需|不含|不包含|不触发|不执行|不会|尚未|未曾|没有)/.test(
        clause.slice(0, term),
      )
    })
    .some((clause) => manualEvidencePattern.test(clause))

const normalizeExecutableTask = (task: SubTask): SubTask => {
  const original = `${task.summary}\n${task.acceptanceCriteria}`
  if (!manualEvidencePattern.test(original) || !hasRequiredManualEvidence(original)) return task
  const summary = task.summary.trim()
  const acceptance = task.acceptanceCriteria.trim()
  return {
    ...task,
    summary: conciseManualTaskSummary(summary),
    acceptanceCriteria: [
      "不得声称已经完成真人访谈、问卷回收、联系招募、报名付款、对外发布、实地核验或现场试运行。",
      `保留原待验证事项并形成可直接交给人工执行的准备包：${summary}；原验收要求：${acceptance}`,
      "准备包必须包含执行脚本或模板、对象或场地筛选规则、证据记录字段、风险与停止条件、负责人角色和人工放行标准。",
      "明确区分已知事实、临时假设和未验证项，并给出下游任务可继续采用的保守假设及其限制。",
    ].join(" "),
    workType: task.workType === "research" ? "analysis" : task.workType,
    role: task.role ? `${task.role}（本地准备）` : "本地执行准备与人工检查点设计角色",
  }
}

const quantitativeTaskPattern =
  /定价|价格|成本|盈亏|单位经济|预算|报价|formula|pricing|cost|margin|break[- ]?even/i

const normalizeOutputQualityTask = (task: SubTask): SubTask => {
  if (!quantitativeTaskPattern.test(`${task.summary}\n${task.acceptanceCriteria}`)) return task
  const qualityRequirement =
    "成果全文必须使用通顺、无歧义的中文；金额、人数、比例与单位必须准确搭配，提交前逐句检查并修正病句。"
  if (task.acceptanceCriteria.includes(qualityRequirement)) return task
  return {
    ...task,
    acceptanceCriteria: `${task.acceptanceCriteria} ${qualityRequirement}`,
  }
}

const normalizeInternalAcceptanceLanguage = (value: string) =>
  value
    .replace(/已验收的(\s*D\d+\b)/gi, "已完成内部核验的$1")
    .replace(/(\bD\d+\b)\s*已验收/gi, "$1 已完成内部核验")

const normalizeTaskAcceptanceLanguage = (task: SubTask): SubTask => ({
  ...task,
  summary: normalizeInternalAcceptanceLanguage(task.summary),
  acceptanceCriteria: normalizeInternalAcceptanceLanguage(task.acceptanceCriteria),
})

const normalizeStableCopyDependencies = (tasks: SubTask[]) => {
  const keyed = tasks.map((task, index) => ({ ...task, key: task.key ?? `task-${index + 1}` }))
  const visual = keyed.find(
    (task) =>
      inferWorkType(task) === "design" &&
      /(?:D3|SVG|画板|首屏|界面|原型|视觉)/i.test(`${task.summary}\n${task.acceptanceCriteria}`),
  )
  const copy = keyed.find(
    (task) =>
      inferWorkType(task) === "writing" &&
      /(?:D4|中文.{0,8}文案|首屏.{0,8}文案|文案)/i.test(`${task.summary}\n${task.acceptanceCriteria}`),
  )
  if (
    !visual ||
    !copy ||
    !/(?:D2|稳定编号|文案编号|逐一映射|编号.{0,20}映射|映射.{0,20}编号)/i.test(
      `${visual.summary}\n${visual.acceptanceCriteria}\n${copy.summary}\n${copy.acceptanceCriteria}`,
    )
  )
    return tasks
  const normalized = keyed.map((task) => {
    if (task.key === copy.key)
      return {
        ...task,
        parentKey: task.parentKey === visual.key ? undefined : task.parentKey,
        dependsOn: (task.dependsOn ?? []).filter((dependency) => dependency !== visual.key),
      }
    if (task.key !== visual.key) return task
    return {
      ...task,
      dependsOn: [...new Set([...(task.dependsOn ?? []), copy.key])],
    }
  })
  const order = (pending: SubTask[], ordered: SubTask[] = []): SubTask[] => {
    if (!pending.length) return ordered
    const known = new Set(ordered.map((task) => task.key))
    const index = pending.findIndex(
      (task) =>
        (!task.parentKey || known.has(task.parentKey)) &&
        (task.dependsOn ?? []).every((dependency) => known.has(dependency)),
    )
    if (index < 0) throw new Error("Delegation task dependencies contain a cycle or unknown key")
    return order(
      pending.filter((_, candidate) => candidate !== index),
      [...ordered, pending[index]!],
    )
  }
  return order(normalized)
}

const researchModeFor = (item: WorkItem) =>
  item.work_type === "research" &&
  /假设\s*[\/／]\s*待验证|需求假设|本地研究边界|不开展.{0,30}外部调研|不声称.{0,30}(?:调研|外部行动)|未经验证.{0,30}(?:显式|标注)/i.test(
    `${item.title}\n${item.description}\n${item.acceptance_criteria.join("\n")}`,
  )
    ? ("hypothesis_synthesis" as const)
    : undefined

const capabilityPacks = (workType: (typeof workTypes)[number]) => {
  if (workType === "coding") return ["software-implementation@1"]
  if (workType === "decision") return ["board-strategy@1"]
  if (workType === "writing") return ["document-authoring@1"]
  if (workType === "design") return ["design-production@1"]
  return ["research-analysis@1"]
}

const artifactTitle = (item: WorkItem, submission: unknown) => {
  if (item.work_type !== "writing") return item.title
  const parsed = submissions.writing.safeParse(submission)
  if (!parsed.success) return item.title
  return parsed.data.content.match(/^#\s+(.+)$/m)?.[1]?.trim() || item.title
}

const designArtifactFile = (item: WorkItem, submission: unknown) => {
  if (item.work_type !== "design") return
  const parsed = submissions.design.safeParse(submission)
  if (!parsed.success) return
  const source = parsed.data.artifacts
    .map((artifact) => artifact.description.match(/<svg\b[\s\S]*?<\/svg>/i)?.[0])
    .find((value): value is string => Boolean(value))
  if (!source) return
  const content = source
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|xlink:href)\s*=\s*(["'])(?!#)[^"']*\1/gi, "")
    .replace(/url\(\s*(?!#)[^)]+\)/gi, "none")
    .replace(/@import[^;]+;/gi, "")
  return {
    path: `artifacts/${item.id}-attempt-${item.attempt + 1}.svg`,
    content,
    evidence: {
      path: `artifacts/${item.id}-attempt-${item.attempt + 1}.svg`,
      media_type: "image/svg+xml",
      byte_length: Buffer.byteLength(content),
      sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
    },
  }
}

const structuredArtifactFile = (item: WorkItem, content: string) => ({
  path: `artifacts/${item.id}-attempt-${item.attempt + 1}.json`,
  content,
  evidence: {
    path: `artifacts/${item.id}-attempt-${item.attempt + 1}.json`,
    media_type: "application/json",
    byte_length: Buffer.byteLength(content),
    sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
  },
})

const numericValue = (value: string) => {
  const match = value.replace(/[*_`]/g, "").match(/-?\d[\d,]*(?:\.\d+)?/)
  if (!match) return
  const parsed = Number(match[0].replaceAll(",", ""))
  return Number.isFinite(parsed) ? parsed : undefined
}

const numericResultValue = (value: string) =>
  numericValue(value.split(/[=＝]/).at(-1) ?? value)

const markdownCells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())

const budgetTable = (content: string) => {
  const lines = content.split(/\r?\n/)
  const tables: {
    rows: { label: string; quantity: number; unitPrice: number; subtotal: number }[]
  }[] = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index]!.trim().startsWith("|")) continue
    const headers = markdownCells(lines[index]!)
    const separator = markdownCells(lines[index + 1]!)
    if (
      headers.length !== separator.length ||
      !separator.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")))
    )
      continue
    const quantityIndex = headers.findIndex((header) => /^(?:数量|qty|quantity)$/i.test(header.replace(/\s+/g, "")))
    const unitPriceIndex = headers.findIndex((header) =>
      /(?:估算)?单价|unit\s*(?:price|cost)|price\s*per/i.test(header),
    )
    const subtotalIndex = headers.findIndex((header) => /小计|subtotal|line\s*total/i.test(header))
    if (quantityIndex < 0 || unitPriceIndex < 0 || subtotalIndex < 0) continue
    const rows: { label: string; quantity: number; unitPrice: number; subtotal: number }[] = []
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const line = lines[rowIndex]!.trim()
      if (!line.startsWith("|")) break
      const cells = markdownCells(line)
      const quantity = numericValue(cells[quantityIndex] ?? "")
      const unitPrice = numericValue(cells[unitPriceIndex] ?? "")
      const subtotal = numericResultValue(cells[subtotalIndex] ?? "")
      if (quantity === undefined || unitPrice === undefined || subtotal === undefined) continue
      rows.push({
        label: cells.find((cell, cellIndex) =>
          cellIndex !== quantityIndex &&
          cellIndex !== unitPriceIndex &&
          cellIndex !== subtotalIndex &&
          /[\p{L}\p{N}]/u.test(cell),
        ) ?? `第${rows.length + 1}项`,
        quantity,
        unitPrice,
        subtotal,
      })
    }
    if (rows.length) tables.push({ rows })
  }
  return tables.toSorted((left, right) => right.rows.length - left.rows.length)[0]
}

const amountAfterEquation = (line?: string) => {
  if (!line) return
  const plain = line.replace(/[*_`]/g, "")
  const equalityIndex = Math.max(plain.lastIndexOf("="), plain.lastIndexOf("＝"))
  if (equalityIndex >= 0) return numericValue(plain.slice(equalityIndex + 1))
  const labelIndex = Math.max(plain.indexOf("："), plain.indexOf(":"))
  if (labelIndex >= 0) return numericValue(plain.slice(labelIndex + 1))
  return numericValue(plain)
}

const budgetArithmeticFindings = (content: string) => {
  const table = budgetTable(content)
  if (!table || table.rows.length < 2) return []
  const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
  const equalMoney = (left: number, right: number) => Math.abs(roundMoney(left) - roundMoney(right)) < 0.005
  const amount = (value: number) => `${roundMoney(value)}元`
  const expectedSubtotal = roundMoney(
    table.rows.reduce((total, row) => total + row.quantity * row.unitPrice, 0),
  )
  const lines = content.split(/\r?\n/).map((line) => line.replace(/[*_`]/g, ""))
  const arithmeticLine = (pattern: RegExp) => {
    const matchingIndexes = lines.flatMap((line, index) => (pattern.test(line) ? [index] : []))
    const matching = matchingIndexes.map((index) => lines[index]!)
    const labelIndexes = matchingIndexes.filter((index) => {
      const plain = lines[index]!
        .replace(/^\s*(?:#{1,6}\s*|\d+[.)、]\s*|[-+]\s*)/, "")
        .trim()
      return plain.replace(pattern, "").replace(/[:：\s]/g, "").length === 0
    })
    const labeledFormulas = labelIndexes.flatMap((index) =>
      lines.slice(index + 1).filter((line) => line.trim()).slice(0, 1),
    )
    return (
      matching.find((line) => /[=＝]/.test(line) && amountAfterEquation(line) !== undefined) ??
      labeledFormulas.find((line) => /[=＝]/.test(line) && amountAfterEquation(line) !== undefined) ??
      matching.find(
        (line) =>
          /[:：]\s*[（(]?\s*[0-9][\d,.]*\s*元/.test(line) && amountAfterEquation(line) !== undefined,
      )
    )
  }
  const subtotalLine = arithmeticLine(/(?:物料|预算|成本)小计(?:复算)?/)
  const reserveLine = arithmeticLine(/预备金/)
  const totalLine = arithmeticLine(/(?:预算总计|总计复算|合计总额)/)
  const remainingFormulaLine = arithmeticLine(/预算结余\s*(?:复算)?\s*(?:[:：=＝]|$)/)
  const inlineRemainingLine = lines.find((line) => /结余/.test(line))
  const declaredSubtotal = amountAfterEquation(subtotalLine)
  const declaredReserve = amountAfterEquation(reserveLine)
  const reservePercentLine = lines.find((line) => /预备金/.test(line) && /%/.test(line))
  const reserveDecimal = numericValue(reserveLine?.match(/[×*]\s*(0(?:\.\d+))/)?.[1] ?? "")
  const reservePercent =
    numericValue(reservePercentLine?.match(/([0-9][\d,.]*)\s*%/)?.[1] ?? "") ??
    (reserveDecimal === undefined ? undefined : reserveDecimal * 100)
  const declaredTotal = amountAfterEquation(totalLine)
  const remainingMatch = inlineRemainingLine?.match(
    /(?:较|相对)?\s*([0-9][\d,.]*)\s*元(?:预算)?(?:上限)?[^。；\n]{0,30}?结余\s*([0-9][\d,.]*)\s*元/,
  )
  const formulaBudgetCap = remainingFormulaLine?.match(
    /[（(]\s*([0-9][\d,.]*)\s*元?\s*[-－−]/,
  )?.[1]
  const budgetCap = numericValue(remainingMatch?.[1] ?? formulaBudgetCap ?? "")
  const declaredRemaining =
    amountAfterEquation(remainingFormulaLine) ?? numericValue(remainingMatch?.[2] ?? "")
  const expectedReserve =
    reservePercent === undefined ? declaredReserve : roundMoney((expectedSubtotal * reservePercent) / 100)
  const expectedTotal =
    expectedReserve === undefined ? undefined : roundMoney(expectedSubtotal + expectedReserve)
  const references = [
    ...content.matchAll(
      /D4(?:预算)?(?:总额|总计)(?:复算结果)?\s*(?:为|[:：=＝])?\s*\*{0,2}([0-9][\d,.]*)\s*元/gi,
    ),
  ].flatMap((match) => {
    const value = numericValue(match[1] ?? "")
    return value === undefined ? [] : [value]
  })
  const findings = [
    ...table.rows.flatMap((row, index) => {
      const expected = roundMoney(row.quantity * row.unitPrice)
      return equalMoney(expected, row.subtotal)
        ? []
        : [
            `预算表第${index + 1}项“${row.label}”小计错误：${row.quantity} × ${row.unitPrice} 应为 ${amount(expected)}，实际为 ${amount(row.subtotal)}`,
          ]
    }),
    ...(declaredSubtotal !== undefined && !equalMoney(declaredSubtotal, expectedSubtotal)
      ? [
          `预算表${table.rows.length}项逐行复算合计应为 ${amount(expectedSubtotal)}，成果写为 ${amount(declaredSubtotal)}`,
        ]
      : []),
    ...(declaredReserve !== undefined &&
    expectedReserve !== undefined &&
    !equalMoney(declaredReserve, expectedReserve)
      ? [
          `预备金按${reservePercent ?? "已声明比例"}%复算应为 ${amount(expectedReserve)}，成果写为 ${amount(declaredReserve)}`,
        ]
      : []),
    ...(declaredTotal !== undefined && expectedTotal !== undefined && !equalMoney(declaredTotal, expectedTotal)
      ? [`预算总计应为 ${amount(expectedTotal)}，成果写为 ${amount(declaredTotal)}`]
      : []),
    ...(budgetCap !== undefined &&
    declaredRemaining !== undefined &&
    expectedTotal !== undefined &&
    !equalMoney(declaredRemaining, budgetCap - expectedTotal)
      ? [
          `${amount(budgetCap)}预算上限的结余应为 ${amount(budgetCap - expectedTotal)}，成果写为 ${amount(declaredRemaining)}`,
        ]
      : []),
    ...(expectedTotal === undefined
      ? []
      : references
          .filter((reference) => !equalMoney(reference, expectedTotal))
          .map((reference) => `D4预算总额引用应为 ${amount(expectedTotal)}，成果写为 ${amount(reference)}`)),
  ]
  return [...new Set(findings)]
}

const fixedPrimaryGroupCount = (value: string) => {
  const match = value.match(
    /(?:以且仅以|固定(?:的)?(?:唯一)?主情景(?:仅)?(?:为|按)|(?:主情景|主场景)(?:固定|限定)?(?:为|按|：|:))\s*(\d+)\s*组家庭/,
  )
  return match ? Number(match[1]) : undefined
}

const declaredPrimaryGroupCounts = (value: string) =>
  value.split(/[。；;\n]/).flatMap((clause) => {
    if (!/(?:主情景|主场景)/.test(clause)) return []
    const direct = clause.match(/(?:主情景|主场景)[^。；\n]{0,20}?(?:为|采用|固定|按|：|:)\s*(\d+)\s*组/)
    const reverse = clause.match(/(?:固定|采用|按|以)\s*(\d+)\s*组家庭[^。；\n]{0,24}(?:主情景|主场景)/)
    const count = Number(direct?.[1] ?? reverse?.[1])
    return Number.isFinite(count) ? [count] : []
  })

const claimsPrematureDeliveryAcceptance = (value: string) =>
  value.split(/[。；;\n]/).some((clause) => {
    const match = clause.match(/(?:\bD\d+\b\s*已验收|已验收的\s*\bD\d+\b)/i)
    if (!match) return false
    return !/(?:不得|不能|不应|尚未|未被|不可|不要)[^。；\n]{0,20}$/.test(clause.slice(0, match.index))
  })

const acceptanceVerification = (item: WorkItem, summary: string, submission: unknown): VerifyResult => {
  const criteria = item.acceptance_criteria.join("\n")
  const title = artifactTitle(item, submission)
  const content =
    item.work_type === "writing" && submissions.writing.safeParse(submission).success
      ? submissions.writing.parse(submission).content
      : JSON.stringify(submission)
  const expectedTitle = criteria.match(/标题以[“"]([^”"]+)[”"]开头/)?.[1]
  const quoted = item.acceptance_criteria.flatMap((criterion) =>
    /(?:原样|逐字)/.test(criterion)
      ? [...criterion.matchAll(/[“"]([^”"\n]+)[”"]/g)].map((match) => match[1]!.trim())
      : [],
  )
  const strict = item.acceptance_criteria.flatMap((criterion) =>
    [...criterion.matchAll(/严格为\s*([^，、。；;\n]+)/g)].map((match) => match[1]!.trim()),
  )
  const quantitative = quantitativeTaskPattern.test(
    `${item.title}\n${item.description}\n${criteria}`,
  )
  const formulaLines = quantitative
    ? content.split(/\\n|\r?\n|[。；;]/).filter((line) => /[=＝]/.test(line))
    : []
  const ambiguousFormulaLines = formulaLines.filter((line) => {
    const formula = line.replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*)/, "")
    return /[+＋]/.test(formula) && /[-－]/.test(formula) && !/[()（）[\]]/.test(formula)
  })
  const symbolicFormulaLines = formulaLines.filter(
    (line) =>
      /[A-Za-z]/.test(line) &&
      (/(?:定价|价格|成本|预算|报价|小计|预备金|总计|结余|利润|毛利|pricing|price|cost|margin|revenue|profit)/i.test(
        line,
      ) ||
        /\b[A-Za-z_][A-Za-z0-9_]*\b\s*[×*/]\s*\b[A-Za-z_][A-Za-z0-9_]*\b/.test(line)),
  )
  const requiredPrimaryGroupCount = fixedPrimaryGroupCount(criteria)
  const primaryGroupCounts = declaredPrimaryGroupCounts(content)
  const findings = [
    ...(expectedTitle && !title.startsWith(expectedTitle)
      ? [`成果入口标题必须以 ${expectedTitle} 开头，实际为 ${title}`]
      : []),
    ...[...new Set([...quoted, ...strict])]
      .filter((literal) => !content.includes(literal))
      .map((literal) => `成果正文缺少必须原样出现的字面内容：${literal}`),
    ...(ambiguousFormulaLines.length
      ? ["定价或成本公式包含多项加减，但没有用括号明确运算顺序"]
      : []),
    ...(symbolicFormulaLines.length &&
    !/变量(?:[^\n。；]{0,40}(?:定义|说明|规则)|\s*[：:])|符号(?:定义|说明)|其中[：:]/.test(content)
      ? ["定价或成本公式使用了符号变量，但没有在同一成果中定义变量与单位"]
      : []),
    ...(quantitative &&
    /参与人数\s*(?:人民币|金额|¥)|(?:人民币|金额)\s*无关|(?:人数|家庭数)\s*(?:元|人民币)/.test(content)
      ? ["成果存在人数与金额单位混用或语句不通顺，需逐句修正后再提交"]
      : []),
    ...(requiredPrimaryGroupCount !== undefined && !primaryGroupCounts.includes(requiredPrimaryGroupCount)
      ? [`成果没有把 ${requiredPrimaryGroupCount} 组家庭声明为唯一主情景`]
      : []),
    ...primaryGroupCounts
      .filter((count) => requiredPrimaryGroupCount !== undefined && count !== requiredPrimaryGroupCount)
      .map(
        (count) =>
          `成果把 ${count} 组家庭声明为主情景，与固定的 ${requiredPrimaryGroupCount} 组家庭硬约束冲突`,
      ),
    ...(claimsPrematureDeliveryAcceptance(content)
      ? ["项目整体交付尚未由用户接受，内部工作项只能称为已完成系统核验或内部复核，不能称为已验收"]
      : []),
    ...budgetArithmeticFindings(content),
    ...(item.work_type === "analysis" &&
    /(?:交叉验收|最终验收|cross[- ]?acceptance)/i.test(`${item.title}\n${item.description}`) &&
    /(?:需返工|未通过|不通过|不能验收|暂不验收|未满足)/.test(
      `${summary}\n${
        submissions.analysis.safeParse(submission).success
          ? submissions.analysis.parse(submission).conclusions.join("\n")
          : ""
      }`,
    )
      ? ["交叉验收仍报告阻塞性缺陷，不能形成可验收交付"]
      : []),
  ]
  return { passed: findings.length === 0, findings }
}

const combineVerification = (base: VerifyResult, acceptance: VerifyResult): VerifyResult => ({
  passed: base.passed && acceptance.passed,
  findings: [...base.findings, ...acceptance.findings],
})

const deterministicCriterionResult = (item: WorkItem, artifact: Artifact, criterion: AcceptanceCriterion) => {
  if (!artifact.content) return { verdict: "failed" as const, observation: { reason: "artifact_content_missing" } }
  if (criterion.statement === "artifact_exists")
    return {
      verdict: "passed" as const,
      observation: { content_sha256: artifact.content_sha256, integrity_sha256: artifact.integrity_sha256 },
    }
  const expectedDigest = criterion.statement.match(/^artifact_sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase()
  if (expectedDigest)
    return {
      verdict: artifact.content_sha256 === expectedDigest ? ("passed" as const) : ("failed" as const),
      observation: { expected_sha256: expectedDigest, observed_sha256: artifact.content_sha256 },
    }
  const parsed = z.object({ summary: z.string(), submission: submissions[item.work_type] }).parse(JSON.parse(artifact.content))
  const verification = acceptanceVerification(
    { ...item, acceptance_criteria: [criterion.statement] },
    parsed.summary,
    parsed.submission,
  )
  return {
    verdict: verification.passed ? ("passed" as const) : ("failed" as const),
    observation: { findings: verification.findings },
  }
}

const executableCapabilityPacks = (values: string[], workType: (typeof workTypes)[number]) => {
  const available = new Set(CapabilityCatalog.list().map((pack) => `${pack.id}@${pack.version}`))
  const valid = values.filter((value) => available.has(value))
  return valid.length === values.length && valid.length ? valid : [...new Set([...valid, ...capabilityPacks(workType)])]
}

const permissionRank = {
  read_only: 0,
  workspace_write: 1,
  full_access: 2,
}

const assignmentConstraints = (references: string[]) => {
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

const executionClock = (projectCreatedAt?: number) =>
  [
    "日期规则：计划中的日期、截止时间和相对窗口必须使用明确时区并校验先后关系。模型调用时间是易变的宿主元数据，不得写入成果作为绝对最低时间门槛，也不得仅因 Worker、Reviewer 或重试发生在不同时间而要求改写已生成成果。",
    "用户明确要求从某个日历日期开始的计划时，该日期可以作为计划记录中的第1天，即使项目在当天稍后创建；这只表示计划覆盖范围，不表示较早时段的动作已经发生。不得仅因第1天早于项目创建时刻而拒绝，但必须把过去时段标为未执行的计划记录，不得伪称已完成。",
    projectCreatedAt === undefined
      ? "项目尚未创建时，不得虚构精确的当前时间；优先使用第1天、T-48小时等相对表达。"
      : `如业务验收确实需要项目级绝对时间，唯一稳定基准是项目创建时间 ${new Date(projectCreatedAt).toISOString()}；后续 Attempt 不得改变该基准。`,
  ].join("\n")

const safeExecutionFailure = (error: string) => {
  const text = error.trim()
  if (isContextOverflowMessage(text))
    return "当前任务输入超过模型上下文预算；系统已停止同内容自动重试，需先裁剪任务证据快照后再恢复。"
  if (/Document lacks structure/i.test(text))
    return "成果缺少清晰结构；请补充 Markdown 标题、编号章节或明确的章节分隔。"
  if (/cannot use system verification while review is required/i.test(text))
    return "当前工作项的系统核验状态与独立复核状态冲突，本次成果未能进入下一步；系统已保留成果，需修正复核范围后重试。"
  if (/Delivery acceptance remains unverified:/i.test(text)) {
    const reason = text.match(/Delivery acceptance remains unverified:\s*([^\n]+)/i)?.[1]?.trim()
    return reason
      ? `成果仍有未通过的验收项：${reason.slice(0, 600)}`
      : "成果仍有未通过的验收项，系统已保留成果并停止交付。"
  }
  if (/System verification Gate .* did not pass/i.test(text))
    return "系统核验未通过，本次成果已保留但不会进入交付；请按失败项修正后重试。"
  if (/INTERNAL_ERROR|stream error/i.test(text))
    return "模型服务连接中断，本次尝试未完成；系统已保留进度并按重试策略处理。"
  if (/timed?\s*out|timeout/i.test(text))
    return "本次执行等待超时，系统已保留进度并按重试策略处理。"
  if (/Cause\(\[|(?:^|\n)\s*at\s|\/(?:Users|home|private|Volumes)\/|[A-Za-z]:\\/i.test(text))
    return "本次执行遇到内部错误，系统已保留进度并按重试策略处理。"
  return text.split(/\r?\n/, 1)[0]!.slice(0, 800)
}

const executionFailurePolicy = (error: string) => {
  if (isContextOverflowMessage(error)) return { failure_kind: "environment" as const, retry_same_input: false }
  if (/Command is not allowed by the Control Plane|required (?:tool|runtime capability).*unavailable/i.test(error))
    return { failure_kind: "permission" as const, retry_same_input: false }
  if (/validation|verifier|acceptance remains unverified|Gate .* did not pass/i.test(error))
    return { failure_kind: "validator" as const, retry_same_input: true }
  if (/dependency|prerequisite/i.test(error))
    return { failure_kind: "dependency" as const, retry_same_input: false }
  return { failure_kind: "implementation" as const, retry_same_input: true }
}

const plannerScript = (goal: string, agentID: string, modelRef: string) =>
  workflow(
    "company-project-charter",
    [
      `phase("形成领域中立项目范围与计划")`,
      `const result = await agent(${json(
        [
          "你是 AgentCompany 的临时项目规划者，只负责定义目标边界与验收，不执行交付。",
          "根据目标形成领域中立的项目范围与计划。不要假设项目必须产出软件、浏览器、终端、游戏或 Git 仓库。",
          "只有目标明确要求软件实现时，才把软件开发写进范围。",
          executionClock(),
          `目标：${goal}`,
        ].join("\n"),
      )}, ${json({
        companyAgentID: agentID,
        role: "project-planner",
        capabilityPacks: ["product-charter@1"],
        requiredRuntimeCapabilities: ["structuredOutput", "workspaceRead"],
        permissionMode: "read_only",
        model: modelRef,
        schema: schema(charterResult),
        label: "项目范围与计划",
        phase: "Plan",
        timeoutMs: 20 * 60_000,
      })})`,
      `if (!result) throw new Error("project charter planner failed")`,
      `return result`,
    ].join("\n"),
  )

const approvedCharterScript = (charter: BoardProjectCharter) =>
  workflow(
    "company-project-approved-charter",
    [`phase("接收董事会已批准的项目范围与计划")`, `return ${json({ accepted: true, charter })}`].join("\n"),
  )

const approvedCharterFromProject = (charter: ProjectCharter) =>
  BoardProjectCharter.parse({
    title: charter.title,
    value: charter.value,
    deliverables: charter.deliverables,
    acceptance_criteria: charter.acceptance_criteria,
    scope: charter.scope,
    non_goals: charter.non_goals,
    constraints: charter.constraints,
    resources: charter.resources,
    risks: charter.risks,
    dri_agent_id: charter.dri_agent_id,
    milestones: charter.milestones,
    open_decisions: charter.open_decisions,
  })

const workerPermission = (
  item: WorkItem,
  policy: DeliveryPolicy,
  writeApproved: boolean,
  assignmentPermission: "read_only" | "workspace_write" | "full_access",
) => {
  const requested =
    item.work_type !== "coding" || (policy.source_approval_preset === "strict" && !writeApproved)
      ? "read_only"
      : policy.source_approval_preset === "autonomous"
        ? "full_access"
        : "workspace_write"
  return permissionRank[requested] <= permissionRank[assignmentPermission] ? requested : assignmentPermission
}

const riskApprovalCovers = (gate: ApprovalGate, item: WorkItem) =>
  gate.kind === "risk_approval" &&
  gate.status === "approved" &&
  gate.work_item_id === item.id &&
  JSON.stringify(gate.resource_scope) === JSON.stringify(item.resource_scope)

const requiresHighRiskApproval = (item: WorkItem, policy: DeliveryPolicy) =>
  policy.require_high_risk_approval &&
  item.risk_level === "high" &&
  /external write|external action|deploy|publish|release|delete|remove|payment|purchase|upload|外部写入|外部动作|对外|部署|发布|上线|删除|移除|支付|付款|采购|上传/i.test(
    [
      item.title,
      item.description,
      ...item.decision_scope,
      ...item.resource_scope,
      ...item.acceptance_criteria,
    ].join("\n"),
  )

const boardBiddingEvidenceRule = (item: WorkItem) =>
  /bidding|董事会/i.test(`${item.source_task_key ?? ""} ${item.title} ${item.description}`)
    ? "产品语义：Bidding 是已有 Group Session/Thread 内选择下一位发言者的机制，不是筛选 Thread 成员。董事会 Thread 可以包含全部固定董事；验收应检查实际产生高信号消息的 winner、选择或 pass 理由，以及全员 pass/预算结束，而不能把候选成员存在误判成其已经发言。"
    : undefined

const quantitativeClarityRule = (item: WorkItem) =>
  /定价|价格|成本|盈亏|单位经济|预算|报价|formula|pricing|cost|margin|break[- ]?even/i.test(
    `${item.title}\n${item.description}\n${item.acceptance_criteria.join("\n")}`,
  )
    ? "涉及定价、成本、盈亏、单位经济或公式时，每个公式必须用明确括号标出运算顺序，在同一处定义每个变量、单位和正负号，并用逐步代入的数值示例核对结果；纯文本与可访问文本必须同样无歧义。"
    : undefined

const boardCloseoutWritebackRule = (item: WorkItem) =>
  item.source_task_key === "board_closeout_and_organization_decision"
    ? [
        `本地运行服务写回协议事实：${JSON.stringify({
          source_task_key: item.source_task_key,
          stage: "before_board_closeout_writeback",
          current_response: "dri_signed_decision_payload",
          prewrite_board_record: "expected_absent",
          host_sequence: [
            "persist_current_response_as_artifact",
            "validate_artifact_and_dri_owner",
            "write_full_artifact_to_original_board_thread",
            "start_independent_reviewer",
          ],
          decision_basis: "completed_upstream_delivery_and_review_evidence",
          failed_attempt_policy: "preserve_as_audit_and_supersede_explicitly",
        })}`,
        "最终收口签署规则：当前回答就是项目 DRI 交给宿主持久化的正式决策正文，必须以“批准收口”或“继续执行”等可执行决定作答。快照处于写回之前；其中尚无最终 Board 消息、board_closeout.recorded 事件、当前 Worker completed、当前 Reviewer Artifact 或 accepted 都是预期状态，不得据此建议 hold、拒绝签署或判定最终收口未满足。只以上游交付及其独立复核证据判断是否可收口，不要把本轮回答之后才由宿主完成的状态当作本轮回答的先决条件，也不要谎称这些写回已经发生。若存在之前失败或被拒绝的收口记录，必须逐条回应 findings，并明确当前决定取代对应失败决定；旧记录由宿主保留作审计。",
      ].join("\n")
    : undefined

const workItemRuntimeEvidenceRule =
  "运行时语义：本地运行服务事实是在当前工作项启动前生成的快照，所以当前节点可能仍显示待执行、尝试次数少 1，当前独立复核也可能显示尚未启动。宿主随后负责把节点置为执行中、持久化本次回答为成果，并完成或阻塞节点；执行成员不应也不需要修改自己的状态。项目流程状态和运行时间是易变的宿主元数据，除非验收条件明确要求实时状态报告，不得把它们提升为业务结论或交付物的唯一时间基准。team_selections 中 execution_assignment_released=true 只表示该执行分配的容量已经结束，不表示用户已验收或项目角色已最终释放；最终验收只看 project.user_delivery_accepted。非代码执行成员由宿主以只读权限运行。不得仅因这种预运行快照、缺少自状态写入工具或没有另附未要求的系统级命令或网络审计而判定执行未发生。"

const projectArtifactPersistenceRule =
  "成果持久化语义：非代码 Worker 只需返回符合 Work Type 的完整结构化 submission；宿主会在回答返回后把它写为项目内不可变版本文件，并生成 artifact.evidence.host_materialized_file，其中包含项目相对路径、媒体类型、非零字节数和 sha256。Reviewer 看到该宿主证据且交付正文可逐项检查时，应将其视为真实、可打开的本地成果；不得要求 Worker 自行写文件、提供绝对路径、浏览器截图或回答之后才可能发生的打开记录。文件证据缺失、内容不完整或不满足原验收条件时仍必须拒绝。"

const currentArtifactTraceRule = (item: WorkItem) => {
  const visualDesign =
    item.work_type === "design" &&
    /画板|视觉|界面|线框|原型|SVG|可视|同屏|并置/i.test(
      `${item.title}\n${item.description}\n${item.acceptance_criteria.join("\n")}`,
    )
  const artifactPath = `artifacts/${item.id}-attempt-${item.attempt + 1}.${visualDesign ? "svg" : "json"}`
  return `本轮成果的确定宿主项目相对路径是 \`${artifactPath}\`；Work Type 核验通过后，复核前系统核验记录的确定路径是 \`artifacts/verification/${item.id}-attempt-${item.attempt + 1}.json\`。若本任务要求成果索引、版本表、证据映射或可打开入口，必须在当前 submission 中直接列出这两个路径并标明第 ${item.attempt + 1} 次提交、等待最终人工验收；不得写成“以宿主材料化证据为准”或留待回答后补填。路径由宿主在当前回答返回后按约定持久化，不得谎称已经人工打开或人工验收。`
}

const calendarDateBoundaryRule =
  "日期边界：用户只确认日历日期而未确认具体时刻或时区时，只能保留已确认日期并把精确日程标为待确认。除非 Goal Brief 或原验收条件明确把具体时刻、时区或更早截止时刻列为阻塞要求，不得在执行或复核阶段新增这些放行前提，也不得因此拒绝与该日程细节无关的内容成果。"

const reviewerRuntimeEvidenceRule =
  "当前回答本身就是本轮独立复核。不得要求当前 Reviewer 在启动前快照中已经 completed、已经有本轮 Artifact，或先由另一个 Reviewer 复核这次交付；accepted 后这些状态与复核 Gate 由宿主持久化。Worker 交付物早于 Reviewer 生成，因此其证据快照时间早于当前复核时间、项目流程状态随后从 executing 变为 reviewing 都是正常时序，不得仅据此拒绝，也不得要求把历史快照改写成复核时刻。运行事实中当前交付物的 evidence.work_type_verification 与 authority=control_plane、phase=pre_review 且 delivery_artifact_id 匹配当前交付物的 system_verification，是宿主在复核前生成的机器核验证据，不是 Worker 自述，也不等于人工验收。system_verification.delivery_artifact_sha256 必须匹配当前交付物 evidence.content_sha256；若有 materialized_file，其 path、media_type、byte_length、sha256 必须匹配 evidence.host_materialized_file。两种摘要分别校验结构化交付记录和实际材料化文件，不得把 JSON 记录摘要与 SVG 文件摘要误判为冲突。核验通过时不得再要求回答之后才会产生的另一份系统核验记录。若证据缺失、失败或对应字段不匹配，仍必须拒绝。只验收 parent 叶子任务及其上游依赖，不得把尚未获准运行的下游 WorkItem 处于 pending 当作 parent 的缺陷，除非 parent 的 depends_on 明确包含它。"

const designArtifactPersistenceRule = (item: WorkItem) =>
  item.work_type === "design" && /画板|视觉|界面|线框|原型|SVG|可视|同屏|并置/i.test(
    `${item.title}\n${item.description}\n${item.acceptance_criteria.join("\n")}`,
  )
    ? "本地运行服务会在当前回答返回后，把 design submission.artifacts[].description 中第一个完整、自包含且无外部资源的 <svg>…</svg> 安全持久化为项目内真实 SVG 文件，并生成路径、摘要与字节数证据。当前任务要求可视画板时，必须直接嵌入完整 SVG；不得只给“另存为文件”的说明、HTML 源码、链接或纯文字描述。SVG 必须在单一画布中直接包含全部待比较方向，不得含脚本、foreignObject 或外部资源。"
    : undefined

const reviewerDesignArtifactRule = (item: WorkItem) =>
  item.work_type === "design" && /画板|视觉|界面|线框|原型|SVG|可视|同屏|并置/i.test(
    `${item.title}\n${item.description}\n${item.acceptance_criteria.join("\n")}`,
  )
    ? "对于自包含 SVG 设计交付，本地运行服务事实中的 artifact.evidence.host_materialized_file 是宿主在 Worker 回答后写入项目目录并计算的文件证据。若该证据包含项目相对路径、image/svg+xml、非零字节数和 sha256，且交付物内的完整 SVG 可逐项检查，就应按真实持久化可视文件验收；不得再要求 Worker 自行写文件、提供绝对路径、浏览器截图或回答之后才可能存在的打开记录。证据缺失、SVG 不完整或视觉内容不满足原验收条件时仍必须拒绝。"
    : undefined

const stableCopyConsistencyRule = (item: WorkItem, userRevision?: string) => {
  const text = `${item.source_task_key ?? ""}\n${item.title}\n${item.description}\n${item.acceptance_criteria.join("\n")}`
  if (
    item.work_type === "writing" &&
    /(?:D4|中文.{0,8}文案|首屏.{0,8}文案)/i.test(text) &&
    /(?:D2|稳定编号|文案编号|逐一映射|映射)/i.test(text)
  )
    return "跨成果文案契约：本任务是稳定编号对应可见文案的唯一正文来源。每个编号必须给出一条可直接复用的最终可见字符串；标题、副标题、行动按钮等不得只给改写方向或多个备选。后续视觉成果会逐字复用这些字符串。"
  if (
    item.work_type !== "design" ||
    !/(?:D3|SVG|画板|首屏|界面|原型|视觉)/i.test(text) ||
    !/(?:D2|稳定编号|文案编号|映射)/i.test(text)
  )
    return
  if (userRevision)
    return "跨成果文案契约：从本地运行服务事实中读取最新上游文案成果。用户点名修改的视觉方向必须按稳定编号逐字采用最新文案；未点名的视觉方向和元素必须保持上一版不变。不得为追求方向差异自行改写可见文案。"
  return "跨成果文案契约：从本地运行服务事实中读取已完成的上游文案成果，并按稳定编号逐字复用标题、副标题、行动按钮等全部可见字符串。两个视觉方向只能改变布局、色彩、字体层级、组件形态与装饰处理，不得为制造差异改写同一编号的文案。"
}

const humanAcceptancePreparationRule = (item: WorkItem) =>
  /人工.{0,8}验收|验收清单|复核准备/i.test(
    `${item.title}\n${item.description}\n${item.acceptance_criteria.join("\n")}`,
  )
    ? "人工验收准备只按原始验收条件建立证据映射，不得擅自增加新的放行前提。系统核验是可供人工检查的有效内部证据，但绝不等于人工验收；除非原始验收条件明确要求某项必须另设独立 Reviewer，否则不得仅因该项只有系统核验而把它判为未通过。用户确认了日历日期但未确认具体时刻或时区时，只能保持为已确认日期与待确认的精确日程；除非原始验收条件明确要求具体时刻，不得把缺少精确时刻升级为阻塞成果验收的新条件。运行事实中的 project.status=completed 只表示机器工作项已完成，execution_assignment_released 只表示执行容量已结束；二者都不等于用户已验收或最终角色已释放。只有 user_delivery_accepted=true 才能表述为最终完成和最终释放；此前应表述为成果待人工验收、角色等待验收。"
    : undefined

const limitedRevisionRule = (userRevision?: string, baselineArtifactReference?: unknown) =>
  userRevision
    ? [
        `有限修改白名单：${userRevision}`,
        baselineArtifactReference
          ? `用户发出修改请求前的同任务基线交付引用：${JSON.stringify(baselineArtifactReference)}。必须使用 read 读取该路径后再修改，并以 integrity_sha256 作为不可变基线。`
          : "当前未提供同任务基线交付；不得因此扩大修改范围。",
        "修改请求中明确点名的成果和字段是唯一允许发生实质变化的白名单；所有未点名字段、模块、风险边界、方向和措辞必须与基线保持不变。组合任务中若用户只修改 D4 并明确 D5 保持不变，必须逐字保留基线 D5；若只修改标题和行动按钮，D4 其余模块也必须逐字保留。下游验收或复核任务只能更新由白名单变化必然导致的版本号、证据路径、摘要值和核验状态，不得改写其他实质内容。summary 必须逐项列出实际改动和保持不变的部分；无法证明未越界时不得声称完成。",
      ].join("\n")
    : undefined

const reviewRepairRule = (
  reviewFeedback?: { artifact_id: string; summary: string; findings: string[]; evidence_checked: string[] },
  baselineArtifactReference?: unknown,
) =>
  reviewFeedback
    ? [
        `独立复核返工范围：${JSON.stringify(reviewFeedback.findings)}`,
        baselineArtifactReference
          ? `上一 Attempt 的不可变基线交付引用：${JSON.stringify(baselineArtifactReference)}。必须使用 read 读取该路径，并按 integrity_sha256 核对未改区域。`
          : undefined,
        "只修复复核 findings 对应的验收条件；所有未涉及内容必须保持不变。提交后仍须重新核对全部原验收条件，不能只核对本轮修复项。",
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n")
    : undefined

const deliveryAcceptanceLanguageRule =
  "工作项通过系统核验或独立复核，只能表述为“已完成系统核验”或“已完成内部复核”。只有用户接受项目整体交付后才能使用“已验收”；当前执行阶段不得把上游 D1、D2、D3 等交付项写成已验收。"

const workerScript = (
  goal: string,
  projectCreatedAt: number,
  item: WorkItem,
  modelRef: string,
  policy: DeliveryPolicy,
  writeApproved: boolean,
  assignmentPermission: "read_only" | "workspace_write" | "full_access",
  evidence: unknown,
  reviewFeedback?: { artifact_id: string; summary: string; findings: string[]; evidence_checked: string[] },
  userRevision?: string,
  baselineArtifactReference?: unknown,
) =>
  workflow(
    `company-project-worker-${item.work_type}`,
    [
      `phase(${json(`执行：${item.title}`)})`,
      `const result = await agent(${json(
        [
          `公司目标：${goal}`,
          executionClock(projectCreatedAt),
          `你的临时角色：${item.role}`,
          `任务：${item.description}`,
          `验收条件：\n- ${item.acceptance_criteria.join("\n- ")}`,
          `本地运行服务当前可验证事实：${JSON.stringify(evidence)}`,
          "项目范围与计划中的约束和用户已确认事项是硬边界；任何收费、发布、外部副作用、预算、日期、资质或安全结论都不得与其冲突。存在冲突时必须停止该建议并明确前置条件。",
          /(?:合作方|资质|许可|备案|保险|主管要求)/.test(
            `${goal}\n${item.title}\n${item.description}\n${item.acceptance_criteria.join("\n")}`,
          )
            ? "若项目范围允许通过合格或合规合作方开展后续动作，合作方身份本身不构成合规证据；必须把适用于具体活动范围的资质、许可、备案、保险和主管要求书面依据列为放行前提，缺失或冲突时继续保持未核实且不得对外执行或收费。"
            : undefined,
          /(?:未成年人|儿童|监护人|child|minor|guardian)/i.test(
            `${goal}\n${item.title}\n${item.description}\n${item.acceptance_criteria.join("\n")}`,
          )
            ? "涉及未成年人保护疑虑或风险披露时，不得自动通知任何可能涉事或身份未核实的监护人。只允许先保障儿童即时安全、做最少必要记录，并按已经书面核验的保护程序升级给有权限的保护责任人，由其决定是否、何时及向谁沟通并记录理由；程序或权限未核实时必须停止相关参与，无法安全维持群体时停止全队。"
            : undefined,
          item.error
            ? `上一轮系统核验未通过：${item.error}。本次必须直接修正该问题并重新逐项核对，不能只解释或复述失败原因。`
            : undefined,
          item.work_type === "decision"
            ? "Decision 结构硬约束：submission.recommendedId 必须逐字等于 submission.approaches 中某个非空 id；即使结论尚待后续研究，也必须从已列候选中给出当前证据下的暂定推荐，并在 reasoning 中写明验证门槛和可逆条件，不能另填 pending、unknown 或候选列表外的值。"
            : undefined,
          reviewFeedback
            ? `上一轮独立复核要求返工：${JSON.stringify(reviewFeedback)}。必须逐条回应 findings，并提交修正后的实际证据。`
            : undefined,
          userRevision
            ? `用户已请求修改上一版交付：${userRevision}。必须逐条落实，只生成新的可验收成果，不得把修改要求仅复述在总结或交叉验收报告中。`
            : undefined,
          boardBiddingEvidenceRule(item),
          quantitativeClarityRule(item),
          boardCloseoutWritebackRule(item),
          projectArtifactPersistenceRule,
          currentArtifactTraceRule(item),
          calendarDateBoundaryRule,
          designArtifactPersistenceRule(item),
          stableCopyConsistencyRule(item, userRevision),
          humanAcceptancePreparationRule(item),
          limitedRevisionRule(userRevision, baselineArtifactReference),
          reviewRepairRule(reviewFeedback, baselineArtifactReference),
          workItemRuntimeEvidenceRule,
          deliveryAcceptanceLanguageRule,
          `你独占的决策范围：${item.decision_scope.join("；") || "无"}`,
          `允许使用或修改的资源范围：${item.resource_scope.join("；") || "仅返回结构化交付物"}`,
          "只执行这一个叶子任务，不重新规划整个项目，不替其他子树做决定。",
          "严格最小化交付：只输出本任务描述与验收条件明确要求的内容。不得主动附加通用准备包、风险、合规、安全、筛选、放行、证据模板或其他叶子任务内容；只有本任务明确要求的章节才可出现。",
          "面向用户的正文必须使用非技术业务中文；禁止用单字母状态码或未解释缩写替代证据状态、风险、决定和负责人；内部实体 ID 只能放在追踪信息中，不能代替人员、成果、阶段或决定的可读名称。",
          item.review_status === "not_required"
            ? "本任务不设独立 Reviewer：提交前必须逐条自检验收条件，并在 summary 中说明每条的自检结果。"
            : undefined,
          "如果当前事实包含上一次独立复核的问题，本次必须逐项返工，并用本地运行服务中已经发生的实体、状态和内容交付证据；不得把计划中的后续动作写成已完成。",
          item.work_type === "coding"
            ? "在授权工作树内完成实现，并亲自运行测试、检查与构建；verificationCommands 必须填写可由宿主再次执行的真实命令。"
            : "返回符合当前 Work Type 结构的 submission，所有结论必须能被验收条件直接检查。",
        ].join("\n"),
      )}, ${json({
        companyAgentID: item.owner_agent_id,
        role: item.role,
        capabilityPacks: executableCapabilityPacks(item.capability_packs, item.work_type),
        requiredRuntimeCapabilities: [
          "toolCalls",
          "structuredOutput",
          "workspaceRead",
          ...(item.work_type === "coding" ? ["workspaceWrite"] : []),
        ],
        permissionMode: workerPermission(item, policy, writeApproved, assignmentPermission),
        model: modelRef,
        schema: schema(z.object({ summary: z.string(), submission: submissions[item.work_type] })),
        label: item.title,
        phase: "Execute",
        timeoutMs: item.work_type === "coding" ? 2 * 60 * 60_000 : 45 * 60_000,
      })})`,
      `if (!result) throw new Error("worker failed")`,
      `return result`,
    ].join("\n"),
  )

const reviewerScript = (
  goal: string,
  projectCreatedAt: number,
  item: WorkItem,
  parent: WorkItem,
  artifactReference: unknown,
  modelRef: string,
  evidence: unknown,
  criteria: AcceptanceCriterion[],
  artifactPath?: string,
  userRevision?: string,
  baselineArtifactReference?: unknown,
) =>
  workflow(
    `company-project-review-${parent.work_type}`,
    [
      `phase(${json(`独立复核：${parent.title}`)})`,
      `const result = await agent(${json(
        [
          `公司目标：${goal}`,
          executionClock(projectCreatedAt),
          `被复核任务：${parent.title}`,
          `原验收条件：\n- ${parent.acceptance_criteria.join("\n- ")}`,
          criteria.length ? `逐项验收合同：${JSON.stringify(criteria)}` : undefined,
          `交付物引用：${JSON.stringify(artifactReference)}`,
          artifactPath ? `当前候选 Artifact 文件：${artifactPath}` : undefined,
          `本地运行服务当前可验证事实：${JSON.stringify(evidence)}`,
          "必须逐项核对项目范围与计划的约束和用户已确认事项；交付若越过收费、发布、外部副作用、预算、日期、资质或安全边界，必须拒绝并指出冲突。",
          "如果拒绝，必须在同一轮列出当前交付物中所有可检测、会阻塞验收的独立问题，并逐条绑定原验收条件；不得把已经能发现的问题留到后续修订轮次。相同根因只保留一条。",
          "若项目范围允许通过合格或合规合作方开展后续动作，合作方身份本身不构成合规证据；必须有可追溯书面依据证明其资质、许可、备案、保险和主管要求适用于具体活动范围，否则该路径仍视为未核实。",
          "涉及未成年人保护疑虑或风险披露时，交付不得要求自动通知任何可能涉事或身份未核实的监护人；必须先保障即时安全、最少必要记录，并仅按已书面核验程序升级给有权限的保护责任人。程序或权限未核实时必须停止相关参与，无法安全维持群体时停止全队。",
          boardBiddingEvidenceRule(parent),
          quantitativeClarityRule(parent),
          workItemRuntimeEvidenceRule,
          reviewerRuntimeEvidenceRule,
          projectArtifactPersistenceRule,
          calendarDateBoundaryRule,
          reviewerDesignArtifactRule(parent),
          stableCopyConsistencyRule(parent, userRevision),
          humanAcceptancePreparationRule(parent),
          limitedRevisionRule(userRevision, baselineArtifactReference),
          "你没有参与原任务。只根据交付物、证据和验收条件判断，不因执行者自述而放宽标准。",
          artifactPath
            ? `接受或拒绝前必须使用 read 或有非空命中的 grep 真实读取当前候选 Artifact 文件 ${artifactPath}；不得仅复述元数据或 evidence_checked。`
            : undefined,
          criteria.some((criterion) => criterion.verification_kind === "deterministic")
            ? "逐项合同包含 deterministic 条件，必须额外执行成功的机械核验，并让工具参数或输出明确关联当前候选 Artifact。"
            : undefined,
          "复核结论必须使用非技术业务中文；禁止用单字母状态码或未解释缩写替代证据状态、风险和决定；内部实体 ID 只能作为追踪证据，不能作为主要结论。",
          criteria.length
            ? "criterion_results 必须覆盖逐项验收合同中的每个 criterion_id，且只能各出现一次；若结构化运行器无法回填 ID，可原样返回 criterion_statement 供宿主精确映射。每项必须给出 passed 或 failed、独立证据和判断摘要。accepted 必须严格等于所有必需项均 passed。"
            : undefined,
        ].join("\n"),
      )}, ${json({
        companyAgentID: item.owner_agent_id,
        role: item.role,
        capabilityPacks: [
          "independent-review@1",
          ...(criteria.some((criterion) => criterion.verification_kind === "deterministic")
            ? ["verification-testing@1"]
            : []),
        ],
        requiredRuntimeCapabilities: ["toolCalls", "structuredOutput", "workspaceRead"],
        permissionMode: "read_only",
        model: modelRef,
        schema: schema(reviewResult),
        label: item.title,
        phase: "Review",
        timeoutMs: 45 * 60_000,
      })})`,
      `if (!result) throw new Error("reviewer failed")`,
      `return result`,
    ].join("\n"),
  )

export interface Interface {
  readonly start: (input: {
    company_id?: string
    goal: string
    title?: string
    decision_request_id?: string
    session_id?: string
    provider_id?: string
    model_id?: string
    charter?: BoardProjectCharter
    execution_strategy?: ProjectExecutionStrategyValue
    seed_policy?: SeedPolicyFactsValue
    approval_preset?: ApprovalPreset
  }) => Effect.Effect<{ project: Project; run_id: string }>
  readonly startFromCharter: (input: {
    company_id: string
    root_need_id: string
    source_thread_id: string
    request_id: string
    goal: string
    charter: BoardProjectCharter
    provider_id?: string
    model_id?: string
    execution_strategy?: ProjectExecutionStrategyValue
    seed_policy?: SeedPolicyFactsValue
  }) => Effect.Effect<
    {
      project: Project
      charter: ProjectCharter
      plan: Plan
      work_item: WorkItem
      run_id?: string
      replayed: boolean
    },
      InstanceType<typeof BoardProjectDecisionConflict>
    >
  readonly replanFromCharter: (input: {
    project_id: string
    plan_id: string
    charter: BoardProjectCharter
  }) => Effect.Effect<{
    project: Project
    plan: Plan
    work_item: WorkItem
    run_id?: string
    replayed: boolean
  }>
  readonly retry: (input: {
    project_id: string
    provider_id?: string
    model_id?: string
  }) => Effect.Effect<{ project: Project; run_id: string }>
  readonly resolveGate: (input: {
    gate_id: string
    decision: "approve" | "reject"
    note?: string
  }) => Effect.Effect<{ gate: ApprovalGate; run_id?: string }>
  readonly cancel: (input: { project_id: string; reason?: string }) => Effect.Effect<Project>
  readonly dispatchReady: (project_id: string) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyProjectExecution") {}

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const projects = yield* CompanyProject.Service
    const recruitment = yield* CompanyRecruitment.Service
    const conversation = yield* Conversation.Service
    const delegation = yield* Delegation.Service
    const reputation = yield* Reputation.Service
    const sessions = yield* Session.Service
    const runtime = yield* WorkflowRuntime.Service
    const agentRuns = yield* AgentRun.Service
    const workType = yield* WorkType.Service
    const receiptProcessor = yield* ReceiptProcessor.Service
    const validation = yield* CompanyValidationGate.Service
    const acceptanceFacts = yield* CompanyAcceptanceFactService
    const attention = yield* CompanyAttention.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const scope = yield* Scope.Scope

    const resolveModel = Effect.fn("CompanyProjectExecution.resolveModel")(function* (input: {
      provider_id?: string
      model_id?: string
    }) {
      if (Boolean(input.provider_id) !== Boolean(input.model_id))
        throw new Error("provider_id and model_id must be provided together")
      if (input.provider_id && input.model_id)
        return { providerID: ProviderID.make(input.provider_id), modelID: ModelID.make(input.model_id) }
      return undefined
    })

    const model = (project: Project) =>
      project.provider_id && project.model_id
        ? { providerID: ProviderID.make(project.provider_id), modelID: ModelID.make(project.model_id) }
        : undefined

    const agentModelRef = (project: Project, group: "ultra" | "standard" | "lite") =>
      project.provider_id && project.model_id ? `${project.provider_id}/${project.model_id}` : group

    const contextBudget = Effect.fn("CompanyProjectExecution.contextBudget")(function* (
      project: Project,
      modelRef: string,
    ) {
      return yield* Effect.gen(function* () {
        return taskContextBudget({
          cfg: yield* config.get(),
          model: yield* provider.resolveModelRef(
            modelRef,
            project.provider_id ? ProviderID.make(project.provider_id) : undefined,
          ),
        })
      }).pipe(Effect.catchCause(() => Effect.succeed(defaultTaskContextBudget())))
    })

    const publishProjectUpdate = Effect.fn("CompanyProjectExecution.publishProjectUpdate")(function* (input: {
      project: Project
      request_id: string
      body: string
      signal_type: "conclusion" | "plan" | "status" | "risk" | "approval" | "delivery" | "intervention"
      actor_id?: string
    }) {
      if (!input.project.company_id) return
      yield* conversation.recordProjectUpdate({
        companyID: CompanyID.parse(input.project.company_id),
        projectScopeID: input.project.id,
        requestID: input.request_id,
        author: input.actor_id
          ? { kind: "agent", id: input.actor_id }
          : { kind: "system", id: "control-plane" },
        body: input.body,
        signalType: input.signal_type,
      }).pipe(Effect.catchCause(() => Effect.void))
    })

    const resolveNewExecution = (input: {
      goal: string
      charter?: BoardProjectCharter
      execution_strategy?: ProjectExecutionStrategyValue
      seed_policy?: SeedPolicyFactsValue
    }): {
      execution_strategy: ProjectExecutionStrategyValue
      seed_policy?: SeedPolicyFactsValue
      verdict?: SeedPolicyVerdict
      shadow?: {
        seed_policy: SeedPolicyFactsValue
        verdict: SeedPolicyVerdict
      }
    } => {
      const strategy = CompanyRollout.resolveNewProjectStrategy(input.execution_strategy)
      if (strategy !== "seed_and_grow") {
        if (!input.seed_policy || !CompanyRollout.shadowEnabled())
          return { execution_strategy: "legacy_full_plan" as const }
        const seed_policy = SeedPolicyFacts.parse(input.seed_policy)
        return {
          execution_strategy: "legacy_full_plan" as const,
          shadow: { seed_policy, verdict: evaluateSeedPolicy(seed_policy) },
        }
      }
      const seed_policy = input.seed_policy ? SeedPolicyFacts.parse(input.seed_policy) : defaultSeedPolicy(input)
      return {
        execution_strategy: "seed_and_grow" as const,
        seed_policy,
        verdict: evaluateSeedPolicy(seed_policy),
      }
    }

    const persistShadowSeedVerdict = Effect.fn("CompanyProjectExecution.persistShadowSeedVerdict")(function* (
      project: Project,
      shadow: {
        seed_policy: SeedPolicyFactsValue
        verdict: SeedPolicyVerdict
      },
    ) {
      const sourceKey = `shadow-seed-policy:${project.id}:v1`
      const existing = CompanyRollout.getShadowEvaluation(sourceKey)
      if (existing) return existing
      const input = { projectGoal: project.goal, seedPolicy: shadow.seed_policy }
      const before = CompanyRollout.projectBusinessStateSha256(project.id)
      const after = CompanyRollout.projectBusinessStateSha256(project.id)
      return CompanyRollout.recordShadowEvaluation({
        projectId: project.id,
        sourceKey,
        kind: "seed_policy",
        snapshotSha256: CompanyRollout.valueSha256(input),
        businessStateBeforeSha256: before,
        businessStateAfterSha256: after,
        input,
        output: { verdict: shadow.verdict },
        status: "evaluated",
      })
    })

    const persistSeedVerdict = Effect.fn("CompanyProjectExecution.persistSeedVerdict")(function* (
      project: Project,
      verdict: SeedPolicyVerdict,
    ) {
      const existing = (yield* projects.listArtifacts(project.id)).find(
        (artifact) => artifact.kind === "seed_policy" && Boolean(artifact.content),
      )
      if (existing) {
        const persisted = SeedPolicyVerdict.parse(JSON.parse(existing.content!))
        if (JSON.stringify(persisted) !== JSON.stringify(verdict))
          throw new Error(`Company project ${project.id} has a different persisted SeedPolicy verdict`)
        return existing
      }
      return yield* projects.addArtifact({
        project_id: project.id,
        kind: "seed_policy",
        title: "Seed Policy",
        path: "artifacts/seed-policy.json",
        content: `${JSON.stringify(verdict, null, 2)}\n`,
        evidence: { mode: verdict.mode, reason_codes: verdict.reason_codes },
        created_by_agent_id: project.owner_agent_id,
      })
    })

    const seedVerdict = Effect.fn("CompanyProjectExecution.seedVerdict")(function* (project: Project) {
      const artifact = (yield* projects.listArtifacts(project.id)).find(
        (candidate) => candidate.kind === "seed_policy" && Boolean(candidate.content),
      )
      if (!artifact?.content) throw new Error(`Company project ${project.id} has no persisted SeedPolicy verdict`)
      const verdict = SeedPolicyVerdict.parse(JSON.parse(artifact.content))
      if (verdict.mode !== project.seed_mode)
        throw new Error(`Company project ${project.id} SeedPolicy verdict differs from its pinned seed mode`)
      return verdict
    })

    const completeValidatedWorkItem = Effect.fn("CompanyProjectExecution.completeValidatedWorkItem")(function* (input: {
      item: WorkItem
      artifact: Artifact
      summary: string
    }) {
      if (!input.artifact.content) throw new Error(`Artifact ${input.artifact.id} has no persisted bytes`)
      if (input.item.validation_contract_version === 2) {
        if (!input.artifact.attempt_id || !input.artifact.integrity_sha256)
          throw new Error(`Artifact ${input.artifact.id} has no current Attempt lineage`)
        const coverage = yield* acceptanceFacts.assertCompletable({
          project_id: input.item.project_id,
          work_item_id: input.item.id,
          attempt_id: input.artifact.attempt_id,
          artifact_id: input.artifact.id,
        })
        const factIDs = coverage.criteria.flatMap((criterion) =>
          criterion.required && criterion.fact_id ? [criterion.fact_id] : [],
        )
        yield* projects.completeWorkItemWithReceipt({
          id: input.item.id,
          receipt: {
            idempotency_key: `delivery:${input.item.id}:attempt:${input.item.attempt + 1}`,
            outcome: "completed",
            summary: input.summary,
            artifact_ids: [input.artifact.id],
            evidence_refs: [{ kind: "artifact" as const, id: input.artifact.id }],
            confirmed_facts: coverage.criteria.map(
              (criterion) =>
                `acceptance:${criterion.criterion_id}:${criterion.state}:fact:${criterion.fact_id ?? "missing"}`,
            ),
            invalidated_assumptions: [],
            unknowns: [],
            blockers: [],
            capability_gaps: [],
            task_proposals: [],
            dependency_proposals: [],
            questions: [],
          },
          acceptance: { artifact_id: input.artifact.id, fact_ids: factIDs },
        })
        const project = yield* projects.get(input.item.project_id)
        if (project)
          yield* publishProjectUpdate({
            project,
            request_id: `work-item-completed:${input.item.id}:${input.artifact.id}`,
            actor_id: input.item.owner_agent_id,
            signal_type: "status",
            body: [
              `阶段成果已完成：${input.item.title}`,
              `结果：${input.summary}`,
              `成果已保存：${input.artifact.title}`,
            ].join("\n"),
          })
        return { gate_ids: [], artifact_sha256: input.artifact.content_sha256 }
      }
      yield* validation.evaluateProjectPending(input.item.project_id)
      const artifact_sha256 = new Bun.CryptoHasher("sha256").update(input.artifact.content).digest("hex")
      const passedGates = (yield* validation.list(input.item.project_id)).filter(
        (gate) =>
          gate.work_item_id === input.item.id &&
          gate.status === "passed" &&
          gate.evidence_refs.length > 0 &&
          gate.evaluator !== "artifact_digest_v1",
      )
      const criteria = input.item.acceptance_criteria.map((criterion, index) => {
        const digest = criterion.match(/^artifact_sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase()
        const exists = criterion === "artifact_exists"
        const proven = passedGates.find((gate) => gate.criteria.some((candidate) => candidate.statement === criterion))
        return {
          id: `criterion-${index + 1}-${new Bun.CryptoHasher("sha256").update(criterion).digest("hex").slice(0, 24)}`,
          statement: criterion,
          anchor: { kind: "artifact" as const, reference: `artifact:${input.artifact.id}` },
          operator: exists ? ("exists" as const) : ("digest" as const),
          expected: exists ? true : (digest ?? "0".repeat(64)),
          deterministic: exists || Boolean(digest) || Boolean(proven),
          proven,
        }
      })
      const artifactCriteria = criteria.filter((criterion) => !criterion.proven)
      const gate = artifactCriteria.length
        ? yield* validation.create({
            id: `delivery-${new Bun.CryptoHasher("sha256")
              .update(`${input.item.id}:${input.item.attempt + 1}:${input.artifact.id}`)
              .digest("hex")
              .slice(0, 40)}`,
            project_id: input.item.project_id,
            work_item_id: input.item.id,
            kind: "artifact",
            criteria: artifactCriteria.map((criterion) => ({
              id: criterion.id,
              statement: criterion.statement,
              anchor: criterion.anchor,
              operator: criterion.operator,
              expected: criterion.expected,
            })),
            blocking_work_item_ids: [input.item.id],
            evaluator: "artifact_digest_v1",
            max_repair_rounds: 3,
          })
        : undefined
      if ((gate && gate.status !== "passed") || criteria.some((criterion) => !criterion.deterministic))
        throw new Error(
          `Delivery acceptance remains unverified: ${criteria
            .filter((criterion) => !criterion.deterministic)
            .map((criterion) => criterion.statement)
            .join("; ")}`,
        )
      yield* projects.completeWorkItemWithReceipt({
        id: input.item.id,
        receipt: {
          idempotency_key: `delivery:${input.item.id}:attempt:${input.item.attempt + 1}`,
          outcome: "completed",
          summary: input.summary,
          artifact_ids: [input.artifact.id],
          evidence_refs: [{ kind: "artifact", id: input.artifact.id }],
          confirmed_facts: criteria.map((criterion) =>
            criterion.proven
              ? `deterministic:${criterion.statement}:validation_gate:${criterion.proven.id}:passed`
              : `deterministic:${criterion.statement}:artifact:${input.artifact.id}:sha256:${artifact_sha256}:validation_gate:${gate!.id}:passed`,
          ),
          invalidated_assumptions: [],
          unknowns: [],
          blockers: [],
          capability_gaps: [],
          task_proposals: [],
          dependency_proposals: [],
          questions: [],
        },
      })
      const project = yield* projects.get(input.item.project_id)
      if (project)
        yield* publishProjectUpdate({
          project,
          request_id: `work-item-completed:${input.item.id}:${input.artifact.id}`,
          actor_id: input.item.owner_agent_id,
          signal_type: "status",
          body: [
            `阶段成果已完成：${input.item.title}`,
            `结果：${input.summary}`,
            `成果已保存：${input.artifact.title}`,
          ].join("\n"),
        })
      return {
        gate_ids: [
          ...new Set(
            criteria.flatMap((criterion) => (criterion.proven ? [criterion.proven.id] : gate ? [gate.id] : [])),
          ),
        ],
        artifact_sha256,
      }
    })

    const recordDeterministicAcceptanceFacts = Effect.fn(
      "CompanyProjectExecution.recordDeterministicAcceptanceFacts",
    )(function* (input: { item: WorkItem; artifact: Artifact; verification_artifact: Artifact }) {
      if (input.item.validation_contract_version !== 2) return []
      if (!input.artifact.attempt_id || !input.artifact.integrity_sha256)
        throw new Error(`Artifact ${input.artifact.id} has no current Attempt lineage`)
      const criteria = (yield* acceptanceFacts.listCriteria(input.item.id)).filter(
        (criterion) => criterion.verification_kind === "deterministic",
      )
      return yield* Effect.forEach(
        criteria,
        (criterion) => {
          const result = deterministicCriterionResult(input.item, input.artifact, criterion)
          return acceptanceFacts.record({
            project_id: input.item.project_id,
            work_item_id: input.item.id,
            attempt_id: input.artifact.attempt_id!,
            artifact_id: input.artifact.id,
            criterion_id: criterion.id,
            verdict: result.verdict,
            authority: "control_plane",
            evaluator: criterion.evaluator!,
            observation: result.observation,
            evidence_refs: [
              { kind: "artifact", id: input.artifact.id },
              { kind: "artifact", id: input.verification_artifact.id },
            ],
            idempotency_key: `deterministic:${input.artifact.id}:${criterion.id}:${criterion.evaluator}`,
          })
        },
        { concurrency: 1 },
      )
    })

    const recordReviewerAcceptanceFacts = Effect.fn(
      "CompanyProjectExecution.recordReviewerAcceptanceFacts",
    )(function* (input: {
      item: WorkItem
      artifact: Artifact
      review_artifact: Artifact
      agent_run_id: string
      tool_event_ids: string[]
      result: z.infer<typeof reviewResult>
    }) {
      if (input.item.validation_contract_version !== 2) return []
      if (!input.artifact.attempt_id || !input.artifact.integrity_sha256)
        throw new Error(`Artifact ${input.artifact.id} has no current Attempt lineage`)
      const criteria = yield* acceptanceFacts.listCriteria(input.item.id)
      const results = (input.result.criterion_results ?? []).map((result) => ({
        ...result,
        criterion_id:
          result.criterion_id ??
          criteria.find((criterion) => criterion.statement === result.criterion_statement)?.id ??
          "",
      }))
      const ids = results.map((result) => result.criterion_id)
      if (
        ids.length !== criteria.length ||
        new Set(ids).size !== ids.length ||
        criteria.some((criterion) => !ids.includes(criterion.id))
      )
        throw new Error(`Reviewer must return exactly one result for every criterion of ${input.item.id}`)
      const coverage = yield* acceptanceFacts.currentCoverage({
        project_id: input.item.project_id,
        work_item_id: input.item.id,
        attempt_id: input.artifact.attempt_id,
        artifact_id: input.artifact.id,
      })
      const deterministicConflicts = criteria
        .filter((criterion) => criterion.verification_kind === "deterministic")
        .flatMap((criterion) => {
          const state = coverage.criteria.find((candidate) => candidate.criterion_id === criterion.id)?.state
          const verdict = results.find((candidate) => candidate.criterion_id === criterion.id)?.verdict
          return state === "passed" || state === "failed"
            ? verdict === state
              ? []
              : [criterion.id]
            : [criterion.id]
        })
      if (deterministicConflicts.length)
        throw new Error(
          `Reviewer deterministic verdict conflicts with current evaluator facts: ${deterministicConflicts.join(", ")}`,
        )
      const accepted = criteria.every((criterion) => {
        if (criterion.verification_kind !== "deterministic")
          return results.find((candidate) => candidate.criterion_id === criterion.id)?.verdict === "passed"
        return coverage.criteria.find((candidate) => candidate.criterion_id === criterion.id)?.state === "passed"
      })
      if (accepted !== input.result.accepted)
        throw new Error(`Reviewer aggregate verdict does not match criterion results for ${input.item.id}`)
      return yield* Effect.forEach(
        criteria.filter((criterion) => criterion.verification_kind === "semantic_review"),
        (criterion) => {
          const result = results.find((candidate) => candidate.criterion_id === criterion.id)!
          return acceptanceFacts.record({
            project_id: input.item.project_id,
            work_item_id: input.item.id,
            attempt_id: input.artifact.attempt_id!,
            artifact_id: input.artifact.id,
            criterion_id: criterion.id,
            verdict: result.verdict,
            authority: "independent_reviewer",
            evaluator: "independent_review_v2",
            observation: { summary: result.summary, tool_event_ids: input.tool_event_ids },
            evidence_refs: [
              { kind: "artifact", id: input.artifact.id },
              { kind: "artifact", id: input.review_artifact.id },
              { kind: "agent_run", id: input.agent_run_id },
            ],
            idempotency_key: `review:${input.artifact.id}:${input.review_artifact.id}:${criterion.id}`,
          })
        },
        { concurrency: 1 },
      )
    })

    const recordReviewerContractFact = Effect.fn("CompanyProjectExecution.recordReviewerContractFact")(function* (
      input: {
        item: WorkItem
        artifact: Artifact
        target_artifact: Artifact
        agent_run_id: string
        tool_event_ids: string[]
        result: z.infer<typeof reviewResult>
      },
    ) {
      if (input.item.validation_contract_version !== 2) return
      if (!input.artifact.attempt_id || !input.artifact.integrity_sha256)
        throw new Error(`Review Artifact ${input.artifact.id} has no current Attempt lineage`)
      const criteria = yield* acceptanceFacts.listCriteria(input.item.id)
      if (criteria.length !== 1 || criteria[0]?.evaluator !== "review_contract_v2")
        throw new Error(`Reviewer ${input.item.id} has an invalid acceptance contract`)
      yield* acceptanceFacts.record({
        project_id: input.item.project_id,
        work_item_id: input.item.id,
        attempt_id: input.artifact.attempt_id,
        artifact_id: input.artifact.id,
        criterion_id: criteria[0].id,
        verdict: "passed",
        authority: "control_plane",
        evaluator: "review_contract_v2",
        observation: {
          accepted: input.result.accepted,
          target_artifact_id: input.target_artifact.id,
          criterion_result_count: input.result.criterion_results?.length ?? 0,
          tool_event_ids: input.tool_event_ids,
        },
        evidence_refs: [
          { kind: "artifact", id: input.artifact.id },
          { kind: "artifact", id: input.target_artifact.id },
          { kind: "agent_run", id: input.agent_run_id },
        ],
        idempotency_key: `review-contract:${input.artifact.id}:${criteria[0].id}`,
      })
    })

    const reviewerRunEvidence = Effect.fn("CompanyProjectExecution.reviewerRunEvidence")(function* (input: {
      project: Project
      item: WorkItem
      target_artifact: Artifact
      workflow_run_id: string
      criteria: AcceptanceCriterion[]
    }) {
      if (input.item.validation_contract_version !== 2) return
      if (!input.target_artifact.path)
        throw new Error(`Reviewer validation requires a materialized target Artifact for ${input.item.id}`)
      const artifactPath = path.resolve(input.target_artifact.path)
      const relativeArtifactPath = path.relative(input.project.output_dir, artifactPath)
      if (!relativeArtifactPath || relativeArtifactPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeArtifactPath))
        throw new Error(`Reviewer target Artifact ${input.target_artifact.id} is outside the project workspace`)
      const requiresMechanical = input.criteria.some(
        (criterion) => criterion.verification_kind === "deterministic",
      )
      const candidates = (yield* agentRuns.list({
        workflowRunID: input.workflow_run_id,
        companyProjectID: input.project.id,
      })).filter(
        (run) =>
          run.state === "completed" &&
          run.workflowRunID === input.workflow_run_id &&
          run.companyProjectID === input.project.id &&
          run.workItemID === input.item.id,
      )
      const inspected = yield* Effect.forEach(candidates, (run) =>
        Effect.map(agentRuns.events(run.id), (events) => {
          const starts = new Map(
            events.flatMap((event) => {
              if (event.type !== "runtime.tool") return []
              const payload = reviewerToolEvent.safeParse(JSON.parse(event.payloadJSON))
              return payload.success && payload.data.args !== undefined
                ? [[payload.data.toolCallID, { event, payload: payload.data }] as const]
                : []
            }),
          )
          const proofs = events.flatMap((event) => {
            if (event.type !== "runtime.tool") return []
            const parsed = reviewerToolEvent.safeParse(JSON.parse(event.payloadJSON))
            if (!parsed.success || parsed.data.args !== undefined || parsed.data.isError === true) return []
            const start = starts.get(parsed.data.toolCallID)
            if (!start || start.payload.toolName !== parsed.data.toolName) return []
            const result = JSON.stringify(parsed.data.result ?? "")
            if (!result.replace(/[\s\[\]{}\"']/g, "")) return []
            const readArgs = z.object({ path: z.string() }).safeParse(start.payload.args)
            const exactRead =
              start.payload.toolName === "read" &&
              readArgs.success &&
              path.resolve(input.project.output_dir, readArgs.data.path) === artifactPath
            const grepArgs = z
              .object({ query: z.string().min(1), pattern: z.string().optional() })
              .safeParse(start.payload.args)
            const exactGrep =
              start.payload.toolName === "grep" &&
              grepArgs.success &&
              result.includes(`${relativeArtifactPath}:`)
            const bashArgs = z
              .object({ command: z.string(), args: z.array(z.string()).default([]) })
              .safeParse(start.payload.args)
            const bashTokens = bashArgs.success
              ? bashArgs.data.command
                  .trim()
                  .split(/\s*(?:&&|\|\||;|\n)\s*/)
                  .flatMap((command) => command.trim().split(/\s+/))
              : []
            const bashCommand = path.basename(bashTokens[0] ?? "")
            const normalizedBashArgs = bashArgs?.success
              ? bashArgs.data.args.length
                ? bashArgs.data.args
                : bashTokens.slice(1)
              : []
            const mechanical = start.payload.toolName === "bash" && mechanicalReviewerTools.has(bashCommand)
            const mechanicalPaths = (
              bashCommand === "jq"
                ? normalizedBashArgs.filter((arg) => !arg.startsWith("-")).slice(1)
                : bashCommand === "shasum"
                  ? normalizedBashArgs.filter(
                      (arg, index, values) =>
                        !arg.startsWith("-") && !["-a", "--algorithm"].includes(values[index - 1] ?? ""),
                    )
                  : normalizedBashArgs.filter((arg) => !arg.startsWith("-"))
            ).filter((candidate) => !["&&", "||", ";", "|"].includes(candidate))
            const resolvedMechanicalPaths = mechanicalPaths.map((candidate) =>
              path.resolve(input.project.output_dir, candidate),
            )
            const mechanicalRead =
              mechanical &&
              result.includes("exit code: 0") &&
              resolvedMechanicalPaths.includes(artifactPath) &&
              (!["sha256sum", "shasum"].includes(bashCommand) ||
                (input.target_artifact.materialized_sha256 &&
                  result.includes(input.target_artifact.materialized_sha256))) &&
              (!["cmp", "diff"].includes(bashCommand) || new Set(resolvedMechanicalPaths).size > 1)
            const commandReads = bashArgs.success
              ? bashArgs.data.command
                  .trim()
                  .split(/\s*(?:&&|\|\||;|\n)\s*/)
                  .some((command) => {
                    const tokens = command.trim().split(/\s+/)
                    const executable = path.basename(tokens[0] ?? "")
                    if (!["cat", "sed", "head", "tail", "grep", "rg", "jq"].includes(executable)) return false
                    return tokens
                      .slice(1)
                      .filter((candidate) => !candidate.startsWith("-"))
                      .some((candidate) => path.resolve(input.project.output_dir, candidate) === artifactPath)
                  })
              : false
            const bashContentRead =
              start.payload.toolName === "bash" && result.includes("exit code: 0") && commandReads
            if (!exactRead && !exactGrep && !mechanicalRead && !bashContentRead) return []
            return [
              {
                event_ids: [start.event.id, event.id],
                content: exactRead || exactGrep || bashContentRead,
                mechanical: exactGrep || mechanicalRead,
              },
            ]
          })
          const read = proofs.find((proof) => proof.content)
          const mechanical = proofs.find((proof) => proof.mechanical)
          if (!read || (requiresMechanical && !mechanical)) return
          return {
            agent_run_id: run.id,
            tool_event_ids: [...read.event_ids, ...(mechanical?.event_ids ?? [])],
          }
        }),
      )
      const proof = inspected.find((candidate) => candidate !== undefined)
      if (proof) return proof
      if (!candidates.length)
        throw new Error(`Reviewer validation requires an AgentRun bound to current workflow ${input.workflow_run_id}`)
      if (requiresMechanical)
        throw new Error(
          `Reviewer validation requires a successful mechanical tool check of Artifact ${input.target_artifact.id}`,
        )
      throw new Error(`Reviewer validation requires a successful content read of Artifact ${input.target_artifact.id}`)
    })

    const persistVerificationEvidence = Effect.fn(
      "CompanyProjectExecution.persistVerificationEvidence",
    )(function* (
      input: {
        item: WorkItem
        artifact: Artifact
        verification: VerifyResult
        worktree?: WorktreeRun
      },
    ) {
      if (!input.verification.passed)
        throw new Error(`Work item ${input.item.id} did not pass its Work Type verifier`)
      if (
        input.item.work_type === "coding" &&
        (!input.worktree ||
          input.worktree.status !== "awaiting_merge_approval" ||
          input.worktree.verification.passed !== true)
      )
        throw new Error(`Coding work item ${input.item.id} did not pass sandbox verification`)
      if (!input.artifact.content)
        throw new Error(`Delivery artifact ${input.artifact.id} has no persisted bytes`)
      const existing = (yield* projects.listArtifacts(input.item.project_id)).find(
        (candidate) =>
          candidate.work_item_id === input.item.id &&
          candidate.kind === "system_verification" &&
          candidate.evidence.delivery_artifact_id === input.artifact.id,
      )
      if (existing) {
        yield* recordDeterministicAcceptanceFacts({
          item: input.item,
          artifact: input.artifact,
          verification_artifact: existing,
        })
        return existing
      }
      const delivery_artifact_sha256 = new Bun.CryptoHasher("sha256")
        .update(input.artifact.content)
        .digest("hex")
      const materialized_file = z
        .object({
          path: z.string(),
          media_type: z.string(),
          byte_length: z.number().int().positive(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .safeParse(input.artifact.evidence.host_materialized_file)
      const evidence = {
        authority: "control_plane",
        phase: "pre_review",
        materialized: true,
        acceptance_state: input.item.validation_contract_version === 2 ? "pending" : "legacy_accepted",
        ...(input.item.validation_contract_version === 1 ? { accepted: true } : {}),
        work_item_id: input.item.id,
        validation_mode: input.item.validation_mode,
        delivery_artifact_id: input.artifact.id,
        delivery_artifact_sha256,
        verifier: {
          work_type: input.item.work_type,
          result: input.verification,
        },
        ...(materialized_file.success ? { materialized_file: materialized_file.data } : {}),
        ...(input.worktree
          ? {
              sandbox: {
                worktree_run_id: input.worktree.id,
                head_commit: input.worktree.head_commit,
                verification_commands: input.worktree.verification_commands,
                result: input.worktree.verification,
              },
            }
          : {}),
      }
      const artifact = yield* projects.addArtifact({
        project_id: input.item.project_id,
        work_item_id: input.item.id,
        kind: "system_verification",
        title: `${input.item.title} · 系统核验`,
        path: `artifacts/verification/${input.item.id}-attempt-${input.item.attempt + 1}.json`,
        content: `${JSON.stringify(evidence, null, 2)}\n`,
        evidence: {
          authority: evidence.authority,
          phase: evidence.phase,
          materialized: evidence.materialized,
          acceptance_state: evidence.acceptance_state,
          ...(input.item.validation_contract_version === 1 ? { accepted: true } : {}),
          delivery_artifact_id: evidence.delivery_artifact_id,
          delivery_artifact_sha256,
          ...(materialized_file.success ? { materialized_file: materialized_file.data } : {}),
        },
      })
      yield* recordDeterministicAcceptanceFacts({
        item: input.item,
        artifact: input.artifact,
        verification_artifact: artifact,
      })
      return artifact
    })

    const persistSystemVerification = Effect.fn("CompanyProjectExecution.persistSystemVerification")(function* (
      input: {
        item: WorkItem
        artifact: Artifact
        verification: VerifyResult
        worktree?: WorktreeRun
      },
    ) {
      if (!["self_check", "machine"].includes(input.item.validation_mode))
        throw new Error(`Work item ${input.item.id} requires independent validation`)
      if (input.item.review_status !== "not_required")
        throw new Error(`Work item ${input.item.id} cannot use system verification while review is required`)
      if (
        (yield* projects.listWorkItems(input.item.project_id)).some(
          (candidate) =>
            candidate.kind === "reviewer" &&
            reviewedWorkItemID(candidate) === input.item.id &&
            !["superseded", "cancelled"].includes(candidate.status),
        )
      )
        throw new Error(`Work item ${input.item.id} has an independent Reviewer`)
      const artifact = yield* persistVerificationEvidence(input)
      if (input.item.validation_contract_version === 2) return artifact
      const criteria = input.item.acceptance_criteria.filter(
        (criterion) =>
          criterion !== "artifact_exists" && !/^artifact_sha256:[a-f0-9]{64}$/i.test(criterion),
      )
      if (!criteria.length) return artifact
      const gate = yield* validation.create({
        id: `system-verification-${new Bun.CryptoHasher("sha256")
          .update(`${input.item.id}:${input.item.attempt + 1}:${artifact.id}`)
          .digest("hex")
          .slice(0, 40)}`,
        project_id: input.item.project_id,
        work_item_id: input.item.id,
        kind: "policy",
        criteria: criteria.map((criterion, index) => ({
          id: `system-verified-${index + 1}-${new Bun.CryptoHasher("sha256")
            .update(criterion)
            .digest("hex")
            .slice(0, 24)}`,
          statement: criterion,
          anchor: { kind: "policy", reference: `artifact:${artifact.id}` },
          operator: "equals",
          expected: true,
        })),
        blocking_work_item_ids: [input.item.id],
        evaluator: "policy_invariant_v1",
        max_repair_rounds: 3,
      })
      if (gate.status !== "passed")
        throw new Error(`System verification Gate ${gate.id} did not pass for ${input.item.id}`)
      return artifact
    })

    const taskAssignmentContext = Effect.fn("CompanyProjectExecution.taskAssignmentContext")(function* (
      project: Project,
      item: WorkItem,
    ) {
      const events = yield* projects.listEvents(project.id)
      const contextItem =
        item.kind === "reviewer"
          ? (yield* projects.listWorkItems(project.id)).find((candidate) => candidate.id === reviewedWorkItemID(item)) ??
            item
          : item
      if (!project.company_id)
        return {
          current_work_item: { id: item.id, owner_agent_id: item.owner_agent_id },
          reviewed_work_item:
            contextItem.id === item.id ? undefined : { id: contextItem.id, owner_agent_id: contextItem.owner_agent_id },
          work_item_reassignments: events.filter(
            (event) => event.type === "work_item.reassigned" && event.data.work_item_id === contextItem.id,
          ),
        }
      const organization = yield* recruitment.snapshot({ company_id: CompanyID.parse(project.company_id) })
      const currentNeeds = organization.needs.filter(
        (need) =>
          need.project_id === project.id && (need.work_item_id === item.id || need.work_item_id === contextItem.id),
      )
      const currentNeedIDs = new Set(currentNeeds.map((need) => need.id))
      const currentSelections = organization.selections.filter(
        (selection) => currentNeedIDs.has(selection.capability_need_id) && selection.decision === "selected",
      )
      const selectedAgentIDs = new Set([
        ...currentSelections.map((selection) => selection.agent_id),
        ...(item.owner_agent_id ? [item.owner_agent_id] : []),
        ...(contextItem.owner_agent_id ? [contextItem.owner_agent_id] : []),
      ])
      const selectedAgentHistory = organization.selections
        .filter(
          (selection) =>
            selection.project_id !== project.id &&
            selection.decision === "selected" &&
            selectedAgentIDs.has(selection.agent_id),
        )
        .toSorted((left, right) => right.time_updated - left.time_updated)
        .slice(0, 8)
      const historyNeedIDs = new Set(selectedAgentHistory.map((selection) => selection.capability_need_id))
      const relatedSelectionIDs = new Set(
        [...currentSelections, ...selectedAgentHistory].map((selection) => selection.id),
      )
      const boardCloseoutEvidence =
        contextItem.source_task_key === "board_closeout_and_organization_decision" && project.source_thread_id
          ? yield* Effect.gen(function* () {
              const companyID = CompanyID.parse(project.company_id!)
              const threadID = ConversationThreadID.parse(project.source_thread_id!)
              const principal = { kind: "agent" as const, id: project.owner_agent_id ?? "board-ceo" }
              yield* conversation.ensureThreadAccess({ companyID, threadID, principal })
              return (yield* conversation.pageEntries({ companyID, threadID, principal, limit: 100 })).items
                .flatMap((entry) =>
                  entry.type === "message" &&
                  entry.message.body.includes("项目最终收口决策") &&
                  entry.message.body.includes(project.id)
                    ? [
                        {
                          id: entry.message.id,
                          author: entry.message.author,
                          body: entry.message.body.slice(0, 4_000),
                          signal_type: entry.message.signalType,
                        },
                      ]
                    : [],
                )
                .slice(-8)
            }).pipe(Effect.catchCause(() => Effect.succeed([])))
          : []
      return {
        current_work_item: { id: item.id, owner_agent_id: item.owner_agent_id },
        reviewed_work_item:
          contextItem.id === item.id ? undefined : { id: contextItem.id, owner_agent_id: contextItem.owner_agent_id },
        board_closeout_evidence: boardCloseoutEvidence,
        work_item_reassignments: events
          .filter((event) => event.type === "work_item.reassigned" && event.data.work_item_id === contextItem.id)
          .map((event) => ({ id: event.id, actor_id: event.actor_id ?? null, data: event.data })),
        current_needs: currentNeeds.map((need) => ({
          id: need.id,
          project_id: need.project_id,
          work_item_id: need.work_item_id,
          need_key: need.need_key,
          role: need.role,
          work_type: need.work_type,
          capability_packs: need.capability_packs,
          risk_level: need.risk_level,
        })),
        current_selections: currentSelections.map((selection) => ({
          id: selection.id,
          project_id: selection.project_id,
          capability_need_id: selection.capability_need_id,
          agent_id: selection.agent_id,
          source: selection.source,
          reason: selection.reason,
          execution_assignment_released: Boolean(selection.time_released),
        })),
        selected_agents: organization.candidate_pool
          .filter((agent) => selectedAgentIDs.has(agent.id))
          .map((agent) => ({
            id: agent.id,
            name: agent.name,
            lifecycle: agent.lifecycle,
            role_key: agent.role_key,
            description: agent.description,
          })),
        selected_agent_history: selectedAgentHistory.map((selection) => ({
          id: selection.id,
          project_id: selection.project_id,
          capability_need_id: selection.capability_need_id,
          agent_id: selection.agent_id,
          source: selection.source,
          reason: selection.reason,
          execution_assignment_released: Boolean(selection.time_released),
        })),
        history_needs: organization.needs
          .filter((need) => historyNeedIDs.has(need.id))
          .map((need) => ({
            id: need.id,
            project_id: need.project_id,
            need_key: need.need_key,
            role: need.role,
            work_type: need.work_type,
            capability_packs: need.capability_packs,
            risk_level: need.risk_level,
          })),
        related_performances: organization.performances.filter(
          (performance) =>
            selectedAgentIDs.has(performance.agent_id) && relatedSelectionIDs.has(performance.selection_id),
        ).map((performance) => ({
          id: performance.id,
          project_id: performance.project_id,
          selection_id: performance.selection_id,
          agent_id: performance.agent_id,
          outcome: performance.outcome,
          quality_score: performance.quality_score,
          reliability_score: performance.reliability_score,
          review_summary: performance.review_summary,
        })),
      }
    })

    const recordBoardCloseout = Effect.fn("CompanyProjectExecution.recordBoardCloseout")(function* (input: {
      project: Project
      item: WorkItem
      artifact: Artifact
      summary: string
    }) {
      const body = [
        "项目最终收口决策",
        `Project ID：${input.project.id}`,
        `Work Item ID：${input.item.id}`,
        `Artifact ID：${input.artifact.id}`,
        `Summary：${input.summary}`,
        "受控决策内容（完整 Artifact）：",
        input.artifact.content!,
      ].join("\n")
      if (body.length > 20_000)
        throw new Error(`Board closeout record for artifact ${input.artifact.id} exceeds the 20000 character limit`)
      const requestID = stableBoardCloseoutRequestID(input.project.id, input.item.id, input.artifact.id)
      const existing = (yield* projects.listEvents(input.project.id)).find(
        (event) => event.type === "board_closeout.recorded" && event.data.artifact_id === input.artifact.id,
      )
      if (existing) return
      // TEAM-05：DRI 不强制为 Board 成员；签署前按需授予其源 Thread 成员资格。
      yield* conversation.ensureThreadAccess({
        companyID: CompanyID.parse(input.project.company_id!),
        threadID: ConversationThreadID.parse(input.project.source_thread_id!),
        principal: { kind: "agent", id: input.project.owner_agent_id! },
      })
      const message = yield* conversation.recordBoardDecision({
        companyID: CompanyID.parse(input.project.company_id!),
        threadID: ConversationThreadID.parse(input.project.source_thread_id!),
        principal: { kind: "agent", id: input.project.owner_agent_id! },
        requestID,
        projectScopeID: input.project.id,
        driAgentID: input.project.owner_agent_id!,
        body,
        ledger: {
          subject: "项目最终收口决策",
          context: input.summary,
          riskLevel: input.item.risk_level,
          evidenceRefs: [{ kind: "artifact", id: input.artifact.id }],
        },
      })
      yield* projects.recordEvent({
        project_id: input.project.id,
        type: "board_closeout.recorded",
        actor_id: input.project.owner_agent_id,
        data: {
          work_item_id: input.item.id,
          artifact_id: input.artifact.id,
          channel_message_id: message.id,
          source_thread_id: input.project.source_thread_id,
          request_id: requestID,
        },
      })
    })

    const staffWorkItem = Effect.fn("CompanyProjectExecution.staffWorkItem")(function* (input: {
      project: Project
      item: WorkItem
      key: string
      need_key: string
      exclude?: string[]
    }) {
      const assignments = yield* recruitment.listAssignments({
        project_id: input.project.id,
        work_item_id: input.item.id,
      })
      const previous = assignments.at(-1)
      if (
        input.item.owner_agent_id &&
        previous &&
        (previous.status !== "released" || ["completed", "rejected"].includes(input.project.status))
      ) {
        if (previous.agent_id !== input.item.owner_agent_id)
          throw new Error(`Work item ${input.item.id} owner differs from its latest Assignment`)
        return input.item
      }
      const need = yield* recruitment.createNeed({
        ...(input.project.company_id ? { company_id: CompanyID.parse(input.project.company_id) } : {}),
        project_id: input.project.id,
        work_item_id: input.item.id,
        ...(input.item.origin_kind === "receipt" && input.item.origin_ref_id
          ? { source_receipt_id: input.item.origin_ref_id }
          : {}),
        need_key: input.need_key,
        role: input.item.role,
        work_type: input.item.work_type,
        capability_packs: input.item.capability_packs,
        risk_level: input.item.risk_level,
        demand_horizon: "project",
        ...assignmentConstraints(input.item.capability_packs),
        workspace_scopes: input.item.resource_scope.length ? input.item.resource_scope : [input.project.output_dir],
        independent_from_agent_ids: input.exclude ?? [],
      })
      const result = yield* recruitment.selectAndAssign({
        capability_need_id: need.id,
        exclude_agent_ids: input.exclude ?? [],
      })
      const selected = result.selections.find((selection) => selection.id === result.assignment.selection_id)
      yield* projects.recordEvent({
        project_id: input.project.id,
        type: "work_item.agent_selected",
        actor_id: result.agent.id,
        data: {
          key: input.key,
          role: input.item.role,
          score: selected?.score.total ?? 0,
          source: selected?.source ?? "company_pool",
          capability_need_id: need.id,
          selection_id: result.assignment.selection_id,
          assignment_id: result.assignment.id,
          rejected_count: result.selections.filter((selection) => selection.decision === "rejected").length,
        },
      })
      const item = (yield* projects.listWorkItems(input.project.id)).find((item) => item.id === input.item.id)
      if (!item?.owner_agent_id || item.owner_agent_id !== result.agent.id)
        throw new Error(`Assignment did not update work item ${input.item.id} owner`)
      yield* publishProjectUpdate({
        project: input.project,
        request_id: `agent-selected:${result.assignment.id}`,
        actor_id: result.agent.id,
        signal_type: "plan",
        body: [
          `已安排：${result.agent.name}`,
          `负责：${item.title}`,
          `角色：${item.role}`,
          `选择依据：${selected?.reason ?? "能力与当前任务匹配"}`,
        ].join("\n"),
      })
      return item
    })

    const blockProject = (project_id: string, error: string, requestAttention = true) =>
      Effect.gen(function* () {
        const project = yield* projects.get(project_id)
        if (project && !["completed", "rejected", "blocked"].includes(project.status)) {
          yield* projects.transition({ id: project_id, status: "blocked", actor_id: "system", reason: error })
          if (requestAttention)
            yield* attention.create({
              project_id,
              idempotency_key: `project-blocked:${project_id}:${project.updated_at}`,
              issue: {
                issue_kind: "unresolved_material_risk",
                risk: "high",
                materiality: "unresolved_risk",
              },
              title: "项目执行受阻",
              summary: safeExecutionFailure(error),
              required_decision: "确认恢复方式，或调整目标后继续。",
              source_refs: [{ kind: "project", id: project_id }],
            })
        }
        yield* projects.setActiveRun({ id: project_id })
      })

    const startRuntime = Effect.fn("CompanyProjectExecution.startRuntime")(function* (input: {
      project: Project
      item: WorkItem
      script: string
      workspace?: string
      permission_mode: "read_only" | "workspace_write" | "full_access"
      context_budget?: TaskContextBudget
    }) {
      if (!input.project.coordinator_session_id) throw new Error("Project has no coordinator session")
      const assignment = (yield* recruitment.listAssignments({
        project_id: input.project.id,
        work_item_id: input.item.id,
      })).findLast((candidate) => candidate.status === "assigned" || candidate.status === "active")
      if (input.project.execution_strategy === "seed_and_grow" && !assignment)
        throw new Error(`Work item ${input.item.id} has no current ProjectAssignment`)
      if (
        assignment &&
        (assignment.agent_id !== input.item.owner_agent_id ||
          JSON.stringify(assignment.resource_scope) !== JSON.stringify(input.item.resource_scope))
      )
        throw new Error(`Work item ${input.item.id} exceeds its ProjectAssignment scope`)
      if (assignment && permissionRank[input.permission_mode] > permissionRank[assignment.permission_mode])
        throw new Error(`Work item ${input.item.id} exceeds its ProjectAssignment permission`)
      const workspace = path.resolve(input.workspace ?? input.project.output_dir)
      const output = path.resolve(input.project.output_dir)
      if (workspace !== output && !workspace.startsWith(`${output}${path.sep}`))
        throw new Error(`Work item ${input.item.id} workspace exceeds its project boundary`)
      assertTaskPromptBudget({ prompt: input.script, budget: input.context_budget ?? defaultTaskContextBudget() })
      const claim = yield* projects.claimWorkItemForDispatch(input.item.id)
      if (!claim) return
      return yield* withProjectDispatchLock(
        input.project.id,
        Effect.gen(function* () {
          yield* projects.validateDispatchClaim({
            id: input.item.id,
            claim_id: claim.claim_id,
            generation: claim.generation,
            workflow_run_id: claim.workflow_run_id,
          })
          const started = yield* runtime
            .start({
              runID: claim.workflow_run_id,
              script: input.script,
              sessionID: SessionID.make(input.project.coordinator_session_id!),
              parentActorID: "main",
              model: model(input.project),
              workspace,
              companyProjectID: input.project.id,
              workItemID: input.item.id,
              maxConcurrentAgents: 1,
              maxLifecycleAgents: 1,
              agentTimeoutMs: 2 * 60 * 60_000,
              scriptDeadlineMs: 3 * 60 * 60_000,
              notifyOnTerminal: false,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  const error = Cause.squash(cause)
                  const overflow = contextOverflowDiagnostic({
                    error,
                    provider_id: input.project.provider_id
                      ? ProviderID.make(input.project.provider_id)
                      : undefined,
                  })
                  yield* runtime.cancel({ runID: claim.workflow_run_id }).pipe(
                    Effect.catchCause(() => Effect.succeed(undefined)),
                  )
                  yield* projects.abortDispatchClaim({
                    id: input.item.id,
                    claim_id: claim.claim_id,
                    generation: claim.generation,
                    reason: overflow?.message ?? String(error),
                  })
                  return yield* Effect.failCause(cause)
                }),
              ),
            )
          yield* projects
            .bindDispatchClaimRun({
              id: input.item.id,
              claim_id: claim.claim_id,
              generation: claim.generation,
              workflow_run_id: started.runID,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  yield* runtime.cancel({ runID: started.runID }).pipe(
                    Effect.catchCause(() => Effect.succeed(undefined)),
                  )
                  yield* projects.abortDispatchClaim({
                    id: input.item.id,
                    claim_id: claim.claim_id,
                    generation: claim.generation,
                    reason: String(Cause.squash(cause)),
                  })
                  return yield* Effect.failCause(cause)
                }),
              ),
            )
          yield* projects.setActiveRun({ id: input.project.id, run_id: started.runID })
          return started.runID
        }),
      )
    })

    const failure = Effect.fn("CompanyProjectExecution.failure")(function* (
      item: WorkItem,
      error: string,
      scheduleRetry = true,
    ) {
      const attempt = item.attempt + 1
      const policy = executionFailurePolicy(error)
      const retryable = scheduleRetry && policy.retry_same_input && attempt < item.max_attempts
      const safeError = safeExecutionFailure(error)
      yield* projects.addArtifact({
        project_id: item.project_id,
        work_item_id: item.id,
        kind: "attempt_failure",
        title: `${item.title} · Attempt ${attempt} 失败`,
        content:
          JSON.stringify(
            {
              attempt,
              error: safeError,
              impact: "当前 Work Item 未通过执行或验证，正式交付状态未推进。",
              retryable,
              next_adjustment: retryable
                ? "保留本次证据并按剩余重试预算调整下一次执行。"
                : policy.retry_same_input
                  ? "升级到项目 DRI。"
                  : "先修复上下文、权限或工具能力，再由恢复流程创建新 Attempt。",
            },
            null,
            2,
          ) + "\n",
        evidence: { error: safeError, attempt, retryable, failure_kind: policy.failure_kind },
        created_by_agent_id: item.owner_agent_id,
      })
      const current = yield* projects.blockWorkItem({
        id: item.id,
        error: safeError,
        failure_kind: policy.failure_kind,
      })
      yield* reputation.updateFromAdmission(
        item.owner_agent_id ?? item.role,
        false,
        [{ severity: "blocker" }],
        "project",
      )
      if (retryable) {
        yield* projects.retryWorkItem(current.id)
        yield* projects.recordEvent({
          project_id: item.project_id,
          type: "work_item.retry_scheduled",
          actor_id: item.owner_agent_id,
          data: { work_item_id: item.id, attempt: current.attempt + 1, reason: safeError },
        })
      }
      const project = yield* projects.get(item.project_id)
      if (project)
        yield* publishProjectUpdate({
          project,
          request_id: `work-item-failure:${item.id}:${attempt}`,
          actor_id: item.owner_agent_id,
          signal_type: "risk",
          body: [
            `任务未通过：${item.title}`,
            `原因：${safeError}`,
            retryable
              ? `将进入第 ${attempt + 1} 次尝试。`
              : policy.retry_same_input
                ? "重试次数已用尽，需要负责人处理。"
                : "同内容自动重试已停止，需要先修复执行条件。",
          ].join("\n"),
        })
      return current
    })

    const outcome = Effect.fn("CompanyProjectExecution.outcome")(function* (runID: string) {
      const result = yield* runtime.wait({ runID })
      if (result.status === "completed") return result.result
      if (result.status === "cancelled") throw new Error("Workflow cancelled")
      const transcript = yield* runtime.transcript({ runID })
      const details = transcript
        .filter((entry) => entry.kind === "log" && entry.text.startsWith("workflow.agent_failed: "))
        .map((entry) => entry.text.slice("workflow.agent_failed: ".length))
      throw new Error(details.length ? `${result.error}: ${[...new Set(details)].join("; ")}` : result.error)
    })

    const validateTasks = (tasks: SubTask[]) => {
      if (tasks.length < 1 || tasks.length > 6) throw new Error("Delegation must produce 1-6 tasks")
      if (tasks.filter((task) => inferWorkType(task) === "coding").length > 1)
        throw new Error("A project plan may contain at most one coding delivery unit")
      const keys = tasks.map((task, index) => task.key ?? `task-${index + 1}`)
      if (new Set(keys).size !== keys.length) throw new Error("Delegation task keys must be unique")
      tasks.forEach((task, index) => {
        const known = new Set(keys.slice(0, index))
        if (task.parentKey && !known.has(task.parentKey))
          throw new Error(`Unknown or forward parentKey: ${task.parentKey}`)
        for (const dependency of task.dependsOn ?? [])
          if (!known.has(dependency)) throw new Error(`Unknown or forward dependency: ${dependency}`)
      })
      return keys
    }

    const startSeedWave: (project_id: string) => Effect.Effect<string | undefined> = Effect.fn(
      "CompanyProjectExecution.startSeedWave",
    )(function* (project_id: string) {
      const project = yield* projects.get(project_id)
      if (
        !project ||
        project.execution_strategy !== "seed_and_grow" ||
        project.dispatch_paused ||
        ["completed", "rejected", "blocked", "awaiting_approval"].includes(project.status)
      )
        return
      const assignments = yield* recruitment.listAssignments({ project_id })
      const ready = (yield* projects.readyWorkItems(project_id))
        .filter((item) => item.kind === "worker" && Boolean(item.owner_agent_id))
        .filter((item) =>
          assignments.some(
            (assignment) =>
              assignment.work_item_id === item.id &&
              assignment.agent_id === item.owner_agent_id &&
              (assignment.status === "assigned" || assignment.status === "active"),
          ),
        )
      if (!ready.length) {
        const items = yield* projects.listWorkItems(project_id)
        if (items.some((item) => item.status === "blocked" || item.status === "failed")) {
          yield* blockProject(project_id, "Seed project has exhausted a work-item retry budget")
        }
        return
      }
      const charter = yield* projects.getCharter(project.id)
      if (!charter) throw new Error("Seed project Charter is missing")
      const gates = yield* projects.listGates(project.id)
      const gated = ready.filter(
        (item) =>
          (
            (item.work_type === "coding" && charter.policy.source_approval_preset === "strict")
            || requiresHighRiskApproval(item, charter.policy)
          ) &&
          !gates.some((gate) => riskApprovalCovers(gate, item)),
      )
      const dispatchable = ready.filter((item) => !gated.some((candidate) => candidate.id === item.id))
      if (project.status !== "executing")
        yield* projects.transition({
          id: project.id,
          status: "executing",
          actor_id: project.owner_agent_id ?? "system",
        })
      const verdict = yield* seedVerdict(project)
      const context = yield* Effect.all({
        work_items: projects.listWorkItems(project.id),
        artifacts: projects.listArtifacts(project.id),
        attempts: projects.listWorkAttempts(project.id),
        receipts: projects.listWorkReceipts(project.id),
        acceptance_facts: acceptanceFacts.listFacts({ project_id: project.id }),
      })
      const started = yield* Effect.forEach(
        dispatchable,
        (item) =>
          Effect.gen(function* () {
            const budget = yield* contextBudget(project, agentModelRef(project, item.model_group))
            const evidence = taskEvidenceSnapshot({
              project,
              item,
              gates,
              assignment_context: yield* taskAssignmentContext(project, item),
              budget,
              ...context,
            }).evidence
            const assignment = assignments.find(
              (candidate) =>
                candidate.work_item_id === item.id &&
                candidate.agent_id === item.owner_agent_id &&
                (candidate.status === "assigned" || candidate.status === "active"),
            )
            if (!assignment) throw new Error(`Work item ${item.id} has no current ProjectAssignment`)
            const worktree =
              item.work_type === "coding"
                ? yield* projects.createWorktreeRun({ project_id: project.id, work_item_id: item.id })
                : undefined
            if (worktree) yield* projects.startWorktreeRun({ id: worktree.id })
            const runID = yield* startRuntime({
                project,
                item,
                script:
                  item.purpose === "discovery"
                    ? wayfinderWorkflow({
                        project,
                        item,
                        verdict,
                        model: agentModelRef(project, item.model_group),
                      })
                    : workerScript(
                        project.goal,
                        project.created_at,
                        item,
                        agentModelRef(project, item.model_group),
                        charter.policy,
                        gates.some((gate) => riskApprovalCovers(gate, item)),
                        assignment.permission_mode,
                        evidence,
                      ),
                workspace: worktree?.directory,
                permission_mode:
                  item.purpose === "discovery"
                    ? "read_only"
                    : workerPermission(
                        item,
                        charter.policy,
                        gates.some((gate) => riskApprovalCovers(gate, item)),
                        assignment.permission_mode,
                      ),
                context_budget: budget,
              })
            return runID ? { item, runID, worktree } : undefined
          }).pipe(Effect.exit),
        { concurrency: 4 },
      )
      yield* Effect.forEach(
        gated.filter(
          (item) =>
            !gates.some(
              (gate) =>
                gate.kind === "risk_approval" &&
                gate.status === "pending" &&
                gate.work_item_id === item.id &&
                JSON.stringify(gate.resource_scope) === JSON.stringify(item.resource_scope),
            ),
        ),
        (item) =>
          projects.requestGate({
            project_id: project.id,
            kind: "risk_approval",
            title: item.risk_level === "high"
              ? `批准高风险 WorkItem ${item.id}`
              : `批准 ${item.purpose === "first_slice" ? "First Slice" : "Worker"} 写入项目工作区`,
            summary: item.risk_level === "high"
              ? `该动作风险等级为高；批准范围仅限 ${item.resource_scope.join("、")}。`
              : `仅允许 WorkItem ${item.id} 在资源范围 ${item.resource_scope.join("、")} 内写入并运行验证。`,
            requested_by_agent_id: project.owner_agent_id,
            work_item_id: item.id,
            resource_scope: item.resource_scope,
          }),
        { concurrency: 1 },
      )
      const activeStarted = started.flatMap((entry) =>
        Exit.isSuccess(entry) && entry.value ? [entry.value] : [],
      )
      const startFailures = started.filter(Exit.isFailure)
      if (activeStarted.length)
        yield* Effect.gen(function* () {
        yield* Effect.forEach(
          activeStarted,
          ({ item, runID, worktree }) =>
            Effect.gen(function* () {
              const value = yield* outcome(runID)
              if (item.purpose === "discovery") {
                const parsed = WayfinderReceipt.parse(value)
                const artifact = yield* projects.addArtifact({
                  project_id: project.id,
                  work_item_id: item.id,
                  kind: "wayfinder_receipt",
                  title: item.title,
                  path: `artifacts/${item.id}-wayfinder.json`,
                  content: `${JSON.stringify(parsed, null, 2)}\n`,
                  evidence: {
                    confirmed_facts: parsed.confirmed_facts.length,
                    unknowns: parsed.unknowns.length,
                    blockers: parsed.blockers.length,
                  },
                  created_by_agent_id: item.owner_agent_id,
                })
                yield* validation.evaluateProjectPending(project.id)
                yield* projects.completeWorkItemWithReceipt({
                  id: item.id,
                  receipt: {
                    idempotency_key: `wayfinder:${item.id}:attempt:${item.attempt + 1}`,
                    outcome: "completed",
                    summary: parsed.summary,
                    artifact_ids: [artifact.id],
                    evidence_refs: [{ kind: "artifact", id: artifact.id }],
                    confirmed_facts: parsed.confirmed_facts,
                    invalidated_assumptions: parsed.invalidated_assumptions,
                    unknowns: parsed.unknowns,
                    blockers: parsed.blockers,
                    capability_gaps: parsed.capability_gaps,
                    task_proposals: [parsed.recommended_first_slice],
                    dependency_proposals: parsed.dependency_proposals,
                    questions: parsed.questions,
                  },
                })
                yield* reputation.updateFromAdmission(item.owner_agent_id ?? item.role, true, [], "project")
                return
              }
              const parsed = z.object({ summary: z.string(), submission: submissions[item.work_type] }).parse(value)
              const verification = combineVerification(
                yield* workType.verify(item.work_type as WorkTypeID, {
                  submission: parsed.submission,
                  orgLayer: "project",
                  researchMode: researchModeFor(item),
                }),
                acceptanceVerification(item, parsed.summary, parsed.submission),
              )
              const content = `${JSON.stringify(parsed, null, 2)}\n`
              const materializedFile =
                designArtifactFile(item, parsed.submission) ?? structuredArtifactFile(item, content)
              const artifact = yield* projects.addArtifact({
                project_id: project.id,
                work_item_id: item.id,
                kind: item.work_type,
                title: artifactTitle(item, parsed.submission),
                path: materializedFile.path,
                content,
                file_content: materializedFile.content,
                evidence: {
                  work_type_verification: verification,
                  content_sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
                  host_materialized_file: materializedFile.evidence,
                },
                created_by_agent_id: item.owner_agent_id,
              })
              if (!verification.passed) return yield* failure(item, verification.findings.join("; "))
              if (item.work_type !== "coding" || !worktree) {
                yield* persistSystemVerification({ item, artifact, verification })
                yield* completeValidatedWorkItem({ item, artifact, summary: parsed.summary })
                yield* reputation.updateFromAdmission(item.owner_agent_id ?? item.role, true, [], "project")
                return
              }
              const commands = submissions.coding.parse(parsed.submission).verificationCommands
              const verified = yield* projects.verifyWorktreeRun({ id: worktree.id, commands })
              if (verified.status !== "awaiting_merge_approval")
                return yield* failure(item, verified.error ?? "Host worktree verification failed")
              yield* persistSystemVerification({ item, artifact, verification, worktree: verified })
              const gate = yield* projects.requestMergeApproval({
                id: worktree.id,
                title: `批准合并 First Slice：${item.title}`,
                summary: `${parsed.summary}\n\nFirst Slice 已通过 Work Type 与宿主验证，未预建 Reviewer。`,
                requested_by_agent_id: item.owner_agent_id,
                review: { mode: "seed_first_slice", artifact_id: artifact.id },
              })
              yield* completeValidatedWorkItem({ item, artifact, summary: parsed.summary })
              yield* reputation.updateFromAdmission(item.owner_agent_id ?? item.role, true, [], "project")
              if (charter.policy.require_human_merge) return
              yield* projects.resolveGate({
                id: gate.id,
                decision: "approve",
                note: "公司自主权限策略自动批准 Seed First Slice",
              })
              const merged = yield* projects.mergeWorktreeRun(worktree.id)
              yield* projects.addArtifact({
                project_id: project.id,
                work_item_id: merged.work_item_id,
                kind: "merge_report",
                title: "Seed First Slice 合并与复验报告",
                path: `artifacts/${merged.id}-merge.json`,
                content: `${JSON.stringify(merged, null, 2)}\n`,
                evidence: merged.verification,
                created_by_agent_id: item.owner_agent_id,
              })
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  const state = yield* projects.get(project.id)
                  if (!state || ["completed", "rejected", "blocked"].includes(state.status)) return
                  const current = (yield* projects.listWorkItems(project.id)).find(
                    (candidate) => candidate.id === item.id,
                  )
                  if (current?.status === "running") {
                    yield* failure(item, String(cause))
                    return
                  }
                  yield* blockProject(project.id, String(cause))
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        )
        yield* Effect.forEach(
          (yield* projects.listWorkReceipts(project.id)).filter((receipt) =>
            ["pending", "processing"].includes(receipt.processing_status),
          ),
          (receipt) => receiptProcessor.processReceipt(receipt.id),
          { concurrency: 1, discard: true },
        )
        yield* projects.setActiveRun({ id: project.id })
        const current = yield* projects.get(project.id)
        if (current && !["awaiting_approval", "completed"].includes(current.status)) yield* startSeedWave(project.id)
        }).pipe(
          Effect.catchCause((cause) => blockProject(project.id, String(cause))),
          Effect.forkIn(scope),
        )
      if (!activeStarted.length && startFailures[0]) return yield* Effect.failCause(startFailures[0].cause)
      return activeStarted[0]?.runID
    })

    const obsoleteWorkItem = Effect.fn("CompanyProjectExecution.obsoleteWorkItem")(function* (item: WorkItem) {
      const current = (yield* projects.listWorkItems(item.project_id)).find((candidate) => candidate.id === item.id)
      if (!current || ["completed", "superseded", "cancelled"].includes(current.status)) return true
      if (!current.plan_id) return false
      const plan = (yield* projects.listPlans(item.project_id)).find((candidate) => candidate.id === current.plan_id)
      return !plan || plan.status !== "active"
    })

    const startReadyWave: (project_id: string) => Effect.Effect<string | undefined> = Effect.fn(
      "CompanyProjectExecution.startReadyWave",
    )(function* (project_id: string) {
      const project = yield* projects.get(project_id)
      if (project?.execution_strategy === "seed_and_grow") return yield* startSeedWave(project_id)
      if (!project || project.dispatch_paused) return
      yield* receiptProcessor.shadowLegacy(project_id).pipe(Effect.catchCause(() => Effect.succeed([])))
      if (["completed", "rejected", "blocked", "awaiting_approval"].includes(project.status)) return
      const ready = (yield* projects.readyWorkItems(project_id)).filter((item) => item.kind !== "planner")
      if (!ready.length) {
        const items = yield* projects.listWorkItems(project_id)
        const activePlan = (yield* projects.listPlans(project_id)).find((plan) => plan.status === "active")
        if (items.some((item) => item.status === "blocked" || item.status === "failed")) {
          yield* blockProject(project_id, "Project has exhausted a work-item retry budget")
          return
        }
        if (
          items.every(
            (item) => item.status === "completed" || item.status === "superseded" || item.status === "cancelled",
          )
        ) {
          const deliveryWorkItemIDs = new Set(
            items
              .filter(
                (item) =>
                  item.plan_id === activePlan?.id && item.kind === "worker" && item.status === "completed",
              )
              .map((item) => item.id),
          )
          const deliveryArtifacts = [
            ...new Map(
              (yield* projects.listArtifacts(project_id)).flatMap((artifact) =>
                artifact.work_item_id &&
                deliveryWorkItemIDs.has(artifact.work_item_id) &&
                !["attempt_failure", "independent_review", "system_verification"].includes(artifact.kind)
                  ? [[artifact.work_item_id, artifact] as const]
                  : [],
              ),
            ).values(),
          ].sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id))
          if (!deliveryArtifacts.length) throw new Error(`Company project ${project_id} has no delivery artifacts`)
          yield* recruitment.releaseProject({
            ...(project.company_id ? { company_id: CompanyID.parse(project.company_id) } : {}),
            project_id: project.id,
          })
          yield* projects.transition({
            id: project_id,
            status: "completed",
            actor_id: project.owner_agent_id ?? "system",
          })
          const deliveryEvents = yield* projects.listEvents(project_id)
          const latestReady = deliveryEvents.findLast((event) => event.type === "delivery.ready")
          const latestRevision = deliveryEvents.findLast((event) => event.type === "delivery.revision_requested")
          if (!latestReady || (latestRevision && latestRevision.created_at > latestReady.created_at)) {
            if (!activePlan) throw new Error(`Company project ${project_id} has no active Plan`)
            const brief = GoalBriefStore.projectView(project_id)
            if (!brief) throw new Error(`Company project ${project_id} has no Goal Brief`)
            const criterion_ids =
              brief.kind === "goal_brief" ? brief.brief.acceptanceCriteria.map((criterion) => criterion.id).sort() : []
            if (new Set(criterion_ids).size !== criterion_ids.length)
              throw new Error(`Company project ${project_id} has duplicate Goal Brief acceptance criteria`)
            const binding = {
              plan_id: activePlan.id,
              plan_version: activePlan.version,
              brief_id: brief.brief.id,
              brief_version: brief.brief.version,
              criterion_ids,
            }
            yield* projects.recordEvent({
              project_id,
              type: "delivery.ready",
              actor_id: project.owner_agent_id ?? "system",
              data: {
                delivery_id: `delivery:${project_id}`,
                version: latestReady
                  ? z
                      .object({ version: z.number().int().positive() })
                      .passthrough()
                      .parse(latestReady.data).version + 1
                  : 1,
                artifact_ids: deliveryArtifacts.map((artifact) => artifact.id),
                ...binding,
                sha256: new Bun.CryptoHasher("sha256").update(JSON.stringify(binding)).digest("hex"),
              },
            })
          }
          const deliveryVersion = latestReady
            ? z.object({ version: z.number().int().positive() }).passthrough().parse(latestReady.data).version + 1
            : 1
          yield* publishProjectUpdate({
            project,
            request_id: `delivery-ready:${project_id}:${deliveryVersion}`,
            actor_id: project.owner_agent_id,
            signal_type: "delivery",
            body: [
              `项目交付已就绪：${project.title}`,
              `共 ${deliveryArtifacts.length} 项成果可供验收。`,
              ...deliveryArtifacts.map((artifact) => `成果：${artifact.title}`),
            ].join("\n"),
          })
        }
        return
      }
      const charter = yield* projects.getCharter(project.id)
      if (!charter) throw new Error("Project Charter is missing")
      const gates = yield* projects.listGates(project.id)
      const projectEvents = yield* projects.listEvents(project.id)
      const revisionEvent = projectEvents.findLast(
        (event) => event.type === "delivery.revision_requested",
      )
      const userRevision =
        revisionEvent && typeof revisionEvent.data.reason === "string" ? revisionEvent.data.reason : undefined
      const revisionEventIndex = revisionEvent
        ? projectEvents.findIndex((event) => event.id === revisionEvent.id)
        : -1
      const revisionBaselineArtifactIDs = new Set(
        revisionEventIndex < 0
          ? []
          : z
              .object({ artifact_ids: z.array(z.string()) })
              .passthrough()
              .safeParse(
                projectEvents
                  .slice(0, revisionEventIndex)
                  .findLast((event) => event.type === "delivery.ready")
                  ?.data,
              ).data?.artifact_ids ?? [],
      )
      const assignments = yield* recruitment.listAssignments({ project_id })
      const context = yield* Effect.all({
        work_items: projects.listWorkItems(project.id),
        artifacts: projects.listArtifacts(project.id),
        attempts: projects.listWorkAttempts(project.id),
        receipts: projects.listWorkReceipts(project.id),
        acceptance_facts: acceptanceFacts.listFacts({ project_id: project.id }),
      })
      const gated = ready.filter(
        (item) =>
          item.kind === "worker" &&
          (
            (item.work_type === "coding" && charter.policy.source_approval_preset === "strict")
            || requiresHighRiskApproval(item, charter.policy)
          ) &&
          !gates.some((gate) => riskApprovalCovers(gate, item)),
      )
      if (gated.length) {
        yield* Effect.forEach(
          gated.filter(
            (item) =>
              !gates.some(
                (gate) =>
                  gate.kind === "risk_approval" &&
                  gate.status === "pending" &&
                  gate.work_item_id === item.id &&
                  JSON.stringify(gate.resource_scope) === JSON.stringify(item.resource_scope),
              ),
          ),
          (item) =>
            projects.requestGate({
              project_id: project.id,
              kind: "risk_approval",
              title: item.risk_level === "high"
                ? `批准高风险 WorkItem ${item.id}`
                : `批准 Agent 写入 WorkItem ${item.id}`,
              summary: item.risk_level === "high"
                ? `该动作风险等级为高；批准范围仅限 ${item.resource_scope.join("、")}。`
                : `仅允许该 WorkItem 在资源范围 ${item.resource_scope.join("、")} 内写入和运行验证命令。`,
              requested_by_agent_id: project.owner_agent_id,
              work_item_id: item.id,
              resource_scope: item.resource_scope,
            }),
          { concurrency: 1 },
        )
        return
      }
      const nextStatus = ready.every((item) => item.kind === "reviewer") ? "reviewing" : "executing"
      const dispatchState = yield* projects.get(project_id)
      if (!dispatchState || dispatchState.dispatch_paused) return
      if (dispatchState.status !== nextStatus)
        yield* projects.transition({ id: project.id, status: nextStatus, actor_id: project.owner_agent_id ?? "system" })
      const started = yield* Effect.forEach(
        ready,
        (item) =>
          Effect.gen(function* () {
            if ((yield* projects.get(project_id))?.dispatch_paused) return
            if (yield* obsoleteWorkItem(item)) return
            const budget = yield* contextBudget(
              project,
              agentModelRef(
                project,
                item.kind === "reviewer" && item.risk_level === "high" ? "ultra" : item.model_group,
              ),
            )
            const evidence = taskEvidenceSnapshot({
              project,
              item,
              gates,
              assignment_context: yield* taskAssignmentContext(project, item),
              budget,
              ...context,
            }).evidence
            const assignment = assignments.find(
              (candidate) =>
                candidate.work_item_id === item.id &&
                candidate.agent_id === item.owner_agent_id &&
                (candidate.status === "assigned" || candidate.status === "active"),
            )
            if (!assignment) throw new Error(`Work item ${item.id} has no current ProjectAssignment`)
            if (item.kind === "reviewer") {
              const parentID = reviewedWorkItemID(item)
              if (!parentID) throw new Error(`Reviewer ${item.id} has no reviewed work item`)
              const parent = (yield* projects.listWorkItems(project.id)).find(
                (candidate) => candidate.id === parentID,
              )
              if (!parent) throw new Error(`Reviewer target not found: ${parentID}`)
              const projectArtifacts = yield* projects.listArtifacts(project.id)
              const parentAttempt = (yield* projects.listWorkAttempts(project.id)).findLast(
                (candidate) => candidate.work_item_id === parent.id && candidate.ordinal === parent.attempt,
              )
              const artifact = projectArtifacts.findLast(
                (candidate) =>
                  candidate.work_item_id === parent.id &&
                  candidate.kind === parent.work_type &&
                  (parent.validation_contract_version === 1 || candidate.attempt_id === parentAttempt?.id),
              )
              if (!artifact) throw new Error(`Reviewer has no artifact for ${parent.id}`)
              const baselineArtifact = projectArtifacts.find(
                (candidate) =>
                  revisionBaselineArtifactIDs.has(candidate.id) &&
                  candidate.work_item_id === parent.id &&
                  candidate.kind === parent.work_type,
              )
              const worktree =
                parent.work_type === "coding"
                  ? (yield* projects.listWorktreeRuns(project.id)).findLast(
                      (candidate) => candidate.work_item_id === parent.id,
                    )
                  : undefined
              const runID = yield* startRuntime({
                  project,
                  item,
                  script: reviewerScript(
                    project.goal,
                    project.created_at,
                    item,
                    parent,
                    artifactPromptReference(project, artifact),
                    agentModelRef(project, parent.risk_level === "high" ? "ultra" : "standard"),
                    evidence,
                    parent.validation_contract_version === 2 ? yield* acceptanceFacts.listCriteria(parent.id) : [],
                    artifact.path ? path.relative(project.output_dir, artifact.path) : undefined,
                    userRevision,
                    artifactPromptReference(project, baselineArtifact),
                  ),
                  workspace: project.output_dir,
                  permission_mode: "read_only",
                  context_budget: budget,
                })
              if (!runID) return
              yield* projects.setWorkItemReview({ id: parent.id, review_status: "running" })
              return { item, runID, worktree }
            }
            const reviewer = (yield* projects.listWorkItems(project.id)).find(
              (candidate) => candidate.kind === "reviewer" && reviewedWorkItemID(candidate) === item.id,
            )
            const projectArtifacts = yield* projects.listArtifacts(project.id)
            const reviewArtifact = reviewer
              ? projectArtifacts.findLast(
                  (candidate) =>
                    candidate.work_item_id === reviewer.id &&
                    candidate.kind === "independent_review" &&
                    Boolean(candidate.content),
                )
              : undefined
            const reviewFeedback = reviewArtifact?.content
              ? {
                  artifact_id: reviewArtifact.id,
                  ...reviewResult.parse(JSON.parse(reviewArtifact.content)),
                }
              : undefined
            const baselineArtifact = projectArtifacts.find(
              (candidate) =>
                revisionBaselineArtifactIDs.has(candidate.id) &&
                candidate.work_item_id === item.id &&
                candidate.kind === item.work_type,
            ) ??
              (reviewFeedback
                ? projectArtifacts.findLast(
                    (candidate) => candidate.work_item_id === item.id && candidate.kind === item.work_type,
                  )
                : undefined)
            const worktree =
              item.work_type === "coding"
                ? yield* projects.createWorktreeRun({ project_id: project.id, work_item_id: item.id })
                : undefined
            if (worktree) yield* projects.startWorktreeRun({ id: worktree.id })
            const runID = yield* startRuntime({
                project,
                item,
                script: workerScript(
                  project.goal,
                  project.created_at,
                  item,
                  agentModelRef(project, item.model_group),
                  charter.policy,
                  gates.some((gate) => riskApprovalCovers(gate, item)),
                  assignment.permission_mode,
                  evidence,
                  reviewFeedback,
                  userRevision,
                  artifactPromptReference(project, baselineArtifact),
                ),
                workspace: worktree?.directory,
                permission_mode: workerPermission(
                  item,
                  charter.policy,
                  gates.some((gate) => riskApprovalCovers(gate, item)),
                  assignment.permission_mode,
                ),
                context_budget: budget,
              })
            return runID ? { item, runID, worktree } : undefined
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (yield* obsoleteWorkItem(item)) return
                return yield* Effect.failCause(cause)
              }),
            ),
            Effect.exit,
          ),
        { concurrency: 4 },
      )
      const activeStarted = started.flatMap((entry) =>
        Exit.isSuccess(entry) && entry.value ? [entry.value] : [],
      )
      const startFailures = started.filter(Exit.isFailure)
      if (activeStarted.length)
        yield* Effect.gen(function* () {
        yield* Effect.forEach(
          activeStarted,
          ({ item, runID, worktree }) =>
            Effect.gen(function* () {
              const value = yield* outcome(runID)
              if (item.kind === "worker") {
                const parsed = z.object({ summary: z.string(), submission: submissions[item.work_type] }).parse(value)
                const verification = combineVerification(
                  yield* workType.verify(item.work_type as WorkTypeID, {
                    submission: parsed.submission,
                    orgLayer: "project",
                    researchMode: researchModeFor(item),
                  }),
                  acceptanceVerification(item, parsed.summary, parsed.submission),
                )
                const content = `${JSON.stringify(parsed, null, 2)}\n`
                const materializedFile =
                  designArtifactFile(item, parsed.submission) ?? structuredArtifactFile(item, content)
                const artifact = yield* projects.addArtifact({
                  project_id: project.id,
                  work_item_id: item.id,
                  kind: item.work_type,
                  title: artifactTitle(item, parsed.submission),
                  path: materializedFile.path,
                  content,
                  file_content: materializedFile.content,
                  evidence: {
                    work_type_verification: verification,
                    content_sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
                    host_materialized_file: materializedFile.evidence,
                  },
                  created_by_agent_id: item.owner_agent_id,
                })
                if (!verification.passed) return yield* failure(item, verification.findings.join("; "))
                const verified =
                  item.work_type === "coding" && worktree
                    ? yield* projects.verifyWorktreeRun({
                        id: worktree.id,
                        commands: submissions.coding.parse(parsed.submission).verificationCommands,
                      })
                    : undefined
                if (verified && verified.status !== "awaiting_merge_approval")
                  return yield* failure(item, verified.error ?? "Host worktree verification failed")
                if (item.source_task_key === "board_closeout_and_organization_decision") {
                  if (!project.owner_agent_id || item.owner_agent_id !== project.owner_agent_id)
                    return yield* failure(
                      item,
                      `Board closeout work item ${item.id} must be owned by project DRI ${project.owner_agent_id ?? "missing"}, not ${item.owner_agent_id ?? "unassigned"}; reassign the blocked work item to the DRI before retrying`,
                      false,
                    )
                  if (!project.company_id || !project.source_thread_id)
                    return yield* failure(
                      item,
                      `Board closeout work item ${item.id} requires project company_id and source_thread_id before the DRI can sign`,
                      false,
                    )
                  yield* recordBoardCloseout({ project, item, artifact, summary: parsed.summary })
                }
                const reviewer = (yield* projects.listWorkItems(project.id)).find(
                  (candidate) => candidate.kind === "reviewer" && reviewedWorkItemID(candidate) === item.id,
                )
                if (reviewer) {
                  yield* persistVerificationEvidence({ item, artifact, verification, worktree: verified })
                  yield* projects.setWorkItemReview({ id: item.id, review_status: "pending" })
                  yield* projects.recordEvent({
                    project_id: project.id,
                    type: "work_item.delivery_ready_for_review",
                    actor_id: item.owner_agent_id,
                    data: {
                      work_item_id: item.id,
                      reviewer_id: reviewer.id,
                      artifact_id: artifact.id,
                    },
                  })
                  return
                }
                yield* persistSystemVerification({ item, artifact, verification, worktree: verified })
                yield* completeValidatedWorkItem({ item, artifact, summary: parsed.summary })
                yield* reputation.updateFromAdmission(item.owner_agent_id ?? item.role, true, [], "project")
                return
              }
              const parsed = reviewResult.parse(value)
              const parentID = reviewedWorkItemID(item)
              if (!parentID) throw new Error(`Reviewer ${item.id} has no reviewed work item`)
              const parent = (yield* projects.listWorkItems(project.id)).find(
                (candidate) => candidate.id === parentID,
              )
              if (!parent) throw new Error(`Reviewer target not found: ${parentID}`)
              const parentAttempt = (yield* projects.listWorkAttempts(project.id)).findLast(
                (candidate) => candidate.work_item_id === parent.id && candidate.ordinal === parent.attempt,
              )
              const parentArtifact = (yield* projects.listArtifacts(project.id)).findLast(
                (candidate) =>
                  candidate.work_item_id === parent.id &&
                  candidate.kind === parent.work_type &&
                  (parent.validation_contract_version === 1 || candidate.attempt_id === parentAttempt?.id),
              )
              if (!parentArtifact?.content) throw new Error(`Reviewer target ${parent.id} has no persisted artifact`)
              const reviewEvidence = yield* reviewerRunEvidence({
                project,
                item,
                target_artifact: parentArtifact,
                workflow_run_id: runID,
                criteria: parent.validation_contract_version === 2 ? yield* acceptanceFacts.listCriteria(parent.id) : [],
              })
              const reviewArtifact = yield* projects.addArtifact({
                project_id: project.id,
                work_item_id: item.id,
                kind: "independent_review",
                title: item.title,
                path: `artifacts/${item.id}-attempt-${item.attempt + 1}.json`,
                content: JSON.stringify(parsed, null, 2) + "\n",
                evidence: {
                  evidence_checked: parsed.evidence_checked,
                  agent_run_id: reviewEvidence?.agent_run_id,
                  tool_event_ids: reviewEvidence?.tool_event_ids,
                },
                created_by_agent_id: item.owner_agent_id,
              })
              if (parent.validation_contract_version === 2) {
                if (!reviewEvidence) throw new Error(`Reviewer ${item.id} has no independent runtime evidence`)
                yield* recordReviewerAcceptanceFacts({
                  item: parent,
                  artifact: parentArtifact,
                  review_artifact: reviewArtifact,
                  agent_run_id: reviewEvidence.agent_run_id,
                  tool_event_ids: reviewEvidence.tool_event_ids,
                  result: parsed,
                })
                yield* recordReviewerContractFact({
                  item,
                  artifact: reviewArtifact,
                  target_artifact: parentArtifact,
                  agent_run_id: reviewEvidence.agent_run_id,
                  tool_event_ids: reviewEvidence.tool_event_ids,
                  result: parsed,
                })
              }
              if (!parsed.accepted) {
                yield* projects.setWorkItemReview({ id: parent.id, review_status: "rejected" })
                const error = parsed.findings.join("; ") || parsed.summary
                if (item.validation_contract_version === 2)
                  yield* completeValidatedWorkItem({ item, artifact: reviewArtifact, summary: parsed.summary })
                else yield* projects.blockWorkItem({ id: item.id, error })
                if (parent.status === "running") yield* projects.blockWorkItem({ id: parent.id, error })
                yield* reputation.updateFromAdmission(item.owner_agent_id ?? item.role, true, [], "project")
                yield* reputation.updateFromAdmission(
                  parent.owner_agent_id ?? parent.role,
                  false,
                  [{ severity: "blocker" }],
                  "project",
                )
                if (parent.attempt < parent.max_attempts) {
                  yield* projects.reworkRejectedReview({ worker_id: parent.id, reviewer_id: item.id })
                  yield* projects.recordEvent({
                    project_id: project.id,
                    type: "work_item.rework_scheduled",
                    actor_id: item.owner_agent_id,
                    data: {
                      worker_id: parent.id,
                      reviewer_id: item.id,
                      review_artifact_id: reviewArtifact.id,
                      findings: parsed.findings,
                      summary: parsed.summary,
                    },
                  })
                }
                yield* publishProjectUpdate({
                  project,
                  request_id: `review-rejected:${reviewArtifact.id}`,
                  actor_id: item.owner_agent_id,
                  signal_type: "risk",
                  body: [
                    `独立复核未通过：${parent.title}`,
                    `复核结论：${parsed.summary}`,
                    ...parsed.findings.map((finding) => `需修正：${finding}`),
                    parent.attempt < parent.max_attempts ? "已安排返工。" : "返工次数已用尽，需要负责人处理。",
                  ].join("\n"),
                })
                return
              }
              if (!parsed.evidence_checked.length)
                throw new Error(`Reviewer ${item.id} accepted without checked evidence`)
              if (parent.validation_contract_version === 2) {
                yield* completeValidatedWorkItem({ item: parent, artifact: parentArtifact, summary: parsed.summary })
                yield* completeValidatedWorkItem({ item, artifact: reviewArtifact, summary: parsed.summary })
                yield* reputation.updateFromAdmission(item.owner_agent_id ?? item.role, true, [], "project")
                yield* reputation.updateFromAdmission(parent.owner_agent_id ?? parent.role, true, [], "project")
              }
              if (parent.validation_contract_version === 1) {
              const parentArtifactSha = new Bun.CryptoHasher("sha256").update(parentArtifact.content).digest("hex")
              const parentArtifactGate = yield* validation.create({
                id: `review-parent-${new Bun.CryptoHasher("sha256")
                  .update(`${parent.id}:${parentArtifact.id}:${item.id}`)
                  .digest("hex")
                  .slice(0, 40)}`,
                project_id: project.id,
                work_item_id: parent.id,
                kind: "artifact",
                criteria: [
                  {
                    id: `parent-artifact-${parentArtifactSha.slice(0, 24)}`,
                    statement: "Parent delivery artifact bytes are persisted",
                    anchor: { kind: "artifact", reference: `artifact:${parentArtifact.id}` },
                    operator: "digest",
                    expected: parentArtifactSha,
                  },
                ],
                blocking_work_item_ids: [parent.id],
                evaluator: "artifact_digest_v1",
                max_repair_rounds: 3,
              })
              const reviewGate = yield* validation.create({
                id: `review-acceptance-${new Bun.CryptoHasher("sha256")
                  .update(`${parent.id}:${reviewArtifact.id}:${item.id}`)
                  .digest("hex")
                  .slice(0, 40)}`,
                project_id: project.id,
                work_item_id: parent.id,
                kind: "policy",
                criteria: parent.acceptance_criteria.map((criterion, index) => ({
                  id: `reviewed-${index + 1}-${new Bun.CryptoHasher("sha256")
                    .update(criterion)
                    .digest("hex")
                    .slice(0, 24)}`,
                  statement: criterion,
                  anchor: { kind: "policy", reference: `artifact:${reviewArtifact.id}` },
                  operator: "equals",
                  expected: true,
                })),
                blocking_work_item_ids: [parent.id],
                evaluator: "policy_invariant_v1",
                max_repair_rounds: 3,
              })
              if (parentArtifactGate.status !== "passed" || reviewGate.status !== "passed")
                throw new Error(`Independent review gates did not pass for ${parent.id}`)
              yield* completeValidatedWorkItem({ item: parent, artifact: parentArtifact, summary: parsed.summary })
              yield* projects.completeWorkItemWithReceipt({
                id: item.id,
                receipt: {
                  idempotency_key: `review:${item.id}:attempt:${item.attempt + 1}`,
                  outcome: "completed",
                  summary: parsed.summary,
                  artifact_ids: [reviewArtifact.id],
                  evidence_refs: [{ kind: "artifact", id: reviewArtifact.id }],
                  confirmed_facts: [
                    `independent_review:${parent.id}:validation_gate:${reviewGate.id}:passed`,
                    `parent_artifact:${parentArtifact.id}:validation_gate:${parentArtifactGate.id}:passed`,
                  ],
                  invalidated_assumptions: [],
                  unknowns: [],
                  blockers: [],
                  capability_gaps: [],
                  task_proposals: [],
                  dependency_proposals: [],
                  questions: [],
                },
              })
              yield* reputation.updateFromAdmission(item.owner_agent_id ?? item.role, true, [], "project")
              yield* reputation.updateFromAdmission(parent.owner_agent_id ?? parent.role, true, [], "project")
              }
              yield* projects.setWorkItemReview({ id: parent.id, review_status: "accepted" })
              if (parent.work_type !== "coding") return
              const parentWorktree =
                worktree ??
                (yield* projects.listWorktreeRuns(project.id)).findLast(
                  (candidate) => candidate.work_item_id === parent.id,
                )
              if (!parentWorktree) throw new Error(`Coding reviewer has no worktree for ${parent.id}`)
              const gate = yield* projects.requestMergeApproval({
                id: parentWorktree.id,
                title: `批准合并：${parent.title}`,
                summary: `${parsed.summary}\n\n分支 ${parentWorktree.branch} 已通过 Work Type 验证、宿主命令与独立复核。`,
                requested_by_agent_id: item.owner_agent_id,
                review: parsed,
              })
              const charter = yield* projects.getCharter(project.id)
              if (!charter || charter.policy.require_human_merge) return
              yield* projects.resolveGate({ id: gate.id, decision: "approve", note: "公司自主权限策略自动批准" })
              const merged = yield* projects.mergeWorktreeRun(parentWorktree.id)
              yield* projects.addArtifact({
                project_id: project.id,
                work_item_id: merged.work_item_id,
                kind: "merge_report",
                title: "主分支自动合并与复验报告",
                path: `artifacts/${merged.id}-merge.json`,
                content: JSON.stringify(merged, null, 2) + "\n",
                evidence: merged.verification,
                created_by_agent_id: item.owner_agent_id,
              })
              yield* projects.transition({
                id: project.id,
                status: "reviewing",
                actor_id: item.owner_agent_id ?? "system",
                reason: "公司自主权限策略已完成自动合并",
              })
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  const current = (yield* projects.listWorkItems(project.id)).find(
                    (candidate) => candidate.id === item.id,
                  )
                  if (yield* obsoleteWorkItem(item)) return
                  if (current?.status === "running") {
                    yield* failure(item, String(Cause.squash(cause)))
                    return
                  }
                  yield* blockProject(project.id, String(cause))
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        )
        yield* projects.setActiveRun({ id: project.id })
        const current = yield* projects.get(project.id)
        if (current?.status !== "awaiting_approval") yield* startReadyWave(project.id)
        }).pipe(
          Effect.catchCause((cause) => blockProject(project.id, String(cause))),
          Effect.forkIn(scope),
        )
      if (!activeStarted.length && startFailures[0]) return yield* Effect.failCause(startFailures[0].cause)
      return activeStarted[0]?.runID
    })

    const continuePlanner = Effect.fn("CompanyProjectExecution.continuePlanner")(function* (input: {
      project: Project
      item: WorkItem
      runID: string
      approvedCharter?: BoardProjectCharter
      approvalPreset?: ApprovalPreset
    }) {
      const result = yield* outcome(input.runID)
      const generatedCharter = input.approvedCharter
        ? input.approvedCharter
        : (() => {
            const draft = charterResult.parse(result)
            return BoardProjectCharter.parse({
              title: input.project.title,
              value: draft.summary,
              deliverables: draft.success_criteria,
              acceptance_criteria: draft.acceptance_criteria,
              scope: draft.scope,
              non_goals: ["不执行项目范围外工作"],
              constraints: draft.constraints.length ? draft.constraints : ["遵守当前公司权限与审批策略"],
              resources: [{ kind: "other", scope: input.project.output_dir, disposition: "retain" }],
              risks: [],
              dri_agent_id: input.project.owner_agent_id ?? input.item.owner_agent_id,
              milestones: draft.success_criteria,
              open_decisions: [],
            })
          })()
      const artifacts = yield* projects.listArtifacts(input.project.id)
      const projectionArtifact = artifacts.findLast(
        (artifact) =>
          artifact.work_item_id === input.item.id && artifact.kind === "project_charter" && Boolean(artifact.content),
      )
      const savedProjection = projectionArtifact?.content
        ? plannerProjection.parse(JSON.parse(projectionArtifact.content))
        : undefined
      if (
        savedProjection &&
        input.approvedCharter &&
        JSON.stringify(savedProjection.charter) !== JSON.stringify(input.approvedCharter)
      )
        throw new Error("Saved planner projection conflicts with the approved Project Charter")
      const parsed = savedProjection?.charter ?? generatedCharter
      yield* projects.createCharter({
        project_id: input.project.id,
        title: parsed.title,
        value: parsed.value,
        deliverables: parsed.deliverables,
        scope: parsed.scope,
        non_goals: parsed.non_goals,
        success_criteria: parsed.deliverables,
        constraints: parsed.constraints,
        resources: parsed.resources,
        risks: parsed.risks,
        dri_agent_id: parsed.dri_agent_id,
        milestones: parsed.milestones,
        open_decisions: parsed.open_decisions,
        acceptance_criteria: parsed.acceptance_criteria,
        policy: policyForApprovalPreset(input.approvalPreset),
      })
      const tasks = normalizeStableCopyDependencies(
        savedProjection?.tasks
          ? savedProjection.tasks
          : (
              yield* delegation.decompose({
                goal: input.project.goal,
                context: [
                  `Project Charter: ${JSON.stringify(parsed)}`,
                  "Use domain-neutral work types. Each task must own a non-overlapping decision scope and resource scope.",
                  "Preserve every explicit numbered deliverable mapping exactly. A task for D1, D2, D3, or another numbered deliverable must include every requirement and acceptance criterion assigned to that same label, and must never move a hard rule to a sibling deliverable.",
                  "When a visual deliverable and a copy deliverable share stable content IDs, schedule the copy deliverable first and make the visual deliverable depend on it. The visual deliverable must reuse the exact visible strings for each shared ID; visual directions may differ in composition and styling, not wording.",
                  "The planner never implements and workers never redesign sibling tasks.",
                  deliveryAcceptanceLanguageRule,
                  localExecutionBoundary,
                ].join("\n"),
                sessionID: input.project.coordinator_session_id!,
                delegatorAgentID: input.item.owner_agent_id!,
                actorAgentType: "general",
              })
            )
              .map(normalizeExecutableTask)
              .map(normalizeOutputQualityTask)
              .map(normalizeTaskAcceptanceLanguage),
      )
      const keys = validateTasks(tasks)
      const sourceKeys = keys.map(stableLogicalKey)
      if (new Set(sourceKeys).size !== sourceKeys.length)
        throw new Error("Delegation task keys collapse to the same stable source key")
      const plan = (yield* projects.listPlans(input.project.id)).find((candidate) => candidate.id === input.item.plan_id)
      if (!plan) throw new Error("Project plan is missing")
      const needKeyScope = plan.version > 1 ? `plan-${plan.version}-` : ""
      const needKeys = sourceKeys.map((key) => ({
        worker: stableLogicalKey(`worker-${needKeyScope}${key}`),
        reviewer: stableLogicalKey(`reviewer-${needKeyScope}${key}`),
      }))
      if (new Set(needKeys.flatMap((key) => [key.worker, key.reviewer])).size !== needKeys.length * 2)
        throw new Error("Delegation capability need keys must be unique")
      if (!savedProjection)
        yield* projects.addArtifact({
          project_id: input.project.id,
          work_item_id: input.item.id,
          kind: "project_charter",
          title: "项目范围与动态任务计划",
          path: "artifacts/project-charter.json",
          content: JSON.stringify({ charter: parsed, tasks }, null, 2) + "\n",
          evidence: { task_count: tasks.length },
          created_by_agent_id: input.item.owner_agent_id,
        })
      const charterPolicy = (yield* projects.getCharter(input.project.id))?.policy
      if (!charterPolicy) throw new Error("Project Charter policy is missing")
      const existingItems = yield* projects.listWorkItems(input.project.id)
      const created = new Map<string, { worker: WorkItem; reviewer?: WorkItem }>()
      for (const [index, task] of tasks.entries()) {
        const key = keys[index]!
        const sourceKey = sourceKeys[index]!
        const type = inferWorkType(task)
        const role = task.role ?? `${type} specialist`
        const group = modelGroups.includes(task.modelGroup ?? "standard") ? (task.modelGroup ?? "standard") : "standard"
        const packs = executableCapabilityPacks(task.capabilityPacks ?? [], type)
        // TEAM-03: the rule layer—not the planner label—decides risk and
        // verification strength, so prompts cannot bypass review or gates.
        const decision = orchestrationPlan({
          work_type: type,
          declared_risk: task.riskLevel,
          approval_preset: charterPolicy.source_approval_preset,
          requires_semantic_review:
            acceptanceCriterionVerification(task.acceptanceCriteria).verification_kind === "semantic_review",
        })
        const risk = decision.risk_level
        const dependencies = [
          ...(task.dependsOn ?? []).map((dependency) => {
            const upstream = created.get(dependency)!
            return (upstream.reviewer ?? upstream.worker).id
          }),
        ].filter((value, position, values) => values.indexOf(value) === position)
        const parentID = task.parentKey ? created.get(task.parentKey)!.worker.id : input.item.id
        const keyedWorker = existingItems.find(
          (item) => item.plan_id === plan.id && item.kind === "worker" && item.source_task_key === sourceKey,
        )
        const legacyWorkers = keyedWorker
          ? []
          : existingItems.filter(
              (item) =>
                item.plan_id === plan.id &&
                item.kind === "worker" &&
                !item.source_task_key &&
                item.parent_id === parentID &&
                item.description === task.summary &&
                item.role === role,
            )
        if (legacyWorkers.length > 1) throw new Error(`Ambiguous legacy worker projection for ${key}`)
        const existingWorker = keyedWorker ?? legacyWorkers[0]
        const workerInput = {
          project_id: input.project.id,
          plan_id: plan.id,
          source_task_key: sourceKey,
          parent_id: parentID,
          title: conciseWorkItemTitle(task.summary),
          description: task.summary,
          ...decision.worker_contract,
          work_type: type,
          role,
          capability_packs: packs,
          decision_scope: task.decisionScope?.length ? task.decisionScope : [task.summary],
          resource_scope: task.resourceScope?.length ? task.resourceScope : [`artifacts/${key}`],
          inputs: [`项目范围 ${input.project.id}`, task.summary],
          expected_outputs: [task.acceptanceCriteria],
          validators: [task.acceptanceCriteria],
          disposition: "retain",
          model_group: group,
          risk_level: risk,
          validation_contract_version: 2 as const,
          owner_agent_id: existingWorker?.owner_agent_id,
          acceptance_criteria: [task.acceptanceCriteria],
          max_attempts: risk === "high" ? 6 : 4,
          depends_on: dependencies,
        }
        if (legacyWorkers[0]) {
          if (
            legacyWorkers[0].status !== "pending" ||
            legacyWorkers[0].attempt !== 0 ||
            legacyWorkers[0].workflow_run_id ||
            !projectionFactsMatch(legacyWorkers[0], workerInput)
          )
            throw new Error(`Legacy worker projection differs from saved task ${key}`)
          yield* projects.setWorkItemSourceTaskKey({ id: legacyWorkers[0].id, source_task_key: sourceKey })
        }
        const worker = yield* staffWorkItem({
          project: input.project,
          item: yield* projects.createWorkItem(workerInput),
          key,
          need_key: needKeys[index]!.worker,
        })
        if (!worker.owner_agent_id) throw new Error(`Worker ${worker.id} has no current Assignment`)
        const ownerID = worker.owner_agent_id
        yield* projects.recordEvent({
          project_id: input.project.id,
          type: "work_item.orchestration_planned",
          actor_id: input.item.owner_agent_id,
          data: {
            key,
            work_item_id: worker.id,
            declared_risk: task.riskLevel,
            risk_level: risk,
            strength: decision.strength,
            reviewer: decision.reviewer,
            gate: decision.gate,
            reasons: decision.reasons,
            alternatives: decision.alternatives,
          },
        })
        if (!decision.reviewer) {
          created.set(key, { worker })
          continue
        }
        const reviewerRole = `${role} independent reviewer`
        const reviewerGroup = risk === "high" ? "ultra" : "standard"
        const keyedReviewer = existingItems.find(
          (item) => item.plan_id === plan.id && item.kind === "reviewer" && item.source_task_key === sourceKey,
        )
        const legacyReviewers = keyedReviewer
          ? []
          : existingItems.filter(
              (item) =>
                item.plan_id === plan.id &&
                item.kind === "reviewer" &&
                !item.source_task_key &&
                reviewedWorkItemID(item) === worker.id &&
                item.role === reviewerRole,
            )
        if (legacyReviewers.length > 1) throw new Error(`Ambiguous legacy reviewer projection for ${key}`)
        const existingReviewer = keyedReviewer ?? legacyReviewers[0]
        const reviewerInput = {
          project_id: input.project.id,
          plan_id: plan.id,
          source_task_key: sourceKey,
          parent_id: worker.id,
          reviews_work_item_id: worker.id,
          title: `独立复核：${worker.title}`,
          description: `独立检查“${worker.title}”的交付物、证据和验收条件。`,
          ...decision.reviewer_contract!,
          work_type: type,
          role: reviewerRole,
          capability_packs: ["independent-review@1"],
          decision_scope: [],
          resource_scope: worker.resource_scope,
          inputs: [`工作项 ${worker.id} 的交付物与验证证据`],
          expected_outputs: ["逐项覆盖被审任务验收合同的独立复核结论"],
          validators: ["review_results_cover_target_criteria"],
          disposition: "retain",
          model_group: reviewerGroup as "ultra" | "standard",
          risk_level: risk,
          validation_contract_version: 2 as const,
          owner_agent_id: existingReviewer?.owner_agent_id,
          acceptance_criteria: ["review_results_cover_target_criteria"],
          max_attempts: risk === "high" ? 6 : 4,
          depends_on: [worker.id],
        }
        if (legacyReviewers[0]) {
          if (
            legacyReviewers[0].status !== "pending" ||
            legacyReviewers[0].attempt !== 0 ||
            legacyReviewers[0].workflow_run_id ||
            !projectionFactsMatch(legacyReviewers[0], reviewerInput)
          )
            throw new Error(`Legacy reviewer projection differs from saved task ${key}`)
          yield* projects.setWorkItemSourceTaskKey({ id: legacyReviewers[0].id, source_task_key: sourceKey })
        }
        const reviewer = yield* staffWorkItem({
          project: input.project,
          item: yield* projects.createWorkItem(reviewerInput),
          key: `${key}-review`,
          need_key: needKeys[index]!.reviewer,
          exclude: [ownerID],
        })
        if (!reviewer.owner_agent_id) throw new Error(`Reviewer ${reviewer.id} has no current Assignment`)
        created.set(key, {
          worker,
          reviewer,
        })
      }
      yield* projects.completeWorkItem(input.item.id)
      yield* projects.setActiveRun({ id: input.project.id })
    })

    const launchPlanner: (project: Project, item: WorkItem) => Effect.Effect<string> = Effect.fn(
      "CompanyProjectExecution.launchPlanner",
    )(function* (project: Project, item: WorkItem) {
      const runID = yield* startRuntime({
        project,
        item,
        script: plannerScript(project.goal, item.owner_agent_id!, agentModelRef(project, "ultra")),
        permission_mode: "read_only",
      })
      if (!runID) throw new Error(`Planner ${item.id} lost its dispatch claim`)
      yield* Effect.gen(function* () {
        yield* continuePlanner({ project, item: { ...item, attempt: item.attempt + 1 }, runID }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* failure(item, String(cause))
              const current = yield* projects.listWorkItems(project.id)
              const pending = current.find((candidate) => candidate.id === item.id)
              if (pending?.status === "pending") {
                yield* launchPlanner(project, pending)
                return
              }
              yield* blockProject(project.id, String(cause))
            }),
          ),
        )
        const current = (yield* projects.listWorkItems(project.id)).find((candidate) => candidate.id === item.id)
        if (current?.status === "completed")
          yield* startReadyWave(project.id).pipe(Effect.catchCause((cause) => blockProject(project.id, String(cause))))
      }).pipe(Effect.forkIn(scope))
      return runID
    })

    const launchApprovedCharter: (
      project: Project,
      item: WorkItem,
      charter: BoardProjectCharter,
      approvalPreset?: ApprovalPreset,
    ) => Effect.Effect<string> = Effect.fn("CompanyProjectExecution.launchApprovedCharter")(function* (
      project: Project,
      item: WorkItem,
      charter: BoardProjectCharter,
      approvalPreset?: ApprovalPreset,
    ) {
      const runID = yield* startRuntime({
        project,
        item,
        script: approvedCharterScript(charter),
        permission_mode: "read_only",
      })
      if (!runID) throw new Error(`Planner ${item.id} lost its dispatch claim`)
      yield* Effect.gen(function* () {
        yield* continuePlanner({
          project,
          item: { ...item, attempt: item.attempt + 1 },
          runID,
          approvedCharter: charter,
          approvalPreset,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* failure(item, String(cause))
              const current = (yield* projects.listWorkItems(project.id)).find((candidate) => candidate.id === item.id)
              if (current?.status === "pending") {
                yield* launchApprovedCharter(project, current, charter, approvalPreset)
                return
              }
              yield* blockProject(project.id, String(cause))
            }),
          ),
        )
        const current = (yield* projects.listWorkItems(project.id)).find((candidate) => candidate.id === item.id)
        if (current?.status === "completed")
          yield* startReadyWave(project.id).pipe(Effect.catchCause((cause) => blockProject(project.id, String(cause))))
      }).pipe(Effect.forkIn(scope))
      return runID
    })

    const replanFromCharter = Effect.fn("CompanyProjectExecution.replanFromCharter")(function* (input: {
      project_id: string
      plan_id: string
      charter: BoardProjectCharter
    }) {
      const charter = BoardProjectCharter.parse(input.charter)
      const project = yield* projects.get(input.project_id)
      if (!project) throw new Error(`Company project not found: ${input.project_id}`)
      if (project.execution_strategy !== "legacy_full_plan")
        throw new Error(`Company project ${project.id} cannot rebuild a legacy plan from ${project.execution_strategy}`)
      const plan = (yield* projects.listPlans(project.id)).find((candidate) => candidate.id === input.plan_id)
      if (!plan || plan.status !== "active")
        throw new Error(`Active project plan not found: ${input.plan_id}`)
      const existing = (yield* projects.listWorkItems(project.id)).find(
        (item) => item.plan_id === plan.id && item.kind === "planner",
      )
      const planner = yield* staffWorkItem({
        project,
        key: `project-replan-${plan.version}`,
        need_key: stableLogicalKey(`project-replan-${plan.version}`),
        item:
          existing ??
          (yield* projects.createWorkItem({
            project_id: project.id,
            plan_id: plan.id,
            source_task_key: stableLogicalKey(`project-replan-${plan.version}`),
            title: "根据新方向重建任务树",
            description: "保持最新目标摘要、交付物、验收条件与硬约束不变，只重建依赖有序的交付 Worker；复核节点由规则层生成。",
            kind: "planner",
            work_type: "decision",
            role: "project-planner",
            capability_packs: ["product-charter@1"],
            decision_scope: ["新计划工作项边界", "依赖关系", "临时责任"],
            resource_scope: charter.resources.map((resource) => resource.scope),
            inputs: ["最新 Goal Brief", "方向调整后的 Project Charter"],
            expected_outputs: ["新计划下依赖有序的交付 Worker Work Items"],
            validators: ["每个叶子任务可独立验收", "每个正式责任只有一个 owner", "独立复核者与执行者不同"],
            disposition: "retain",
            model_group: "ultra",
            risk_level: "medium",
            review_status: "not_required",
            acceptance_criteria: ["新任务树覆盖最新交付物、验收条件与硬约束"],
            max_attempts: 2,
          })),
      })
      const resumed =
        project.status === "blocked" || project.status === "rejected"
          ? yield* projects.transition({
              id: project.id,
              status: "planning",
              actor_id: planner.owner_agent_id ?? "user",
              reason: "方向调整已生成新计划，开始重建任务树",
            })
          : project
      if (planner.status === "running")
        return {
          project: resumed,
          plan,
          work_item: planner,
          run_id: planner.workflow_run_id ?? resumed.active_run_id,
          replayed: true,
        }
      if (planner.status === "completed")
        return {
          project: resumed,
          plan,
          work_item: planner,
          run_id: (yield* startReadyWave(project.id)) ?? resumed.active_run_id,
          replayed: true,
        }
      if (planner.status !== "pending")
        throw new Error(`Direction planner ${planner.id} cannot run from ${planner.status}`)
      return {
        project: resumed,
        plan,
        work_item: planner,
        run_id: yield* launchApprovedCharter(resumed, planner, charter),
        replayed: Boolean(existing),
      }
    })

    const startFromCharter = Effect.fn("CompanyProjectExecution.startFromCharter")(function* (input: {
      company_id: string
      root_need_id: string
      source_thread_id: string
      request_id: string
      goal: string
      charter: BoardProjectCharter
      provider_id?: string
      model_id?: string
      execution_strategy?: ProjectExecutionStrategyValue
      seed_policy?: SeedPolicyFactsValue
    }) {
      const charterInput = BoardProjectCharter.parse(input.charter)
      const existing = yield* projects.findBySourceThread(input.source_thread_id)
      if (existing && existing.decision_request_id !== input.request_id) {
        return yield* Effect.fail(
          new BoardProjectDecisionConflict({ thread_id: input.source_thread_id, request_id: input.request_id }),
        )
      }
      const existingCharter = existing ? yield* projects.getCharter(existing.id) : undefined
      if (existingCharter) {
        if (JSON.stringify(approvedCharterFromProject(existingCharter)) !== JSON.stringify(charterInput)) {
          return yield* Effect.fail(
            new BoardProjectDecisionConflict({ thread_id: input.source_thread_id, request_id: input.request_id }),
          )
        }
      }

      const execution = existing ? undefined : resolveNewExecution(input)
      const selectedModel = existing ? undefined : yield* resolveModel(input)
      const session = existing
        ? yield* sessions.get(SessionID.make(existing.coordinator_session_id!))
        : yield* sessions.create({
            title: `项目：${charterInput.title}`,
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
      if (!session) throw new Error("Board project coordinator session is unavailable")
      const project =
        existing ??
        (yield* projects.create({
          company_id: input.company_id,
          root_need_id: input.root_need_id,
          source_thread_id: input.source_thread_id,
          decision_request_id: input.request_id,
          goal: input.goal,
          title: charterInput.title,
          owner_agent_id: charterInput.dri_agent_id,
          coordinator_session_id: session.id,
          provider_id: selectedModel?.providerID,
          model_id: selectedModel?.modelID,
          execution_strategy: execution!.execution_strategy,
          seed_mode: execution?.verdict?.mode,
        }))
      if (!existing && execution?.shadow)
        yield* persistShadowSeedVerdict(project, execution.shadow).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
      const charter =
        existingCharter ??
        (yield* projects.createCharter({
          project_id: project.id,
          title: charterInput.title,
          value: charterInput.value,
          deliverables: charterInput.deliverables,
          acceptance_criteria: charterInput.acceptance_criteria,
          scope: charterInput.scope,
          non_goals: charterInput.non_goals,
          constraints: charterInput.constraints,
          resources: charterInput.resources,
          risks: charterInput.risks,
          dri_agent_id: charterInput.dri_agent_id,
          milestones: charterInput.milestones,
          open_decisions: charterInput.open_decisions,
          success_criteria: charterInput.deliverables,
        }))
      if (project.execution_strategy === "seed_and_grow") {
        const verdict = existing ? yield* seedVerdict(project) : execution!.verdict!
        if (!existing) yield* persistSeedVerdict(project, verdict)
        const team = yield* startSeedProject({
          project,
          verdict,
          projects,
          recruitment,
        })
        const planning =
          project.status === "intake"
            ? yield* projects.transition({
                id: project.id,
                status: "planning",
                actor_id: charterInput.dri_agent_id,
              })
            : project
        if (planning.status === "planning")
          yield* projects.transition({
            id: project.id,
            status: "executing",
            actor_id: charterInput.dri_agent_id,
          })
        const runID = (yield* startSeedWave(project.id)) ?? (yield* projects.get(project.id))?.active_run_id
        if (
          verdict.mode === "discovery_first" &&
          !(yield* projects.listGates(project.id)).some(
            (gate) =>
              gate.kind === "risk_approval" &&
              gate.status === "pending" &&
              gate.work_item_id === team.builder.id &&
              JSON.stringify(gate.resource_scope) === JSON.stringify(team.builder.resource_scope),
          )
        )
          yield* projects.requestGate({
            project_id: project.id,
            kind: "risk_approval",
            title: "批准 First Slice Builder",
            summary: "Wayfinder 保持只读。批准后才会为 First Slice Builder 建立 Assignment 并启动执行。",
            requested_by_agent_id: team.wayfinder?.owner_agent_id ?? project.owner_agent_id,
            work_item_id: team.builder.id,
            resource_scope: team.builder.resource_scope,
          })
        return {
          project: (yield* projects.get(project.id))!,
          charter: team.charter,
          plan: team.plan,
          work_item: team.wayfinder ?? team.builder,
          run_id: runID,
          replayed: Boolean(existing),
        }
      }
      const plan =
        (yield* projects.listPlans(project.id))[0] ??
        (yield* projects.createPlan({
          project_id: project.id,
          phase: "planning",
          summary: "依据董事会已批准的项目范围拆解可执行工作项。",
          acceptance_criteria: [
            "每个 Work Item 有唯一负责人",
            "输入、产出、资源、验证器与处置方式完整",
            "执行者与独立 Reviewer 分离",
          ],
        }))
      const existingWorkItem = (yield* projects.listWorkItems(project.id)).find((item) => item.kind === "planner")
      const workItem = yield* staffWorkItem({
        project,
        key: "project-planner",
        need_key: stableLogicalKey("project-planner"),
        item:
          existingWorkItem ??
          (yield* projects.createWorkItem({
            project_id: project.id,
            plan_id: plan.id,
            title: "拆解已批准的项目范围",
            description: "保持董事会批准的范围与验收不变，只将项目范围拆成依赖有序的交付 Worker；复核节点由规则层生成。",
            kind: "planner",
            work_type: "decision",
            role: "project-planner",
            capability_packs: ["product-charter@1"],
            decision_scope: ["Work Item 边界", "初始依赖关系", "临时责任"],
            resource_scope: charterInput.resources.map((resource) => resource.scope),
            inputs: [
              `Root Need ${input.root_need_id}`,
              `Board Thread ${input.source_thread_id}`,
              "已批准 Project Charter",
            ],
            expected_outputs: ["依赖有序的交付 Worker Work Items"],
            validators: ["每个叶子任务可独立验收", "每个正式责任只有一个 owner", "独立复核者与执行者不同"],
            disposition: "retain",
            model_group: "ultra",
            risk_level: "medium",
            review_status: "not_required",
            acceptance_criteria: ["任务树有界且所有叶子任务满足 Execution Ready"],
            max_attempts: 2,
          })),
      })
      const planning =
        project.status === "intake"
          ? yield* projects.transition({ id: project.id, status: "planning", actor_id: charterInput.dri_agent_id })
          : project
      const runID =
        workItem.status === "pending"
          ? yield* launchApprovedCharter(planning, workItem, charterInput)
          : planning.active_run_id
      return {
        project: (yield* projects.get(project.id))!,
        charter,
        plan,
        work_item: workItem,
        run_id: runID,
        replayed: Boolean(existing),
      }
    })

    const start = Effect.fn("CompanyProjectExecution.start")(function* (input: {
      company_id?: string
      goal: string
      title?: string
      decision_request_id?: string
      session_id?: string
      provider_id?: string
      model_id?: string
      charter?: BoardProjectCharter
      execution_strategy?: ProjectExecutionStrategyValue
      seed_policy?: SeedPolicyFactsValue
      approval_preset?: ApprovalPreset
    }) {
      const charterInput = input.charter ? BoardProjectCharter.parse(input.charter) : undefined
      const existing = input.decision_request_id
        ? yield* projects.findByDecisionRequest(input.decision_request_id)
        : undefined
      if (existing?.goal !== undefined && existing.goal !== input.goal)
        throw new Error("Project start request is already bound to a different goal")
      if (existing?.active_run_id) return { project: existing, run_id: existing.active_run_id }
      if (existing) {
        const planner = (yield* projects.listWorkItems(existing.id)).find(
          (item) => item.kind === "planner" && item.status === "pending",
        )
        if (planner) {
          const run_id =
            existing.execution_strategy === "seed_and_grow"
              ? yield* startSeedWave(existing.id)
              : charterInput
                ? yield* launchApprovedCharter(existing, planner, charterInput, input.approval_preset)
                : yield* launchPlanner(existing, planner)
          if (!run_id) throw new Error(`Seed project ${existing.id} has no dispatchable AgentRun`)
          return { project: existing, run_id }
        }
        throw new Error(`Project start request ${input.decision_request_id} is incomplete and cannot be resumed`)
      }
      const execution = resolveNewExecution({ ...input, charter: charterInput })
      const selectedModel = yield* resolveModel(input)
      const session = input.session_id
        ? yield* sessions.get(SessionID.make(input.session_id))
        : yield* sessions.create({
            title: input.title ?? `项目：${input.goal.slice(0, 60)}`,
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
      if (!session) throw new Error(`Session not found: ${input.session_id}`)
      const project = yield* projects.create({
        company_id: input.company_id,
        decision_request_id: input.decision_request_id,
        goal: input.goal,
        title: input.title,
        owner_agent_id: charterInput?.dri_agent_id,
        coordinator_session_id: session.id,
        provider_id: selectedModel?.providerID,
        model_id: selectedModel?.modelID,
        execution_strategy: execution.execution_strategy,
        seed_mode: execution.verdict?.mode,
      })
      if (execution.shadow)
        yield* persistShadowSeedVerdict(project, execution.shadow).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
      if (project.execution_strategy === "seed_and_grow") {
        const verdict = execution.verdict!
        yield* persistSeedVerdict(project, verdict)
        if (charterInput && !(yield* projects.getCharter(project.id)))
          yield* projects.createCharter({
            project_id: project.id,
            title: charterInput.title,
            value: charterInput.value,
            deliverables: charterInput.deliverables,
            acceptance_criteria: charterInput.acceptance_criteria,
            scope: charterInput.scope,
            non_goals: charterInput.non_goals,
            constraints: charterInput.constraints,
            resources: charterInput.resources,
            risks: charterInput.risks,
            dri_agent_id: charterInput.dri_agent_id,
            milestones: charterInput.milestones,
            open_decisions: charterInput.open_decisions,
            success_criteria: charterInput.deliverables,
            policy: policyForApprovalPreset(input.approval_preset),
          })
        const team = yield* startSeedProject({
          project,
          verdict,
          projects,
          recruitment,
        })
        yield* projects.transition({
          id: project.id,
          status: "planning",
          actor_id: team.wayfinder?.owner_agent_id ?? team.builder.owner_agent_id,
        })
        yield* projects.transition({
          id: project.id,
          status: "executing",
          actor_id: team.wayfinder?.owner_agent_id ?? team.builder.owner_agent_id,
        })
        const run_id = yield* startSeedWave(project.id)
        if (
          verdict.mode === "discovery_first" &&
          !(yield* projects.listGates(project.id)).some(
            (gate) =>
              gate.kind === "risk_approval" &&
              gate.status === "pending" &&
              gate.work_item_id === team.builder.id &&
              JSON.stringify(gate.resource_scope) === JSON.stringify(team.builder.resource_scope),
          )
        )
          yield* projects.requestGate({
            project_id: project.id,
            kind: "risk_approval",
            title: "批准 First Slice Builder",
            summary: "Wayfinder 保持只读。批准后才会为 First Slice Builder 建立 Assignment 并启动执行。",
            requested_by_agent_id: team.wayfinder?.owner_agent_id ?? project.owner_agent_id,
            work_item_id: team.builder.id,
            resource_scope: team.builder.resource_scope,
          })
        if (!run_id) throw new Error(`Seed project ${project.id} has no dispatchable initial AgentRun`)
        return { project: (yield* projects.get(project.id))!, run_id }
      }
      const plan = yield* projects.createPlan({
        project_id: project.id,
        phase: "planning",
        summary: "形成项目范围与计划，并通过任务委派生成动态、依赖有序的任务树。",
        acceptance_criteria: ["任务领域中立", "角色按任务创建", "决策与资源范围不重叠", "所有叶子任务可独立验收"],
      })
      const item = yield* projects.createWorkItem({
        project_id: project.id,
        plan_id: plan.id,
        title: "定义项目范围与任务树",
        description: "定义目标边界、验收条件并分解动态执行任务，不实现叶子交付。",
        kind: "planner",
        work_type: "decision",
        role: "project-planner",
        capability_packs: ["product-charter@1"],
        decision_scope: ["项目范围与计划", "任务边界", "初始依赖关系"],
        resource_scope: ["artifacts/project-charter.json"],
        inputs: [input.goal],
        expected_outputs: ["项目范围与计划", "依赖有序的工作项"],
        validators: ["项目范围已具备启动条件", "每个工作项可独立验收"],
        disposition: "retain",
        model_group: "ultra",
        risk_level: "medium",
        review_status: "not_required",
        acceptance_criteria: ["项目范围完整", "任务树领域中立", "每个叶子任务有角色、模型组和验收条件"],
        max_attempts: 2,
      })
      const planner = yield* staffWorkItem({
        project,
        item,
        key: "project-planner",
        need_key: stableLogicalKey("project-planner"),
      })
      const planning = yield* projects.transition({
        id: project.id,
        status: "planning",
        actor_id: planner.owner_agent_id,
      })
      return {
        project: planning,
        run_id: charterInput
          ? yield* launchApprovedCharter(planning, planner, charterInput, input.approval_preset)
          : yield* launchPlanner(planning, planner),
      }
    })

    const cancel = Effect.fn("CompanyProjectExecution.cancel")(function* (input: {
      project_id: string
      reason?: string
    }) {
      const project = yield* projects.get(input.project_id)
      if (!project) throw new Error(`Company project not found: ${input.project_id}`)
      const reason = input.reason ?? "用户已取消当前执行"
      if (project.execution_strategy === "seed_and_grow") yield* blockProject(project.id, reason, false)
      const items = yield* projects.listWorkItems(project.id)
      yield* Effect.forEach(
        items.filter((item) => item.status === "running" && item.workflow_run_id),
        (item) =>
          Effect.gen(function* () {
            yield* runtime.cancel({ runID: item.workflow_run_id! })
            yield* projects.blockWorkItem({ id: item.id, error: reason })
          }),
        { concurrency: "unbounded", discard: true },
      )
      yield* blockProject(project.id, reason, false)
      return (yield* projects.get(project.id))!
    })

    const retry = Effect.fn("CompanyProjectExecution.retry")(function* (input: {
      project_id: string
      provider_id?: string
      model_id?: string
    }) {
      const project = yield* projects.get(input.project_id)
      if (!project) throw new Error(`Company project not found: ${input.project_id}`)
      if (project.status !== "blocked")
        throw new Error(`Company project ${project.id} cannot retry from ${project.status}`)
      const selectedModel = input.provider_id || input.model_id ? yield* resolveModel(input) : model(project)
      const updated = yield* projects.setModel({
        id: project.id,
        provider_id: selectedModel?.providerID,
        model_id: selectedModel?.modelID,
      })
      const items = yield* projects.listWorkItems(project.id)
      const blocked = items.filter((item) => item.status === "blocked" || item.status === "failed")
      const strandedReviewers = items.filter((item) => {
        if (item.kind !== "reviewer" || item.status !== "pending") return false
        const parentID = reviewedWorkItemID(item)
        const parent = parentID ? items.find((candidate) => candidate.id === parentID) : undefined
        return parent?.status === "running" && ["pending", "running"].includes(parent.review_status)
      })
      if (!blocked.length && !strandedReviewers.length)
        throw new Error(`Company project ${project.id} has no retryable work items`)
      yield* Effect.forEach(
        (yield* attention.list({ project_id: project.id, status: "open" })).filter(
          (record) =>
            record.material &&
            (record.allowed_actions.includes("retry") || record.allowed_actions.includes("resolve_blocker")),
        ),
        (record) =>
          attention.close({
            id: record.id,
            expected_version: record.version,
            resolution: "用户明确要求保留现有证据并重试受阻工作。",
          }),
        { concurrency: 1, discard: true },
      )
      const rejectedReviewers = [
        ...blocked.flatMap((reviewer) => {
          const workerID = reviewedWorkItemID(reviewer)
          if (reviewer.kind !== "reviewer" || !workerID) return []
          const worker = items.find((item) => item.id === workerID)
          return worker?.status === "completed" && worker.review_status === "rejected" ? [{ worker, reviewer }] : []
        }),
        ...blocked.flatMap((worker) => {
          if (worker.kind !== "worker" || worker.review_status !== "rejected") return []
          const reviewer = items.find(
            (item) => item.kind === "reviewer" && reviewedWorkItemID(item) === worker.id,
          )
          return reviewer && ["completed", "blocked", "failed"].includes(reviewer.status)
            ? [{ worker, reviewer }]
            : []
        }),
      ].filter(
        (pair, index, pairs) =>
          pairs.findIndex(
            (candidate) => candidate.worker.id === pair.worker.id && candidate.reviewer.id === pair.reviewer.id,
          ) === index,
      )
      yield* Effect.forEach(
        rejectedReviewers,
        ({ worker, reviewer }) => projects.reworkRejectedReview({ worker_id: worker.id, reviewer_id: reviewer.id }),
        { discard: true },
      )
      const reworkedReviewers = new Set(
        rejectedReviewers.flatMap(({ worker, reviewer }) => [worker.id, reviewer.id]),
      )
      yield* Effect.forEach(
        blocked.filter((item) => !reworkedReviewers.has(item.id)),
        (item) => projects.retryWorkItem(item.id),
        { discard: true },
      )
      const planner = blocked.find((item) => item.kind === "planner")
      const resumed = yield* projects.transition({
        id: project.id,
        status: planner ? "planning" : "executing",
        actor_id: "user",
        reason: "保留任务树和失败 Attempt，使用新一次执行继续项目",
      })
      const run_id = planner
        ? project.source_thread_id
          ? yield* launchApprovedCharter(
              resumed,
              { ...planner, status: "pending" },
              approvedCharterFromProject((yield* projects.getCharter(project.id))!),
            )
          : yield* launchPlanner(resumed, { ...planner, status: "pending" })
        : yield* startReadyWave(resumed.id)
      if (!run_id) throw new Error(`Company project ${project.id} has no ready work item after retry`)
      return { project: (yield* projects.get(updated.id))!, run_id }
    })

    const resolveGate = Effect.fn("CompanyProjectExecution.resolveGate")(function* (input: {
      gate_id: string
      decision: "approve" | "reject"
      note?: string
    }) {
      const gate = yield* projects.resolveGate({ id: input.gate_id, decision: input.decision, note: input.note })
      if (!gate.project_id) throw new Error(`Founder approval gate ${gate.id} cannot enter project execution`)
      const projectID = gate.project_id
      const project = yield* projects.get(projectID)
      if (!project) throw new Error(`Company project not found: ${projectID}`)
      if (input.decision === "reject") {
        if (gate.kind === "merge_approval") {
          yield* recruitment.releaseProject({
            ...(project.company_id ? { company_id: CompanyID.parse(project.company_id) } : {}),
            project_id: project.id,
          })
          yield* projects.transition({ id: project.id, status: "rejected", actor_id: "user", reason: input.note })
        }
        return { gate }
      }
      if (gate.kind === "risk_approval") {
        if (!gate.work_item_id || !gate.resource_scope.length)
          throw new Error(`Risk approval ${gate.id} has no WorkItem scope`)
        const approvedItem = (yield* projects.listWorkItems(project.id)).find((item) => item.id === gate.work_item_id)
        if (!approvedItem) throw new Error(`Risk approval ${gate.id} WorkItem is unavailable`)
        if (project.execution_strategy === "seed_and_grow" && approvedItem.purpose === "first_slice") {
          const verdict = yield* seedVerdict(project)
          yield* startSeedProject({
            project,
            verdict,
            projects,
            recruitment,
            authorize_builder_work_item_id: gate.work_item_id,
          })
        }
        const run_id = yield* startReadyWave(project.id)
        return run_id ? { gate, run_id } : { gate }
      }
      if (!gate.worktree_run_id) throw new Error("Merge approval has no worktree run")
      const merged = yield* projects.mergeWorktreeRun(gate.worktree_run_id)
      yield* projects.addArtifact({
        project_id: project.id,
        work_item_id: merged.work_item_id,
        kind: "merge_report",
        title: "主分支合并与复验报告",
        path: `artifacts/${merged.id}-merge.json`,
        content: JSON.stringify(merged, null, 2) + "\n",
        evidence: merged.verification,
        created_by_agent_id: gate.requested_by_agent_id,
      })
      const resumed = yield* projects.transition({ id: project.id, status: "reviewing", actor_id: "user" })
      const run_id = yield* startReadyWave(resumed.id)
      return run_id ? { gate, run_id } : { gate }
    })

    return Service.of({
      start,
      startFromCharter,
      replanFromCharter,
      retry,
      resolveGate,
      cancel,
      dispatchReady: startReadyWave,
    })
  }),
).pipe(Layer.provide(ReceiptProcessor.defaultLayer))

export const layer = serviceLayer.pipe(
  Layer.provide(CompanyAttention.defaultLayer),
  Layer.provide(CompanyValidationGate.defaultLayer),
  Layer.provide(acceptanceFactLayer),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AgentRun.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(CompanyProject.defaultLayer),
  Layer.provide(CompanyAgent.defaultLayer),
  Layer.provide(CompanyRecruitment.defaultLayer),
  Layer.provide(Conversation.defaultLayer),
  Layer.provide(Delegation.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Reputation.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(WorkType.defaultLayer),
  Layer.provide(WorkflowRuntime.defaultLayer),
)

export * as CompanyProjectExecution from "./execution"
