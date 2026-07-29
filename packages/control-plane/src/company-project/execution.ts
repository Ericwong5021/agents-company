import z from "zod"
import { Context, Effect, Layer, Scope } from "effect"
import { CapabilityCatalog } from "@/capability/catalog"
import { CompanyAgent } from "@/company-agent"
import { CompanyAgentID } from "@/company-agent/schema"
import { CompanyRecruitment, stableLogicalKey } from "@/company-recruitment"
import * as CompanyRollout from "@/company-rollout/company-rollout"
import { CompanyID } from "@/company/schema"
import { Conversation } from "@/conversation"
import { ConversationThreadID } from "@/conversation/schema"
import { Delegation } from "@/delegation/delegation"
import { SubTask } from "@/delegation/schema"
import { Provider } from "@/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import * as Reputation from "@/reputation/reputation"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import * as WorkType from "@/work-type/work-type"
import type { WorkTypeID } from "@/work-type/schema"
import { WorkflowRuntime } from "@/workflow/runtime"
import {
  SeedPolicyFacts,
  type ProjectExecutionStrategy as ProjectExecutionStrategyValue,
  type SeedPolicyFacts as SeedPolicyFactsValue,
} from "@agents-company/shared/project-orchestration"
import { SeedPolicyVerdict, WayfinderReceipt } from "@/project-orchestrator/schema"
import { evaluateSeedPolicy } from "@/project-orchestrator/seed-policy"
import { startSeedProject, wayfinderWorkflow } from "@/project-orchestrator/seed-team"
import { ReceiptProcessor } from "@/project-orchestrator/receipt-processor"
import { CompanyProject } from "./company-project"
import {
  BoardProjectCharter,
  BoardProjectDecisionConflict,
  type ApprovalGate,
  type Artifact,
  type DeliveryPolicy,
  type Plan,
  type Project,
  type ProjectCharter,
  type WorkItem,
} from "./schema"

const workTypes = ["coding", "decision", "research", "writing", "design", "analysis"] as const
const modelGroups = ["standard", "lite"] as const

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
} satisfies Record<(typeof workTypes)[number], z.ZodType>

const reviewResult = z.object({
  accepted: z.boolean(),
  summary: z.string(),
  findings: z.array(z.string()),
  evidence_checked: z.array(z.string()),
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
    owner_agent_id?: string
    acceptance_criteria: string[]
    max_attempts: number
    depends_on: string[]
  },
) =>
  JSON.stringify({
    parent_id: item.parent_id,
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
    owner_agent_id: item.owner_agent_id,
    acceptance_criteria: item.acceptance_criteria,
    max_attempts: item.max_attempts,
    depends_on: [...new Set(item.depends_on)].sort(),
  }) ===
  JSON.stringify({
    parent_id: input.parent_id,
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
    owner_agent_id: input.owner_agent_id,
    acceptance_criteria: input.acceptance_criteria,
    max_attempts: input.max_attempts,
    depends_on: [...new Set(input.depends_on)].sort(),
  })

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

