import z from "zod"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentRun } from "@/agent-run/agent-run"
import { CompanyAgent } from "@/company-agent"
import type { CompanyAgentID } from "@/company-agent/schema"
import { Delegation } from "@/delegation/delegation"
import type { SubTask } from "@/delegation/schema"
import { Provider } from "@/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import * as Reputation from "@/reputation/reputation"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import * as WorkType from "@/work-type/work-type"
import type { WorkTypeID } from "@/work-type/schema"
import { WorkflowRuntime } from "@/workflow/runtime"
import { CompanyProject } from "./company-project"
import type { ApprovalGate, Project, WorkItem } from "./schema"

const workTypes = ["coding", "decision", "research", "writing", "design", "analysis"] as const
const modelGroups = ["standard", "lite"] as const

const charterResult = z.object({
  summary: z.string(),
  scope: z.array(z.string()).min(1),
  success_criteria: z.array(z.string()).min(1),
  constraints: z.array(z.string()),
  acceptance_criteria: z.array(z.string()).min(1),
  assumptions: z.array(z.string()),
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

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "agent"

const terms = (value: string) =>
  new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length > 1),
  )

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

const workerScript = (goal: string, item: WorkItem, modelRef: string) =>
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
          `你独占的决策范围：${item.decision_scope.join("；") || "无"}`,
          `允许使用或修改的资源范围：${item.resource_scope.join("；") || "仅返回结构化交付物"}`,
          "只执行这一个叶子任务，不重新规划整个项目，不替其他子树做决定。",
          item.work_type === "coding"
            ? "在授权工作树内完成实现，并亲自运行测试、检查与构建；verificationCommands 必须填写可由宿主再次执行的真实命令。"
            : "返回符合当前 Work Type 结构的 submission，所有结论必须能被验收条件直接检查。",
        ].join("\n"),
      )}, ${json({
        companyAgentID: item.owner_agent_id,
        role: item.role,
        capabilityPacks: item.capability_packs,
        requiredRuntimeCapabilities: [
          "toolCalls",
          "structuredOutput",
          "workspaceRead",
          ...(item.work_type === "coding" ? ["workspaceWrite"] : []),
        ],
        permissionMode: item.work_type === "coding" ? "workspace_write" : "read_only",
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

const reviewerScript = (goal: string, item: WorkItem, parent: WorkItem, artifact: unknown, modelRef: string) =>
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
  }) => Effect.Effect<{ project: Project; run_id: string }>
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
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyProjectExecution") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const projects = yield* CompanyProject.Service
    const agents = yield* CompanyAgent.Service
    const delegation = yield* Delegation.Service
    const reputation = yield* Reputation.Service
    const runs = yield* AgentRun.Service
    const sessions = yield* Session.Service
    const runtime = yield* WorkflowRuntime.Service
    const workType = yield* WorkType.Service
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

    const createPlanner = Effect.fn("CompanyProjectExecution.createPlanner")(function* (project: Project) {
      const id = `project-${slug(project.id.slice(-12))}-planner`
      const existing = yield* agents.get(id as CompanyAgentID)
      if (existing) return existing
      return yield* agents.create({
        id,
        name: `${project.title} · 规划者`,
        lifecycle: "employee",
        description: "为当前项目创建 Charter、任务边界与动态角色，不执行叶子交付。",
        system_prompt: "你是临时项目规划者。你只规划、分解和重规划，不实现叶子任务。",
        model: "ultra",
        org_layer: "project",
        department: project.title,
        reports_to: "assistant",
        responsibilities: ["Project Charter", "任务分解", "决策边界", "动态组队"],
      })
    })

    const selectAgent = Effect.fn("CompanyProjectExecution.selectAgent")(function* (input: {
      project: Project
      key: string
      role: string
      work_type: (typeof workTypes)[number]
      model_group: "ultra" | "standard" | "lite"
      exclude?: string[]
    }) {
      const wanted = terms(`${input.role} ${input.work_type}`)
      const active = yield* runs.list({ companyProjectID: input.project.id, limit: 500 })
      const candidates = (yield* agents.list()).filter((agent) => !(input.exclude ?? []).includes(agent.id))
      const scored = yield* Effect.forEach(candidates, (agent) =>
        Effect.gen(function* () {
          const profile = terms(
            [agent.name, agent.description, ...(agent.skills ?? []), ...(agent.responsibilities ?? [])].join(" "),
          )
          const matches = [...wanted].filter((term) => profile.has(term)).length
          const load = active.filter(
            (run) => run.agentID === agent.id && ["queued", "starting", "running", "interrupting"].includes(run.state),
          ).length
          return { agent, score: matches * 20 + (yield* reputation.get(agent.id)).score - load * 10 }
        }),
      )
      const selected = scored.sort((left, right) => right.score - left.score)[0]
      if (selected && selected.score > 0) {
        yield* projects.recordEvent({
          project_id: input.project.id,
          type: "work_item.agent_selected",
          actor_id: selected.agent.id,
          data: { key: input.key, role: input.role, score: selected.score, source: "company_pool" },
        })
        return selected.agent
      }
      const id = `project-${slug(input.project.id.slice(-10))}-${slug(input.key)}-${slug(input.role)}`.slice(0, 72)
      const existing = yield* agents.get(id as CompanyAgentID)
      if (existing) return existing
      const created = yield* agents.create({
        id,
        name: input.role,
        lifecycle: "employee",
        description: `为“${input.project.title}”动态创建的 ${input.work_type} 角色。`,
        system_prompt: `你在当前项目中担任“${input.role}”。只完成被分配的叶子任务，不越过决策和资源边界。`,
        model: input.model_group,
        org_layer: "execution",
        department: input.project.title,
        responsibilities: [input.role, input.work_type],
      })
      yield* projects.recordEvent({
        project_id: input.project.id,
        type: "work_item.agent_selected",
        actor_id: created.id,
        data: { key: input.key, role: input.role, score: 0, source: "dynamic_hire" },
      })
      return created
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

    const failure = Effect.fn("CompanyProjectExecution.failure")(function* (item: WorkItem, error: string) {
      yield* projects.addArtifact({
        project_id: item.project_id,
        work_item_id: item.id,
        kind: "attempt_failure",
        title: `${item.title} · Attempt ${item.attempt + 1} 失败`,
        content: JSON.stringify({ error, attempt: item.attempt + 1 }, null, 2) + "\n",
        evidence: { error },
        created_by_agent_id: item.owner_agent_id,
      })
      const current = yield* projects.blockWorkItem({ id: item.id, error })
      yield* reputation.updateFromAdmission(
        item.owner_agent_id ?? item.role,
        false,
        [{ severity: "blocker" }],
        "project",
      )
      if (current.attempt < current.max_attempts) {
        yield* projects.retryWorkItem(current.id)
        yield* projects.recordEvent({
          project_id: item.project_id,
          type: "work_item.retry_scheduled",
          actor_id: item.owner_agent_id,
          data: { work_item_id: item.id, attempt: current.attempt + 1, reason: error },
        })
      }
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
        if (task.parentKey && !known.has(task.parentKey)) throw new Error(`Unknown or forward parentKey: ${task.parentKey}`)
        for (const dependency of task.dependsOn ?? [])
          if (!known.has(dependency)) throw new Error(`Unknown or forward dependency: ${dependency}`)
      })
      return keys
    }

    const startReadyWave: (project_id: string) => Effect.Effect<string | undefined> = Effect.fn(
      "CompanyProjectExecution.startReadyWave",
    )(function* (project_id: string) {
      const project = yield* projects.get(project_id)
      if (!project || ["completed", "rejected", "blocked", "awaiting_approval"].includes(project.status)) return
      const ready = (yield* projects.readyWorkItems(project_id)).filter((item) => item.kind !== "planner")
      if (!ready.length) {
        const items = yield* projects.listWorkItems(project_id)
        if (items.some((item) => item.status === "blocked" || item.status === "failed")) {
          yield* blockProject(project_id, "Project has exhausted a work-item retry budget")
          return
        }
        if (items.every((item) => item.status === "completed" || item.status === "cancelled"))
          yield* projects.transition({ id: project_id, status: "completed", actor_id: project.owner_agent_id ?? "system" })
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
              const parent = (yield* projects.listWorkItems(project.id)).find((candidate) => candidate.id === item.parent_id)
              if (!parent) throw new Error(`Reviewer parent not found: ${item.parent_id}`)
              const artifact = (yield* projects.listArtifacts(project.id)).find(
                (candidate) => candidate.work_item_id === parent.id && candidate.kind !== "attempt_failure",
              )
              if (!artifact) throw new Error(`Reviewer has no artifact for ${parent.id}`)
              yield* projects.setWorkItemReview({ id: parent.id, review_status: "running" })
              const worktree = parent.work_type === "coding"
                ? (yield* projects.listWorktreeRuns(project.id)).find((candidate) => candidate.work_item_id === parent.id)
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
                  ),
                  workspace: worktree?.directory,
                }),
                worktree,
              }
            }
            const worktree = item.work_type === "coding"
              ? yield* projects.createWorktreeRun({ project_id: project.id, work_item_id: item.id })
              : undefined
            if (worktree) yield* projects.startWorktreeRun({ id: worktree.id })
            return {
              item,
              runID: yield* startRuntime({
                project,
                item,
                script: workerScript(project.goal, item, agentModelRef(project, item.model_group)),
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
              yield* projects.addArtifact({
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
              yield* projects.completeWorkItem(item.id)
              yield* reputation.updateFromAdmission(item.owner_agent_id ?? item.role, true, [], "project")
              return
            }
            const parsed = reviewResult.parse(value)
            if (!item.parent_id) throw new Error(`Reviewer ${item.id} has no parent work item`)
            const parent = (yield* projects.listWorkItems(project.id)).find((candidate) => candidate.id === item.parent_id)
            if (!parent) throw new Error(`Reviewer parent not found: ${item.parent_id}`)
            yield* projects.addArtifact({
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
            if (!parsed.accepted) return yield* failure(item, parsed.findings.join("; ") || parsed.summary)
            yield* projects.completeWorkItem(item.id)
            yield* reputation.updateFromAdmission(item.owner_agent_id ?? item.role, true, [], "project")
            if (parent.work_type !== "coding") return
            const parentWorktree = worktree ?? (yield* projects.listWorktreeRuns(project.id)).find(
              (candidate) => candidate.work_item_id === parent.id,
            )
            if (!parentWorktree) throw new Error(`Coding reviewer has no worktree for ${parent.id}`)
            yield* projects.requestMergeApproval({
              id: parentWorktree.id,
              title: `批准合并：${parent.title}`,
              summary: `${parsed.summary}\n\n分支 ${parentWorktree.branch} 已通过 Work Type 验证、宿主命令与独立复核。`,
              requested_by_agent_id: item.owner_agent_id,
              review: parsed,
            })
            }).pipe(
              Effect.catchCause((cause) => failure(item, String(cause))),
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
    }) {
      const parsed = charterResult.parse(yield* outcome(input.runID))
      yield* projects.createCharter({
        project_id: input.project.id,
        scope: parsed.scope,
        success_criteria: parsed.success_criteria,
        constraints: parsed.constraints,
        acceptance_criteria: parsed.acceptance_criteria,
      })
      const tasks = yield* delegation.decompose({
        goal: input.project.goal,
        context: [
          `Project Charter: ${JSON.stringify(parsed)}`,
          "Use domain-neutral work types. Each task must own a non-overlapping decision scope and resource scope.",
          "The planner never implements and workers never redesign sibling tasks.",
        ].join("\n"),
        sessionID: input.project.coordinator_session_id!,
        delegatorAgentID: input.item.owner_agent_id!,
        actorAgentType: "general",
      })
      const keys = validateTasks(tasks)
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
      yield* projects.completeWorkItem(input.item.id)
      const plan = (yield* projects.listPlans(input.project.id)).at(-1)
      if (!plan) throw new Error("Project plan is missing")
      const created = new Map<string, { worker: WorkItem; reviewer: WorkItem }>()
      for (const [index, task] of tasks.entries()) {
        const key = keys[index]!
        const type = inferWorkType(task)
        const role = task.role ?? `${type} specialist`
        const group = modelGroups.includes(task.modelGroup ?? "standard") ? (task.modelGroup ?? "standard") : "standard"
        const owner = yield* selectAgent({ project: input.project, key, role, work_type: type, model_group: group })
        const dependencies = [
          ...(task.dependsOn ?? []).map((dependency) => created.get(dependency)!.reviewer.id),
          ...(task.parentKey ? [created.get(task.parentKey)!.reviewer.id] : []),
        ].filter((value, position, values) => values.indexOf(value) === position)
        const worker = yield* projects.createWorkItem({
          project_id: input.project.id,
          plan_id: plan.id,
          parent_id: task.parentKey ? created.get(task.parentKey)!.worker.id : input.item.id,
          title: task.summary.slice(0, 100),
          description: task.summary,
          kind: "worker",
          work_type: type,
          role,
          capability_packs: task.capabilityPacks?.length ? task.capabilityPacks : capabilityPacks(type),
          decision_scope: task.decisionScope?.length ? task.decisionScope : [task.summary],
          resource_scope: task.resourceScope?.length ? task.resourceScope : [`artifacts/${key}`],
          model_group: group,
          risk_level: task.riskLevel ?? (type === "coding" ? "high" : "medium"),
          review_status: "pending",
          owner_agent_id: owner.id,
          acceptance_criteria: [task.acceptanceCriteria],
          max_attempts: 2,
          depends_on: dependencies,
        })
        const reviewerRole = `${role} independent reviewer`
        const reviewer = yield* selectAgent({
          project: input.project,
          key: `${key}-review`,
          role: reviewerRole,
          work_type: type,
          model_group: task.riskLevel === "high" ? "ultra" : "standard",
          exclude: [owner.id],
        })
        created.set(key, {
          worker,
          reviewer: yield* projects.createWorkItem({
            project_id: input.project.id,
            plan_id: plan.id,
            parent_id: worker.id,
            title: `独立复核：${worker.title}`,
            description: `独立检查“${worker.title}”的交付物、证据和验收条件。`,
            kind: "reviewer",
            work_type: type,
            role: reviewerRole,
            capability_packs: ["independent-review@1"],
            decision_scope: [],
            resource_scope: worker.resource_scope,
            model_group: task.riskLevel === "high" ? "ultra" : "standard",
            risk_level: task.riskLevel ?? "medium",
            review_status: "not_required",
            owner_agent_id: reviewer.id,
            acceptance_criteria: worker.acceptance_criteria,
            max_attempts: 2,
            depends_on: [worker.id],
          }),
        })
      }
      yield* projects.setActiveRun({ id: input.project.id })
      yield* startReadyWave(input.project.id)
    })

    const launchPlanner: (project: Project, item: WorkItem) => Effect.Effect<string> = Effect.fn(
      "CompanyProjectExecution.launchPlanner",
    )(function* (project: Project, item: WorkItem) {
      const runID = yield* startRuntime({
        project,
        item,
        script: plannerScript(project.goal, item.owner_agent_id!, agentModelRef(project, "ultra")),
      })
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
        Effect.forkIn(scope),
      )
      return runID
    })

    const start = Effect.fn("CompanyProjectExecution.start")(function* (input: {
      goal: string
      title?: string
      session_id?: string
      provider_id?: string
      model_id?: string
    }) {
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
      })
      const planner = yield* createPlanner(project)
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
        model_group: "ultra",
        risk_level: "medium",
        review_status: "not_required",
        owner_agent_id: planner.id,
        acceptance_criteria: ["Charter 完整", "任务树领域中立", "每个叶子任务有角色、模型组和验收条件"],
        max_attempts: 2,
      })
      const planning = yield* projects.transition({ id: project.id, status: "planning", actor_id: planner.id })
      return { project: planning, run_id: yield* launchPlanner(planning, item) }
    })

    const cancel = Effect.fn("CompanyProjectExecution.cancel")(function* (input: {
      project_id: string
      reason?: string
    }) {
      const project = yield* projects.get(input.project_id)
      if (!project) throw new Error(`Company project not found: ${input.project_id}`)
      const reason = input.reason ?? "用户已取消当前执行"
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
      if (project.status !== "blocked") throw new Error(`Company project ${project.id} cannot retry from ${project.status}`)
      const selectedModel = input.provider_id || input.model_id ? yield* resolveModel(input) : model(project)
      const updated = yield* projects.setModel({
        id: project.id,
        provider_id: selectedModel?.providerID,
        model_id: selectedModel?.modelID,
      })
      const blocked = (yield* projects.listWorkItems(project.id)).filter(
        (item) => item.status === "blocked" || item.status === "failed",
      )
      if (!blocked.length) throw new Error(`Company project ${project.id} has no retryable work items`)
      yield* Effect.forEach(blocked, (item) => projects.retryWorkItem(item.id), { discard: true })
      const planner = blocked.find((item) => item.kind === "planner")
      const resumed = yield* projects.transition({
        id: project.id,
        status: planner ? "planning" : "executing",
        actor_id: "user",
        reason: "保留任务树和失败 Attempt，使用新一次执行继续项目",
      })
      const run_id = planner
        ? yield* launchPlanner(resumed, { ...planner, status: "pending" })
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
        if (gate.kind === "merge_approval")
          yield* projects.transition({ id: project.id, status: "rejected", actor_id: "user", reason: input.note })
        return { gate }
      }
      if (gate.kind === "risk_approval") {
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

    return Service.of({ start, retry, resolveGate, cancel })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CompanyProject.defaultLayer),
  Layer.provide(CompanyAgent.defaultLayer),
  Layer.provide(Delegation.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Reputation.defaultLayer),
  Layer.provide(AgentRun.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(WorkType.defaultLayer),
  Layer.provide(WorkflowRuntime.defaultLayer),
)

export * as CompanyProjectExecution from "./execution"