const capabilityPacks = (workType: (typeof workTypes)[number]) => {
  if (workType === "coding") return ["software-implementation@1"]
  if (workType === "decision") return ["board-strategy@1"]
  if (workType === "writing") return ["document-authoring@1"]
  if (workType === "design") return ["design-production@1"]
  return ["research-analysis@1"]
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

const plannerScript = (goal: string, agentID: string, modelRef: string) =>
  workflow(
    "company-project-charter",
    [
      `phase("形成领域中立 Project Charter")`,
      `const result = await agent(${json(
        [
          "你是 AgentCompany 的临时项目规划者，只负责定义目标边界与验收，不执行交付。",
          "根据目标形成领域中立 Charter。不要假设项目必须产出软件、浏览器、终端、游戏或 Git 仓库。",
          "只有目标明确要求软件实现时，才把软件开发写进范围。",
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
        label: "Project Charter",
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
    [`phase("接收董事会已批准 Project Charter")`, `return ${json({ accepted: true, charter })}`].join("\n"),
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

const workerPermission = (item: WorkItem, policy: DeliveryPolicy, writeApproved: boolean) => {
  if (item.work_type !== "coding") return "read_only" as const
  if (policy.source_approval_preset === "autonomous") return "full_access" as const
  if (policy.source_approval_preset === "strict" && !writeApproved) return "read_only" as const
  return "workspace_write" as const
}

const boardBiddingEvidenceRule = (item: WorkItem) =>
  /bidding|董事会/i.test(`${item.source_task_key ?? ""} ${item.title} ${item.description}`)
    ? "产品语义：Bidding 是已有 Group Session/Thread 内选择下一位发言者的机制，不是筛选 Thread 成员。董事会 Thread 可以包含全部固定董事；验收应检查实际产生高信号消息的 winner、选择或 pass 理由，以及全员 pass/预算结束，而不能把候选成员存在误判成其已经发言。"
    : undefined

const boardCloseoutWritebackRule = (item: WorkItem) =>
  item.source_task_key === "board_closeout_and_organization_decision"
    ? [
        `Control Plane 宿主写回协议事实：${JSON.stringify({
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
  "运行时语义：Control Plane 事实是在当前 WorkItem 启动前生成的快照，所以当前节点可能仍显示 pending、attempt 少 1，当前 Reviewer 也可能显示尚未启动。宿主随后负责把节点置为 running、持久化本次回答为 Artifact，并完成或阻塞节点；Agent 不应也不需要修改自己的状态。非 coding Worker 由宿主以 read_only 权限运行。不得仅因这种预运行快照、缺少自状态写入工具或没有另附未要求的系统级命令/网络审计而判定执行未发生。"

const reviewerRuntimeEvidenceRule =
  "当前回答本身就是本轮独立复核。不得要求当前 Reviewer 在启动前快照中已经 completed、已经有本轮 Artifact，或先由另一个 Reviewer 复核这次交付；accepted 后这些状态由宿主持久化。只验收 parent 叶子任务及其上游依赖，不得把尚未获准运行的下游 WorkItem 处于 pending 当作 parent 的缺陷，除非 parent 的 depends_on 明确包含它。"

const workerScript = (
  goal: string,
  item: WorkItem,
  modelRef: string,
  policy: DeliveryPolicy,
  writeApproved: boolean,
  evidence: unknown,
  reviewFeedback?: { artifact_id: string; summary: string; findings: string[]; evidence_checked: string[] },
) =>
  workflow(
    `company-project-worker-${item.work_type}`,
    [
      `phase(${json(`执行：${item.title}`)})`,
      `const result = await agent(${json(
        [
          `公司目标：${goal}`,
          `你的临时角色：${item.role}`,
          `任务：${item.description}`,
          `验收条件：\n- ${item.acceptance_criteria.join("\n- ")}`,
          `Control Plane 当前可验证事实：${JSON.stringify(evidence)}`,
          reviewFeedback
            ? `上一轮独立复核要求返工：${JSON.stringify(reviewFeedback)}。必须逐条回应 findings，并提交修正后的实际证据。`
            : undefined,
          boardBiddingEvidenceRule(item),
          boardCloseoutWritebackRule(item),
          workItemRuntimeEvidenceRule,
          `你独占的决策范围：${item.decision_scope.join("；") || "无"}`,
          `允许使用或修改的资源范围：${item.resource_scope.join("；") || "仅返回结构化交付物"}`,
          "只执行这一个叶子任务，不重新规划整个项目，不替其他子树做决定。",
          "如果当前事实包含上一次独立复核的 findings，本次必须针对 findings 返工，并用已经发生的 Control Plane 实体、状态和内容交付证据；不得把计划中的后续动作写成已完成。",
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
        permissionMode: workerPermission(item, policy, writeApproved),
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
  item: WorkItem,
  parent: WorkItem,
  artifact: unknown,
  modelRef: string,
  evidence: unknown,
) =>
  workflow(
    `company-project-review-${parent.work_type}`,
    [
      `phase(${json(`独立复核：${parent.title}`)})`,
      `const result = await agent(${json(
        [
          `公司目标：${goal}`,
          `被复核任务：${parent.title}`,
          `原验收条件：\n- ${parent.acceptance_criteria.join("\n- ")}`,
          `交付物：${JSON.stringify(artifact)}`,
          `Control Plane 当前可验证事实：${JSON.stringify(evidence)}`,
          boardBiddingEvidenceRule(parent),
          workItemRuntimeEvidenceRule,
          reviewerRuntimeEvidenceRule,
          "你没有参与原任务。只根据交付物、证据和验收条件判断，不因执行者自述而放宽标准。",
        ].join("\n"),
      )}, ${json({
        companyAgentID: item.owner_agent_id,
        role: item.role,
        capabilityPacks: ["independent-review@1"],
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
    goal: string
    title?: string
    session_id?: string
    provider_id?: string
    model_id?: string
    execution_strategy?: ProjectExecutionStrategyValue
    seed_policy?: SeedPolicyFactsValue
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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const projects = yield* CompanyProject.Service
    const agents = yield* CompanyAgent.Service
    const recruitment = yield* CompanyRecruitment.Service
    const conversation = yield* Conversation.Service
    const delegation = yield* Delegation.Service
    const reputation = yield* Reputation.Service
    const sessions = yield* Session.Service
    const runtime = yield* WorkflowRuntime.Service
    const workType = yield* WorkType.Service
    const receiptProcessor = yield* ReceiptProcessor.Service
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

    const evidenceSnapshot = Effect.fn("CompanyProjectExecution.evidenceSnapshot")(function* (project: Project) {
      const [items, artifacts, gates, charter, events] = yield* Effect.all([
        projects.listWorkItems(project.id),
        projects.listArtifacts(project.id),
        projects.listGates(project.id),
        projects.getCharter(project.id),
        projects.listEvents(project.id),
      ])
      const organization = project.company_id
        ? yield* recruitment.snapshot({
            company_id: CompanyID.parse(project.company_id),
          })
        : undefined
      const currentNeeds = organization?.needs.filter((need) => need.project_id === project.id) ?? []
      const currentNeedIDs = new Set(currentNeeds.map((need) => need.id))
      const teamSelections =
        organization?.selections.filter(
          (selection) => selection.project_id === project.id && currentNeedIDs.has(selection.capability_need_id),
        ) ?? []
      const selectedAgentIDs = new Set(
        teamSelections.filter((selection) => selection.decision === "selected").map((selection) => selection.agent_id),
      )
      const selectedAgentHistory =
        organization?.selections.filter(
          (selection) =>
            selection.project_id !== project.id &&
            selection.decision === "selected" &&
            selectedAgentIDs.has(selection.agent_id),
        ) ?? []
      const historyNeedIDs = new Set(selectedAgentHistory.map((selection) => selection.capability_need_id))
      const relatedSelectionIDs = new Set(
        [...teamSelections, ...selectedAgentHistory]
          .filter((selection) => selection.decision === "selected")
          .map((selection) => selection.id),
      )
      const selectedAgents = yield* Effect.forEach([...selectedAgentIDs], (id) => agents.get(CompanyAgentID.make(id)))
      const board =
        project.company_id && project.source_thread_id
          ? yield* Effect.gen(function* () {
              const companyID = CompanyID.parse(project.company_id!)
              const threadID = ConversationThreadID.parse(project.source_thread_id!)
              const principal = { kind: "agent" as const, id: project.owner_agent_id ?? "board-ceo" }
              return {
                thread: yield* conversation.getThread({ companyID, threadID, principal }),
                entries: (yield* conversation.pageEntries({ companyID, threadID, principal, limit: 100 })).items.map(
                  (entry) => {
                    if (entry.type === "message")
                      return {
                        type: entry.type,
                        id: entry.message.id,
                        author: entry.message.author,
                        body: entry.message.body.slice(0, 2_000),
                        signal_type: entry.message.signalType,
                      }
                    if (entry.type === "agent_message")
                      return {
                        type: entry.type,
                        id: entry.message.id,
                        round_num: entry.message.roundNum,
                        agent_id: entry.message.agentID,
                        status: entry.message.status,
                        body: entry.message.body.slice(0, 2_000),
                      }
                    return {
                      type: entry.type,
                      round_num: entry.bidding.roundNum,
                      state: entry.bidding.state,
                      winner_agent_id: entry.bidding.winnerAgentID,
                      bids: entry.bidding.bids,
                    }
                  },
                ),
              }
            }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined
      return {
        project: {
          id: project.id,
          status: project.status,
          root_need_id: project.root_need_id,
          source_thread_id: project.source_thread_id,
          decision_request_id: project.decision_request_id,
          dri_agent_id: project.owner_agent_id,
        },
        charter,
        board,
        work_items: items.map((item) => ({
          id: item.id,
          source_task_key: item.source_task_key,
          parent_id: item.parent_id,
          kind: item.kind,
          status: item.status,
          owner_agent_id: item.owner_agent_id,
          workflow_run_id: item.workflow_run_id,
          depends_on: item.depends_on,
          attempt: item.attempt,
          review_status: item.review_status,
          error: item.error,
          started_at: item.started_at,
          completed_at: item.completed_at,
          updated_at: item.updated_at,
        })),
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          work_item_id: artifact.work_item_id,
          kind: artifact.kind,
          title: artifact.title,
          content: artifact.content?.slice(0, artifact.kind === "attempt_failure" ? 2_000 : 8_000),
          evidence: artifact.evidence,
          created_at: artifact.created_at,
        })),
        gates: gates.map((gate) => ({ id: gate.id, kind: gate.kind, status: gate.status, title: gate.title })),
        work_item_reassignments: events
          .filter((event) => event.type === "work_item.reassigned")
          .map((event) => ({
            id: event.id,
            type: event.type,
            actor_id: event.actor_id ?? null,
            data: event.data,
            created_at: event.created_at,
          })),
        current_needs: currentNeeds.map((need) => ({
          id: need.id,
          project_id: need.project_id,
          need_key: need.need_key,
          role: need.role,
          work_type: need.work_type,
          capability_packs: need.capability_packs,
          risk_level: need.risk_level,
          demand_horizon: need.demand_horizon,
          department_key: need.department_key,
        })),
        team_selections: teamSelections.map((selection) => ({
          project_id: selection.project_id,
          capability_need_id: selection.capability_need_id,
          agent_id: selection.agent_id,
          decision: selection.decision,
          source: selection.source,
          lifecycle_at_selection: selection.lifecycle_at_selection,
          reason: selection.reason,
          released: Boolean(selection.time_released),
        })),
        selected_agents: selectedAgents.flatMap((agent) =>
          agent
            ? [
                {
                  id: agent.id,
                  name: agent.name,
                  lifecycle: agent.lifecycle,
                  role_key: agent.role_key,
                  description: agent.description,
                  department: agent.department,
                  responsibilities: agent.responsibilities,
                },
              ]
            : [],
        ),
        selected_agent_history: selectedAgentHistory.map((selection) => ({
          id: selection.id,
          project_id: selection.project_id,
          capability_need_id: selection.capability_need_id,
          agent_id: selection.agent_id,
          source: selection.source,
          lifecycle_at_selection: selection.lifecycle_at_selection,
          reason: selection.reason,
          released: Boolean(selection.time_released),
          time_created: selection.time_created,
        })),
        history_needs:
          organization?.needs
            .filter((need) => historyNeedIDs.has(need.id))
            .map((need) => ({
              id: need.id,
              project_id: need.project_id,
              need_key: need.need_key,
              role: need.role,
              work_type: need.work_type,
              capability_packs: need.capability_packs,
              risk_level: need.risk_level,
              demand_horizon: need.demand_horizon,
              department_key: need.department_key,
            })) ?? [],
        related_performances:
          organization?.performances
            .filter(
              (performance) =>
                selectedAgentIDs.has(performance.agent_id) && relatedSelectionIDs.has(performance.selection_id),
            )
            .map((performance) => ({
              id: performance.id,
              project_id: performance.project_id,
              selection_id: performance.selection_id,
              agent_id: performance.agent_id,
              outcome: performance.outcome,
              quality_score: performance.quality_score,
              reliability_score: performance.reliability_score,
              cost_score: performance.cost_score,
              speed_score: performance.speed_score,
              review_summary: performance.review_summary,
            })) ?? [],
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
      const message = yield* conversation.recordBoardDecision({
        companyID: CompanyID.parse(input.project.company_id!),
        threadID: ConversationThreadID.parse(input.project.source_thread_id!),
        principal: { kind: "agent", id: input.project.owner_agent_id! },
        requestID,
        projectScopeID: input.project.id,
        driAgentID: input.project.owner_agent_id!,
        body,
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
      return item
    })

    const blockProject = (project_id: string, error: string) =>
      Effect.gen(function* () {
        const project = yield* projects.get(project_id)
        if (project && !["completed", "rejected", "blocked"].includes(project.status))
          yield* projects.transition({ id: project_id, status: "blocked", actor_id: "system", reason: error })
        yield* projects.setActiveRun({ id: project_id })
      })

    const startRuntime = Effect.fn("CompanyProjectExecution.startRuntime")(function* (input: {
      project: Project
      item: WorkItem
      script: string
      workspace?: string
    }) {
      if (!input.project.coordinator_session_id) throw new Error("Project has no coordinator session")
      yield* projects.startWorkItem(input.item.id)
      const started = yield* runtime.start({
        script: input.script,
        sessionID: SessionID.make(input.project.coordinator_session_id),
        parentActorID: "main",
        model: model(input.project),
        workspace: input.workspace ?? input.project.output_dir,
        companyProjectID: input.project.id,
        workItemID: input.item.id,
        maxConcurrentAgents: 1,
        maxLifecycleAgents: 1,
        agentTimeoutMs: 2 * 60 * 60_000,
        scriptDeadlineMs: 3 * 60 * 60_000,
        notifyOnTerminal: false,
      })
      yield* projects.setWorkItemRun({ id: input.item.id, workflow_run_id: started.runID })
      yield* projects.setActiveRun({ id: input.project.id, run_id: started.runID })
      return started.runID
    })

    const failure = Effect.fn("CompanyProjectExecution.failure")(function* (
      item: WorkItem,
      error: string,
      scheduleRetry = true,
    ) {
      const attempt = item.attempt + 1
      const retryable = attempt < item.max_attempts
      yield* projects.addArtifact({
        project_id: item.project_id,
        work_item_id: item.id,
        kind: "attempt_failure",
        title: `${item.title} · Attempt ${attempt} 失败`,
        content:
          JSON.stringify(
            {
              attempt,
              error,
              impact: "当前 Work Item 未通过执行或验证，正式交付状态未推进。",
              retryable,
              next_adjustment: retryable ? "保留本次证据并按剩余重试预算调整下一次执行。" : "升级到项目 DRI。",
            },
            null,
            2,
          ) + "\n",
        evidence: { error, attempt, retryable },
        created_by_agent_id: item.owner_agent_id,
      })
      const current = yield* projects.blockWorkItem({ id: item.id, error })
      yield* reputation.updateFromAdmission(
        item.owner_agent_id ?? item.role,
        false,
        [{ severity: "blocker" }],
        "project",
      )
      if (scheduleRetry && current.attempt < current.max_attempts) {
        yield* projects.retryWorkItem(current.id)
        yield* projects.recordEvent({
          project_id: item.project_id,
          type: "work_item.retry_scheduled",
          actor_id: item.owner_agent_id,
          data: { work_item_id: item.id, attempt: current.attempt + 1, reason: error },
        })
      }
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
      const writeApproved = gates.some((gate) => gate.kind === "risk_approval" && gate.status === "approved")
      const gated = ready.filter(
        (item) =>
          item.purpose === "first_slice" &&
          item.work_type === "coding" &&
          charter.policy.source_approval_preset === "strict" &&
          !writeApproved,
      )
      const dispatchable = ready.filter((item) => !gated.some((candidate) => candidate.id === item.id))
      if (project.status !== "executing")
        yield* projects.transition({
          id: project.id,
          status: "executing",
          actor_id: project.owner_agent_id ?? "system",
        })
      const verdict = yield* seedVerdict(project)
      const evidence = yield* evidenceSnapshot(project)
      const started = yield* Effect.forEach(
        dispatchable,
        (item) =>
          Effect.gen(function* () {
            const worktree =
              item.work_type === "coding"
                ? yield* projects.createWorktreeRun({ project_id: project.id, work_item_id: item.id })
                : undefined
            if (worktree) yield* projects.startWorktreeRun({ id: worktree.id })
            return {
              item,
              runID: yield* startRuntime({
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
                        item,
                        agentModelRef(project, item.model_group),
                        charter.policy,
                        writeApproved,
                        evidence,
                      ),
                workspace: worktree?.directory,
              }),
              worktree,
            }
          }),
        { concurrency: 4 },
      )
      if (gated.length && !gates.some((gate) => gate.kind === "risk_approval" && gate.status === "pending"))
        yield* projects.requestGate({
          project_id: project.id,
          kind: "risk_approval",
          title: "批准 First Slice 写入项目工作区",
          summary: "Wayfinder 保持只读；继续后只允许 First Slice Builder 在隔离工作树内写入并运行验证。",
          requested_by_agent_id: project.owner_agent_id,
        })
      yield* Effect.gen(function* () {
        yield* Effect.forEach(
          started,
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
              const verification = yield* workType.verify(item.work_type as WorkTypeID, {
                submission: parsed.submission,
                orgLayer: "project",
              })
              const artifact = yield* projects.addArtifact({
                project_id: project.id,
                work_item_id: item.id,
                kind: item.work_type,
                title: item.title,
                path: `artifacts/${item.id}.json`,
                content: `${JSON.stringify(parsed, null, 2)}\n`,
                evidence: { work_type_verification: verification },
                created_by_agent_id: item.owner_agent_id,
              })
              if (!verification.passed) return yield* failure(item, verification.findings.join("; "))
              if (item.work_type !== "coding" || !worktree) {
                yield* projects.completeWorkItem(item.id)
                yield* reputation.updateFromAdmission(item.owner_agent_id ?? item.role, true, [], "project")
                return
              }
              const commands = submissions.coding.parse(parsed.submission).verificationCommands
              const verified = yield* projects.verifyWorktreeRun({ id: worktree.id, commands })
              if (verified.status !== "awaiting_merge_approval")
                return yield* failure(item, verified.error ?? "Host worktree verification failed")
              const gate = yield* projects.requestMergeApproval({
                id: worktree.id,
                title: `批准合并 First Slice：${item.title}`,
                summary: `${parsed.summary}\n\nFirst Slice 已通过 Work Type 与宿主验证，未预建 Reviewer。`,
                requested_by_agent_id: item.owner_agent_id,
                review: { mode: "seed_first_slice", artifact_id: artifact.id },
              })
              yield* projects.completeWorkItem(item.id)
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
      return started[0]?.runID
    })

    const startReadyWave: (project_id: string) => Effect.Effect<string | undefined> = Effect.fn(
      "CompanyProjectExecution.startReadyWave",
    )(function* (project_id: string) {
      const project = yield* projects.get(project_id)
      if (project?.execution_strategy === "seed_and_grow") return yield* startSeedWave(project_id)
      if (!project) return
      yield* receiptProcessor.shadowLegacy(project_id).pipe(Effect.catchCause(() => Effect.succeed([])))
      if (["completed", "rejected", "blocked", "awaiting_approval"].includes(project.status)) return
      const ready = (yield* projects.readyWorkItems(project_id)).filter((item) => item.kind !== "planner")
      if (!ready.length) {
        const items = yield* projects.listWorkItems(project_id)
        if (items.some((item) => item.status === "blocked" || item.status === "failed")) {
          yield* blockProject(project_id, "Project has exhausted a work-item retry budget")
          return
        }
        if (
          items.every(
            (item) => item.status === "completed" || item.status === "superseded" || item.status === "cancelled",
          )
        ) {
          yield* recruitment.releaseProject({
            ...(project.company_id ? { company_id: CompanyID.parse(project.company_id) } : {}),
            project_id: project.id,
          })
          yield* projects.transition({
            id: project_id,
            status: "completed",
            actor_id: project.owner_agent_id ?? "system",
          })
        }
        return
      }
      const charter = yield* projects.getCharter(project.id)
      if (!charter) throw new Error("Project Charter is missing")
      const gates = yield* projects.listGates(project.id)
      const evidence = yield* evidenceSnapshot(project)
      const writeApproved = gates.some((gate) => gate.kind === "risk_approval" && gate.status === "approved")
      if (
        charter.policy.source_approval_preset === "strict" &&
        ready.some((item) => item.kind === "worker" && item.work_type === "coding") &&
        !writeApproved
      ) {
        if (!gates.some((gate) => gate.kind === "risk_approval" && gate.status === "pending"))
          yield* projects.requestGate({
            project_id: project.id,
            kind: "risk_approval",
            title: "批准 Agent 写入项目工作区",
            summary:
              "当前公司使用“全部请求批准”。Agent 已完成只读规划，继续执行将允许其在隔离工作树中写入和运行验证命令。",
            requested_by_agent_id: project.owner_agent_id,
          })
        return
      }
      const nextStatus = ready.every((item) => item.kind === "reviewer") ? "reviewing" : "executing"
      if (project.status !== nextStatus)
        yield* projects.transition({ id: project.id, status: nextStatus, actor_id: project.owner_agent_id ?? "system" })
      const started = yield* Effect.forEach(
        ready,
        (item) =>
          Effect.gen(function* () {
            if (item.kind === "reviewer") {
              if (!item.parent_id) throw new Error(`Reviewer ${item.id} has no parent work item`)
              const parent = (yield* projects.listWorkItems(project.id)).find(
                (candidate) => candidate.id === item.parent_id,
              )
              if (!parent) throw new Error(`Reviewer parent not found: ${item.parent_id}`)
              const artifact = (yield* projects.listArtifacts(project.id)).findLast(
                (candidate) => candidate.work_item_id === parent.id && candidate.kind !== "attempt_failure",
              )
              if (!artifact) throw new Error(`Reviewer has no artifact for ${parent.id}`)
              yield* projects.setWorkItemReview({ id: parent.id, review_status: "running" })
              const worktree =
                parent.work_type === "coding"
                  ? (yield* projects.listWorktreeRuns(project.id)).findLast(
                      (candidate) => candidate.work_item_id === parent.id,
                    )
                  : undefined
              return {
                item,
                runID: yield* startRuntime({
                  project,
                  item,
                  script: reviewerScript(
                    project.goal,
                    item,
                    parent,
                    artifact.content ? JSON.parse(artifact.content) : artifact.evidence,
                    agentModelRef(project, parent.risk_level === "high" ? "ultra" : "standard"),
                    evidence,
                  ),
                  workspace: worktree?.directory,
                }),
                worktree,
              }
            }
            const reviewer = (yield* projects.listWorkItems(project.id)).find(
              (candidate) => candidate.kind === "reviewer" && candidate.parent_id === item.id,
            )
            const reviewArtifact = reviewer
              ? (yield* projects.listArtifacts(project.id)).findLast(
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
            const worktree =
              item.work_type === "coding"
                ? yield* projects.createWorktreeRun({ project_id: project.id, work_item_id: item.id })
                : undefined
            if (worktree) yield* projects.startWorktreeRun({ id: worktree.id })
            return {
              item,
              runID: yield* startRuntime({
                project,
                item,
                script: workerScript(
                  project.goal,
                  item,
                  agentModelRef(project, item.model_group),
                  charter.policy,
                  writeApproved,
                  evidence,
                  reviewFeedback,
                ),
                workspace: worktree?.directory,
              }),
              worktree,
            }
          }),
        { concurrency: 4 },
      )
      yield* Effect.gen(function* () {
        yield* Effect.forEach(
          started,
          ({ item, runID, worktree }) =>
            Effect.gen(function* () {
              const value = yield* outcome(runID)
              if (item.kind === "worker") {
                const parsed = z.object({ summary: z.string(), submission: submissions[item.work_type] }).parse(value)
                const verification = yield* workType.verify(item.work_type as WorkTypeID, {
                  submission: parsed.submission,
                  orgLayer: "project",
                })
                const artifact = yield* projects.addArtifact({
                  project_id: project.id,
                  work_item_id: item.id,
                  kind: item.work_type,
                  title: item.title,
                  path: `artifacts/${item.id}.json`,
                  content: JSON.stringify(parsed, null, 2) + "\n",
                  evidence: { work_type_verification: verification },
                  created_by_agent_id: item.owner_agent_id,
                })
                if (!verification.passed) return yield* failure(item, verification.findings.join("; "))
                if (item.work_type === "coding" && worktree) {
                  const commands = submissions.coding.parse(parsed.submission).verificationCommands
                  const verified = yield* projects.verifyWorktreeRun({ id: worktree.id, commands })
                  if (verified.status !== "awaiting_merge_approval")
                    return yield* failure(item, verified.error ?? "Host worktree verification failed")
                }
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
                yield* projects.completeWorkItem(item.id)
                yield* reputation.updateFromAdmission(item.owner_agent_id ?? item.role, true, [], "project")
                return
              }
              const parsed = reviewResult.parse(value)
              if (!item.parent_id) throw new Error(`Reviewer ${item.id} has no parent work item`)
              const parent = (yield* projects.listWorkItems(project.id)).find(
                (candidate) => candidate.id === item.parent_id,
              )
              if (!parent) throw new Error(`Reviewer parent not found: ${item.parent_id}`)
              const reviewArtifact = yield* projects.addArtifact({
                project_id: project.id,
                work_item_id: item.id,
                kind: "independent_review",
                title: item.title,
                path: `artifacts/${item.id}.json`,
                content: JSON.stringify(parsed, null, 2) + "\n",
                evidence: { evidence_checked: parsed.evidence_checked },
                created_by_agent_id: item.owner_agent_id,
              })
              yield* projects.setWorkItemReview({
                id: parent.id,
                review_status: parsed.accepted ? "accepted" : "rejected",
              })
              if (!parsed.accepted) {
                const error = parsed.findings.join("; ") || parsed.summary
                yield* projects.blockWorkItem({ id: item.id, error })
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
                return
              }
              yield* projects.completeWorkItem(item.id)
              yield* reputation.updateFromAdmission(item.owner_agent_id ?? item.role, true, [], "project")
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
        yield* projects.setActiveRun({ id: project.id })
        const current = yield* projects.get(project.id)
        if (current?.status !== "awaiting_approval") yield* startReadyWave(project.id)
      }).pipe(
        Effect.catchCause((cause) => blockProject(project.id, String(cause))),
        Effect.forkIn(scope),
      )
      return started[0]?.runID
    })

    const continuePlanner = Effect.fn("CompanyProjectExecution.continuePlanner")(function* (input: {
      project: Project
      item: WorkItem
      runID: string
      approvedCharter?: BoardProjectCharter
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
              non_goals: ["不执行 Charter 范围外工作"],
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
      })
      const tasks =
        savedProjection?.tasks ??
        (yield* delegation.decompose({
          goal: input.project.goal,
          context: [
            `Project Charter: ${JSON.stringify(parsed)}`,
            "Use domain-neutral work types. Each task must own a non-overlapping decision scope and resource scope.",
            "The planner never implements and workers never redesign sibling tasks.",
          ].join("\n"),
          sessionID: input.project.coordinator_session_id!,
          delegatorAgentID: input.item.owner_agent_id!,
          actorAgentType: "general",
        }))
      const keys = validateTasks(tasks)
      const sourceKeys = keys.map(stableLogicalKey)
      if (new Set(sourceKeys).size !== sourceKeys.length)
        throw new Error("Delegation task keys collapse to the same stable source key")
      const needKeys = sourceKeys.map((key) => ({
        worker: stableLogicalKey(`worker-${key}`),
        reviewer: stableLogicalKey(`reviewer-${key}`),
      }))
      if (new Set(needKeys.flatMap((key) => [key.worker, key.reviewer])).size !== needKeys.length * 2)
        throw new Error("Delegation capability need keys must be unique")
      if (!savedProjection)
        yield* projects.addArtifact({
          project_id: input.project.id,
          work_item_id: input.item.id,
          kind: "project_charter",
          title: "Project Charter 与动态任务计划",
          path: "artifacts/project-charter.json",
          content: JSON.stringify({ charter: parsed, tasks }, null, 2) + "\n",
          evidence: { task_count: tasks.length },
          created_by_agent_id: input.item.owner_agent_id,
        })
      const plan = (yield* projects.listPlans(input.project.id)).at(-1)
      if (!plan) throw new Error("Project plan is missing")
      const existingItems = yield* projects.listWorkItems(input.project.id)
      const created = new Map<string, { worker: WorkItem; reviewer: WorkItem }>()
      for (const [index, task] of tasks.entries()) {
        const key = keys[index]!
        const sourceKey = sourceKeys[index]!
        const type = inferWorkType(task)
        const role = task.role ?? `${type} specialist`
        const group = modelGroups.includes(task.modelGroup ?? "standard") ? (task.modelGroup ?? "standard") : "standard"
        const packs = executableCapabilityPacks(task.capabilityPacks ?? [], type)
        const risk = task.riskLevel ?? (type === "coding" ? "high" : "medium")
        const dependencies = [
          ...(task.dependsOn ?? []).map((dependency) => created.get(dependency)!.reviewer.id),
          ...(task.parentKey ? [created.get(task.parentKey)!.reviewer.id] : []),
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
          title: task.summary.slice(0, 100),
          description: task.summary,
          kind: "worker" as const,
          work_type: type,
          role,
          capability_packs: packs,
          decision_scope: task.decisionScope?.length ? task.decisionScope : [task.summary],
          resource_scope: task.resourceScope?.length ? task.resourceScope : [`artifacts/${key}`],
          inputs: [`Project Charter ${input.project.id}`, task.summary],
          expected_outputs: [task.acceptanceCriteria],
          validators: [task.acceptanceCriteria],
          disposition: "retain",
          model_group: group,
          risk_level: risk,
          review_status: "pending" as const,
          owner_agent_id: existingWorker?.owner_agent_id,
          acceptance_criteria: [task.acceptanceCriteria],
          max_attempts: 2,
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
        const reviewerRole = `${role} independent reviewer`
        const reviewerGroup = task.riskLevel === "high" ? "ultra" : "standard"
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
                item.parent_id === worker.id &&
                item.role === reviewerRole,
            )
        if (legacyReviewers.length > 1) throw new Error(`Ambiguous legacy reviewer projection for ${key}`)
        const existingReviewer = keyedReviewer ?? legacyReviewers[0]
        const reviewerInput = {
          project_id: input.project.id,
          plan_id: plan.id,
          source_task_key: sourceKey,
          parent_id: worker.id,
          title: `独立复核：${worker.title}`,
          description: `独立检查“${worker.title}”的交付物、证据和验收条件。`,
          kind: "reviewer" as const,
          work_type: type,
          role: reviewerRole,
          capability_packs: ["independent-review@1"],
          decision_scope: [],
          resource_scope: worker.resource_scope,
          inputs: [`Work Item ${worker.id} 的交付物与验证证据`],
          expected_outputs: ["独立复核结论与可操作 findings"],
          validators: worker.acceptance_criteria,
          disposition: "retain",
          model_group: reviewerGroup as "ultra" | "standard",
          risk_level: risk,
          review_status: "not_required" as const,
          owner_agent_id: existingReviewer?.owner_agent_id,
          acceptance_criteria: worker.acceptance_criteria,
          max_attempts: 2,
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
      })
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
    ) => Effect.Effect<string> = Effect.fn("CompanyProjectExecution.launchApprovedCharter")(function* (
      project: Project,
      item: WorkItem,
      charter: BoardProjectCharter,
    ) {
      const runID = yield* startRuntime({
        project,
        item,
        script: approvedCharterScript(charter),
      })
      yield* Effect.gen(function* () {
        yield* continuePlanner({
          project,
          item: { ...item, attempt: item.attempt + 1 },
          runID,
          approvedCharter: charter,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* failure(item, String(cause))
              const current = (yield* projects.listWorkItems(project.id)).find((candidate) => candidate.id === item.id)
              if (current?.status === "pending") {
                yield* launchApprovedCharter(project, current, charter)
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
            (gate) => gate.kind === "risk_approval" && gate.status === "pending",
          )
        )
          yield* projects.requestGate({
            project_id: project.id,
            kind: "risk_approval",
            title: "批准 First Slice Builder",
            summary: "Wayfinder 保持只读。批准后才会为 First Slice Builder 建立 Assignment 并启动执行。",
            requested_by_agent_id: team.wayfinder?.owner_agent_id ?? project.owner_agent_id,
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
          summary: "依据董事会已批准 Charter 拆解可执行 Work Items。",
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
            title: "拆解已批准 Charter",
            description: "保持董事会批准的范围与验收不变，将 Charter 拆成依赖有序的执行与独立复核任务。",
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
            expected_outputs: ["依赖有序的 worker/reviewer Work Items"],
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
      goal: string
      title?: string
      session_id?: string
      provider_id?: string
      model_id?: string
      execution_strategy?: ProjectExecutionStrategyValue
      seed_policy?: SeedPolicyFactsValue
    }) {
      const execution = resolveNewExecution(input)
      const selectedModel = yield* resolveModel(input)
      const session = input.session_id
        ? yield* sessions.get(SessionID.make(input.session_id))
        : yield* sessions.create({
            title: input.title ?? `项目：${input.goal.slice(0, 60)}`,
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
      if (!session) throw new Error(`Session not found: ${input.session_id}`)
      const project = yield* projects.create({
        goal: input.goal,
        title: input.title,
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
            (gate) => gate.kind === "risk_approval" && gate.status === "pending",
          )
        )
          yield* projects.requestGate({
            project_id: project.id,
            kind: "risk_approval",
            title: "批准 First Slice Builder",
            summary: "Wayfinder 保持只读。批准后才会为 First Slice Builder 建立 Assignment 并启动执行。",
            requested_by_agent_id: team.wayfinder?.owner_agent_id ?? project.owner_agent_id,
          })
        if (!run_id) throw new Error(`Seed project ${project.id} has no dispatchable initial AgentRun`)
        return { project: (yield* projects.get(project.id))!, run_id }
      }
      const plan = yield* projects.createPlan({
        project_id: project.id,
        phase: "planning",
        summary: "形成 Project Charter，并通过 Delegation 生成动态、依赖有序的任务树。",
        acceptance_criteria: ["任务领域中立", "角色按任务创建", "决策与资源范围不重叠", "所有叶子任务可独立验收"],
      })
      const item = yield* projects.createWorkItem({
        project_id: project.id,
        plan_id: plan.id,
        title: "定义 Charter 与任务树",
        description: "定义目标边界、验收条件并分解动态执行任务，不实现叶子交付。",
        kind: "planner",
        work_type: "decision",
        role: "project-planner",
        capability_packs: ["product-charter@1"],
        decision_scope: ["Project Charter", "任务边界", "初始依赖关系"],
        resource_scope: ["artifacts/project-charter.json"],
        inputs: [input.goal],
        expected_outputs: ["Project Charter", "依赖有序的 Work Items"],
        validators: ["Charter Definition of Ready", "每个 Work Item 可独立验收"],
        disposition: "retain",
        model_group: "ultra",
        risk_level: "medium",
        review_status: "not_required",
        acceptance_criteria: ["Charter 完整", "任务树领域中立", "每个叶子任务有角色、模型组和验收条件"],
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
      return { project: planning, run_id: yield* launchPlanner(planning, planner) }
    })

    const cancel = Effect.fn("CompanyProjectExecution.cancel")(function* (input: {
      project_id: string
      reason?: string
    }) {
      const project = yield* projects.get(input.project_id)
      if (!project) throw new Error(`Company project not found: ${input.project_id}`)
      const reason = input.reason ?? "用户已取消当前执行"
      if (project.execution_strategy === "seed_and_grow") yield* blockProject(project.id, reason)
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
      yield* blockProject(project.id, reason)
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
      if (!blocked.length) throw new Error(`Company project ${project.id} has no retryable work items`)
      const rejectedReviewers = blocked.flatMap((reviewer) => {
        if (reviewer.kind !== "reviewer" || !reviewer.parent_id) return []
        const worker = items.find((item) => item.id === reviewer.parent_id)
        return worker?.status === "completed" && worker.review_status === "rejected" ? [{ worker, reviewer }] : []
      })
      yield* Effect.forEach(
        rejectedReviewers,
        ({ worker, reviewer }) => projects.reworkRejectedReview({ worker_id: worker.id, reviewer_id: reviewer.id }),
        { discard: true },
      )
      const reworkedReviewers = new Set(rejectedReviewers.map(({ reviewer }) => reviewer.id))
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
      const project = yield* projects.get(gate.project_id)
      if (!project) throw new Error(`Company project not found: ${gate.project_id}`)
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
        if (project.execution_strategy === "seed_and_grow") {
          const verdict = yield* seedVerdict(project)
          yield* startSeedProject({
            project,
            verdict,
            projects,
            recruitment,
            authorize_builder: true,
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

    return Service.of({ start, startFromCharter, retry, resolveGate, cancel, dispatchReady: startReadyWave })
  }),
).pipe(Layer.provide(ReceiptProcessor.defaultLayer))

export const defaultLayer = layer.pipe(
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
