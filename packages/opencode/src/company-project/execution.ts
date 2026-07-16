import z from "zod"
import fs from "fs/promises"
import { Context, Effect, Layer, Scope } from "effect"
import { CompanyAgent } from "@/company-agent"
import type { CompanyAgentID } from "@/company-agent/schema"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { WorkflowRuntime } from "@/workflow/runtime"
import { CompanyProject } from "./company-project"
import type { ApprovalGate, Project } from "./schema"

const researchUnit = z.object({
  title: z.string(),
  summary: z.string(),
  findings: z
    .array(
      z.object({
        claim: z.string(),
        evidence: z.string(),
        source_url: z.string().url(),
      }),
    )
    .min(1),
  risks: z.array(z.string()),
  recommendation: z.string(),
})

const proposal = z.object({
  title: z.string(),
  executive_summary: z.string(),
  recommendation: z.enum(["go", "no_go"]),
  target_user: z.string(),
  product_concept: z.string(),
  delivery_surface: z.enum(["browser", "terminal"]),
  mvp_scope: z.array(z.string()),
  non_goals: z.array(z.string()),
  risks: z.array(z.string()),
  success_metrics: z.array(z.string()),
  evidence_summary: z.array(z.string()),
})

const researchResult = z.object({
  market: researchUnit,
  product: researchUnit,
  technical: researchUnit,
  proposal,
})

const productBrief = z.object({
  product_name: z.string(),
  problem: z.string(),
  target_user: z.string(),
  core_loop: z.array(z.string()),
  user_stories: z.array(z.string()),
  functional_requirements: z.array(z.string()),
  non_functional_requirements: z.array(z.string()),
  non_goals: z.array(z.string()),
})

const architecture = z.object({
  delivery_surface: z.enum(["browser", "terminal"]),
  stack: z.array(z.string()),
  modules: z.array(z.object({ name: z.string(), responsibility: z.string() })),
  repository_layout: z.array(z.string()),
  run_commands: z.array(z.string()),
  test_strategy: z.array(z.string()),
  risks: z.array(z.string()),
})

const qaPlan = z.object({
  acceptance_criteria: z.array(z.string()),
  automated_tests: z.array(z.string()),
  smoke_tests: z.array(z.string()),
  playtest_scenarios: z.array(z.string()),
  release_gate: z.array(z.string()),
})

const developmentBrief = z.object({
  summary: z.string(),
  implementation_order: z.array(z.string()),
  definition_of_done: z.array(z.string()),
})

const planningResult = z.object({ prd: productBrief, architecture, qa: qaPlan, development_brief: developmentBrief })

const verification = z.object({
  passed: z.boolean(),
  summary: z.string(),
  commands: z.array(z.object({ command: z.string(), result: z.string() })),
  failures: z.array(z.string()),
  playtest_notes: z.array(z.string()),
})

const developmentResult = z.object({
  implementation: z.string(),
  attempts: z.number(),
  verification,
})

const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: "draft-7" })
const json = (value: unknown) => JSON.stringify(value)
const workflow = (name: string, body: string) =>
  [`export const meta = ${json({ name, description: `AgentCompany project stage: ${name}` })}`, body].join("\n")

async function verifyRepository(repo: string, plan: z.infer<typeof architecture>) {
  if (!(await Bun.file(`${repo}/.git/HEAD`).exists()))
    throw new Error("Host verification: repository is not a Git repository")
  if (!(await fs.readdir(repo)).some((file) => /^readme(?:\.|$)/i.test(file))) {
    throw new Error("Host verification: README is missing")
  }
  if (!plan.run_commands.some((command) => !/\b(test|check|build|install)\b/i.test(command))) {
    throw new Error("Host verification: no start command was declared")
  }
  const commands = plan.run_commands.filter((command) => /\b(test|check|build)\b/i.test(command))
  if (!commands.length) throw new Error("Host verification: no test, check, or build command was declared")
  const evidence = [] as Array<{ command: string; exit_code: number; output: string }>
  for (const command of commands) {
    const child = Bun.spawn(["/bin/sh", "-lc", command], { cwd: repo, stdout: "pipe", stderr: "pipe" })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const result = await Promise.race([
      child.exited.then((exit_code) => ({ exit_code, timed_out: false })),
      Bun.sleep(5 * 60 * 1000).then(() => ({ exit_code: -1, timed_out: true })),
    ])
    if (result.timed_out) child.kill()
    const output = `${await stdout}\n${await stderr}`.trim().slice(-8000)
    if (result.timed_out) throw new Error(`Host verification timed out: ${command}`)
    if (result.exit_code !== 0) throw new Error(`Host verification failed: ${command}\n${output}`)
    evidence.push({ command, exit_code: result.exit_code, output })
  }
  return { git: true, readme: true, start_command: true, commands: evidence }
}

const RESEARCH_TEAM = [
  {
    id: "project-lead",
    name: "项目负责人",
    description: "对项目目标、计划、团队组合、质量和升级负责",
    prompt: "你是 AgentCompany 的项目负责人。你必须综合证据，明确做或不做，并对最终交付负责。",
    responsibilities: ["目标澄清", "动态组队", "计划与重规划", "综合决策"],
  },
  {
    id: "market-researcher",
    name: "市场研究员",
    description: "进行有来源的市场、竞品和用户需求研究",
    prompt: "你是严谨的市场研究员。必须使用联网工具核验信息，区分事实、推断和假设，并保留来源 URL。",
    responsibilities: ["市场研究", "竞品分析", "证据核验"],
  },
  {
    id: "game-product-strategist",
    name: "游戏产品策略师",
    description: "定义用户、核心玩法循环、MVP 边界和产品价值",
    prompt: "你是小游戏产品策略师。优先发现可验证的核心乐趣，主动压缩范围，拒绝用功能数量代替可玩性。",
    responsibilities: ["产品机会", "核心玩法", "MVP 范围"],
  },
  {
    id: "technical-researcher",
    name: "技术研究员",
    description: "研究交付形态、技术栈、实现风险和验证方式",
    prompt: "你是技术研究员。你的建议必须能在独立仓库里安装、启动、测试和试玩，优先简单可靠的实现。",
    responsibilities: ["技术可行性", "技术选型", "交付风险"],
  },
] as const

const DEVELOPMENT_TEAM = [
  {
    id: "product-manager",
    name: "产品经理",
    description: "将已批准立项转化为可验收的 PRD",
    prompt: "你是 MVP 产品经理。把研究结论变成明确用户故事、需求和非目标，每条都可验收。",
    responsibilities: ["PRD", "需求边界", "用户故事"],
  },
  {
    id: "software-architect",
    name: "软件架构师",
    description: "为极简可试玩 MVP 设计可执行技术方案",
    prompt: "你是务实的软件架构师。选择最少依赖、最短启动路径和清晰测试边界，不做超前架构。",
    responsibilities: ["架构", "仓库结构", "运行与测试方案"],
  },
  {
    id: "qa-engineer",
    name: "QA 工程师",
    description: "独立验证安装、测试、启动和实际可玩性",
    prompt: "你是独立 QA。必须亲自运行命令和试玩关键路径；没有命令证据不得判定通过。",
    responsibilities: ["验收标准", "自动化测试", "启动冒烟", "试玩"],
  },
  {
    id: "mvp-developer",
    name: "MVP 开发负责人",
    description: "在独立仓库中完成可启动、可测试、可试玩的产品",
    prompt:
      "你是自主开发负责人。直接操作当前项目仓库，持续运行测试，直到满足 Definition of Done。不得修改 AgentCompany 源仓库。",
    responsibilities: ["实现", "测试", "文档", "本地 Git 交付"],
  },
  {
    id: "repair-engineer",
    name: "修复工程师",
    description: "根据 QA 证据定位并修复阻塞缺陷",
    prompt: "你是修复工程师。只根据可复现失败修改代码，每次修复后运行相关测试，不隐藏失败。",
    responsibilities: ["缺陷定位", "最小修复", "回归测试"],
  },
] as const

function researchScript(goal: string) {
  const unitSchema = json(schema(researchUnit))
  const proposalSchema = json(schema(proposal))
  return workflow(
    "company-project-research",
    [
      `const goal = ${json(goal)}`,
      `phase("并行市场、产品与技术研究")`,
      `const reports = await parallel([`,
      `  () => agent("围绕目标开展市场与竞品研究：" + goal + "。联网查证，输出具体来源 URL；判断真实需求、现有产品、机会和风险。", { companyAgentID: "market-researcher", tools: ["websearch", "webfetch"], schema: ${unitSchema}, label: "市场研究", phase: "Research" }),`,
      `  () => agent("围绕目标开展用户与玩法研究：" + goal + "。定义目标用户、核心乐趣、最小可玩循环和应砍掉的范围；必要时联网核验。", { companyAgentID: "game-product-strategist", tools: ["websearch", "webfetch"], schema: ${unitSchema}, label: "产品机会", phase: "Research" }),`,
      `  () => agent("围绕目标开展技术可行性研究：" + goal + "。比较浏览器与终端交付，选择可在独立仓库安装、测试、启动、试玩的最简路线，并给出来源。", { companyAgentID: "technical-researcher", tools: ["websearch", "webfetch"], schema: ${unitSchema}, label: "技术研究", phase: "Research" }),`,
      `])`,
      `if (reports.some((report) => !report)) throw new Error("research specialist failed")`,
      `phase("负责人综合立项建议")`,
      `const proposal = await agent("你是项目负责人。根据以下三份报告独立判断是否应该立项。不要迎合预设；若立项，必须自行选择 browser 或 terminal，并定义极简可试玩 MVP。\\n目标：" + goal + "\\n报告：" + JSON.stringify(reports), { companyAgentID: "project-lead", schema: ${proposalSchema}, label: "立项建议", phase: "Synthesis" })`,
      `if (!proposal) throw new Error("proposal synthesis failed")`,
      `return { market: reports[0], product: reports[1], technical: reports[2], proposal }`,
    ].join("\n"),
  )
}

function planningScript(goal: string, proposalArtifact: unknown) {
  const proposalText = json(proposalArtifact)
  return workflow(
    "company-project-planning",
    [
      `const goal = ${json(goal)}`,
      `const approved = ${proposalText}`,
      `phase("并行产品、架构与验收设计")`,
      `const plans = await parallel([`,
      `  () => agent("根据已批准立项制作极简 MVP PRD。目标：" + goal + "\\n立项：" + JSON.stringify(approved), { companyAgentID: "product-manager", schema: ${json(schema(productBrief))}, label: "PRD", phase: "Plan" }),`,
      `  () => agent("根据已批准立项制作可直接开发的架构。必须是独立 Git 仓库，可安装、启动、测试和试玩。目标：" + goal + "\\n立项：" + JSON.stringify(approved), { companyAgentID: "software-architect", schema: ${json(schema(architecture))}, label: "架构", phase: "Plan" }),`,
      `  () => agent("根据已批准立项定义独立验收计划，覆盖安装、自动化测试、启动冒烟和实际试玩。目标：" + goal + "\\n立项：" + JSON.stringify(approved), { companyAgentID: "qa-engineer", schema: ${json(schema(qaPlan))}, label: "QA 计划", phase: "Plan" }),`,
      `])`,
      `if (plans.some((plan) => !plan)) throw new Error("planning specialist failed")`,
      `const brief = await agent("作为项目负责人，综合 PRD、架构和 QA 计划，给出开发顺序和不可妥协的 Definition of Done。\\n" + JSON.stringify(plans), { companyAgentID: "project-lead", schema: ${json(schema(developmentBrief))}, label: "开发计划", phase: "Synthesis" })`,
      `if (!brief) throw new Error("development brief failed")`,
      `return { prd: plans[0], architecture: plans[1], qa: plans[2], development_brief: brief }`,
    ].join("\n"),
  )
}

function developmentScript(goal: string, context: unknown) {
  const qaSchema = json(schema(verification))
  return workflow(
    "company-project-development",
    [
      `const goal = ${json(goal)}`,
      `const context = ${json(context)}`,
      `phase("实现可试玩 MVP")`,
      `const implementation = await agent("在当前独立 Git 仓库中完成 MVP。你拥有开发阶段自主权。严格依据以下上下文实现，但可为完成目标修正细节。必须创建 README、依赖清单、源代码和自动化测试；亲自安装依赖、运行测试、启动冒烟。禁止修改仓库外文件、付费、注册账号、公开部署或发布。\\n目标：" + goal + "\\n上下文：" + JSON.stringify(context), { companyAgentID: "mvp-developer", role: "implementation-engineer", capabilityPacks: ["software-implementation@1"], requiredRuntimeCapabilities: ["toolCalls", "workspaceWrite"], permissionMode: "workspace_write", label: "实现 MVP", phase: "Develop", timeoutMs: 7200000 })`,
      `if (!implementation) throw new Error("implementation agent failed")`,
      `let attempts = 0`,
      `let verification`,
      `while (attempts < 3) {`,
      `  attempts++`,
      `  phase("独立 QA 验证 #" + attempts)`,
      `  verification = await agent("你是独立 QA。检查当前仓库并亲自执行测试、构建和启动冒烟。必须记录真实命令结果；任何关键项未验证都判定 passed=false。\\n验收上下文：" + JSON.stringify(context), { companyAgentID: "qa-engineer", role: "verification-engineer", capabilityPacks: ["verification-testing@1"], requiredRuntimeCapabilities: ["toolCalls", "structuredOutput"], permissionMode: "read_only", schema: ${qaSchema}, label: "QA #" + attempts, phase: "Verify", timeoutMs: 1800000 })`,
      `  if (verification && verification.passed) break`,
      `  if (attempts >= 3) break`,
      `  phase("根据 QA 证据修复")`,
      `  const repair = await agent("根据以下 QA 失败证据修复当前仓库。只做可复现的必要修改，修复后运行相关测试。\\n" + JSON.stringify(verification), { companyAgentID: "repair-engineer", role: "repair-engineer", capabilityPacks: ["software-implementation@1"], requiredRuntimeCapabilities: ["toolCalls", "workspaceWrite"], permissionMode: "workspace_write", label: "修复 #" + attempts, phase: "Repair", timeoutMs: 3600000 })`,
      `  if (!repair) throw new Error("repair agent failed")`,
      `}`,
      `if (!verification) throw new Error("verification agent failed")`,
      `return { implementation, attempts, verification }`,
    ].join("\n"),
  )
}

export interface Interface {
  readonly start: (input: {
    goal: string
    title?: string
    session_id?: string
    provider_id?: string
    model_id?: string
  }) => Effect.Effect<{ project: Project; run_id: string }>
  readonly resolveGate: (input: {
    gate_id: string
    decision: "approve" | "reject"
    note?: string
  }) => Effect.Effect<{ gate: ApprovalGate; run_id?: string }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CompanyProjectExecution") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const projects = yield* CompanyProject.Service
    const agents = yield* CompanyAgent.Service
    const sessions = yield* Session.Service
    const runtime = yield* WorkflowRuntime.Service
    const scope = yield* Scope.Scope

    const ensureTeam = (members: typeof RESEARCH_TEAM | typeof DEVELOPMENT_TEAM) =>
      Effect.forEach(
        members,
        (member) =>
          Effect.gen(function* () {
            if (yield* agents.get(member.id as CompanyAgentID)) return
            yield* agents.create({
              id: member.id,
              name: member.name,
              description: member.description,
              system_prompt: member.prompt,
              org_layer: member.id === "project-lead" ? "project" : "execution",
              department: "临时项目组",
              reports_to: member.id === "project-lead" ? "assistant" : "project-lead",
              responsibilities: [...member.responsibilities],
              lifecycle: "employee",
            })
          }),
        { concurrency: 1, discard: true },
      )

    const model = (project: Project) =>
      project.provider_id && project.model_id
        ? { providerID: ProviderID.make(project.provider_id), modelID: ModelID.make(project.model_id) }
        : undefined

    const block = (project_id: string, error: string) =>
      Effect.gen(function* () {
        const items = yield* projects.listWorkItems(project_id)
        yield* Effect.forEach(
          items.filter((item) => item.status === "running"),
          (item) => projects.blockWorkItem({ id: item.id, error }).pipe(Effect.ignoreCause),
          { discard: true },
        )
        const project = yield* projects.get(project_id)
        if (project && !["completed", "rejected", "blocked"].includes(project.status)) {
          yield* projects
            .transition({ id: project_id, status: "blocked", actor_id: "project-lead", reason: error })
            .pipe(Effect.ignoreCause)
        }
      })

    const launch = <A>(input: {
      project: Project
      script: string
      workspace?: string
      onSuccess: (result: unknown) => Effect.Effect<A>
    }) =>
      Effect.gen(function* () {
        if (!input.project.coordinator_session_id) throw new Error("Project has no coordinator session")
        const startRun = () =>
          runtime.start({
            script: input.script,
            sessionID: SessionID.make(input.project.coordinator_session_id!),
            parentActorID: "main",
            model: model(input.project),
            workspace: input.workspace,
            maxConcurrentAgents: 4,
            maxLifecycleAgents: 20,
            agentTimeoutMs: 60 * 60 * 1000,
            scriptDeadlineMs: 12 * 60 * 60 * 1000,
            notifyOnTerminal: false,
          })
        const watch: (run_id: string, attempt: number) => Effect.Effect<void> = (run_id, attempt) =>
          runtime.wait({ runID: run_id }).pipe(
            Effect.flatMap((outcome) => {
              if (outcome.status === "completed") return input.onSuccess(outcome.result).pipe(Effect.asVoid)
              if (outcome.status === "cancelled") return block(input.project.id, "Workflow cancelled")
              return Effect.fail(new Error(outcome.error))
            }),
            Effect.catchCause((cause) => {
              if (attempt >= 3) return block(input.project.id, String(cause))
              return Effect.gen(function* () {
                yield* Effect.sleep(`${attempt} seconds`)
                const next = yield* startRun()
                yield* projects.setActiveRun({ id: input.project.id, run_id: next.runID })
                yield* watch(next.runID, attempt + 1)
              })
            }),
          )
        const started = yield* startRun()
        yield* projects.setActiveRun({ id: input.project.id, run_id: started.runID })
        yield* watch(started.runID, 1).pipe(
          Effect.ensuring(projects.setActiveRun({ id: input.project.id }).pipe(Effect.ignoreCause)),
          Effect.forkIn(scope),
        )
        return started.runID
      })

    const startPlanning = Effect.fn("CompanyProjectExecution.startPlanning")(function* (project: Project) {
      yield* ensureTeam(DEVELOPMENT_TEAM)
      const approved = (yield* projects.listArtifacts(project.id)).find((item) => item.kind === "project_proposal")
      if (!approved?.content) throw new Error("Approved project proposal is missing")
      const approvedProposal = proposal.parse(JSON.parse(approved.content))
      const plan = yield* projects.createPlan({
        project_id: project.id,
        phase: "development",
        summary: "将已批准立项转化为 PRD、架构、验收计划和开发顺序",
        acceptance_criteria: ["PRD 可验收", "架构可执行", "QA 覆盖安装、测试、启动和试玩"],
      })
      const items = yield* Effect.all([
        projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "MVP PRD",
          description: "定义用户、核心循环、需求和非目标",
          kind: "product",
          owner_agent_id: "product-manager",
          acceptance_criteria: ["需求可验收", "范围足够小"],
        }),
        projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "技术架构",
          description: "定义交付形态、技术栈、仓库和命令",
          kind: "architecture",
          owner_agent_id: "software-architect",
          acceptance_criteria: ["可独立启动", "可自动测试"],
        }),
        projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "QA 计划",
          description: "定义自动化、冒烟与试玩验收",
          kind: "qa_plan",
          owner_agent_id: "qa-engineer",
          acceptance_criteria: ["包含真实命令", "包含完整试玩路径"],
        }),
      ])
      yield* Effect.forEach(items, (item) => projects.startWorkItem(item.id), { discard: true })
      return yield* launch({
        project,
        script: planningScript(project.goal, approvedProposal),
        onSuccess: (value) =>
          Effect.gen(function* () {
            const result = planningResult.parse(value)
            if (result.architecture.delivery_surface !== approvedProposal.delivery_surface) {
              throw new Error(
                `Architecture changed the approved delivery surface from ${approvedProposal.delivery_surface} to ${result.architecture.delivery_surface}`,
              )
            }
            const artifacts = [
              [items[0], "prd", "MVP PRD", "artifacts/product/prd.json", result.prd, "product-manager"],
              [
                items[1],
                "architecture",
                "技术架构",
                "artifacts/engineering/architecture.json",
                result.architecture,
                "software-architect",
              ],
              [items[2], "qa_plan", "QA 计划", "artifacts/verification/qa-plan.json", result.qa, "qa-engineer"],
            ] as const
            yield* Effect.forEach(
              artifacts,
              ([item, kind, title, artifactPath, content, author]) =>
                Effect.gen(function* () {
                  yield* projects.addArtifact({
                    project_id: project.id,
                    work_item_id: item.id,
                    kind,
                    title,
                    path: artifactPath,
                    content: JSON.stringify(content, null, 2) + "\n",
                    created_by_agent_id: author,
                  })
                  yield* projects.completeWorkItem(item.id)
                }),
              { discard: true },
            )
            yield* projects.addArtifact({
              project_id: project.id,
              kind: "development_brief",
              title: "开发计划",
              path: "artifacts/engineering/development-brief.json",
              content: JSON.stringify(result.development_brief, null, 2) + "\n",
              created_by_agent_id: "project-lead",
            })
            yield* projects.requestGate({
              project_id: project.id,
              kind: "development_approval",
              title: "批准开始开发",
              summary: `${result.development_brief.summary}\n\n交付形态：${result.architecture.delivery_surface}\n技术栈：${result.architecture.stack.join("、")}\n运行命令：\n- ${result.architecture.run_commands.join("\n- ")}\n\nDefinition of Done:\n- ${result.development_brief.definition_of_done.join("\n- ")}`,
              requested_by_agent_id: "project-lead",
            })
          }),
      })
    })

    const startDevelopment = Effect.fn("CompanyProjectExecution.startDevelopment")(function* (project: Project) {
      yield* ensureTeam(DEVELOPMENT_TEAM)
      const artifacts = yield* projects.listArtifacts(project.id)
      const context = Object.fromEntries(
        artifacts
          .filter(
            (item) =>
              ["project_proposal", "prd", "architecture", "qa_plan", "development_brief"].includes(item.kind) &&
              item.content,
          )
          .map((item) => [item.kind, JSON.parse(item.content!)]),
      )
      const architecturePlan = architecture.parse(context.architecture)
      const plan = (yield* projects.listPlans(project.id)).at(-1)
      if (!plan) throw new Error("Development plan is missing")
      const coding = yield* projects.createWorkItem({
        project_id: project.id,
        plan_id: plan.id,
        title: "实现可试玩 MVP",
        description: "在独立仓库实现、测试、文档化并提交 MVP",
        kind: "implementation",
        owner_agent_id: "mvp-developer",
        acceptance_criteria: ["可安装", "测试通过", "可启动", "可试玩", "README 完整"],
      })
      const qa = yield* projects.createWorkItem({
        project_id: project.id,
        plan_id: plan.id,
        title: "独立交付验收",
        description: "运行自动化、冒烟和实际试玩",
        kind: "verification",
        owner_agent_id: "qa-engineer",
        acceptance_criteria: ["命令证据完整", "完整试玩路径通过"],
        depends_on: [coding.id],
      })
      const worktree = yield* projects.createWorktreeRun({ project_id: project.id, work_item_id: coding.id })
      yield* projects.startWorktreeRun({ id: worktree.id })
      yield* projects.startWorkItem(coding.id)
      return yield* launch({
        project,
        workspace: worktree.directory,
        script: developmentScript(project.goal, context),
        onSuccess: (value) =>
          Effect.gen(function* () {
            const result = developmentResult.parse(value)
            if (!result.verification.passed) {
              throw new Error(result.verification.failures.join("; ") || result.verification.summary)
            }
            const hostVerification = yield* projects.verifyWorktreeRun({
              id: worktree.id,
              commands: architecturePlan.run_commands.filter((command) => /\b(test|check|build)\b/i.test(command)),
            })
            if (hostVerification.status !== "awaiting_merge_approval")
              throw new Error(hostVerification.error ?? "Worktree verification failed")
            yield* projects.addArtifact({
              project_id: project.id,
              work_item_id: coding.id,
              kind: "repository",
              title: "可试玩 MVP 代码仓库",
              path: "repo",
              evidence: {
                implementation: result.implementation,
                attempts: result.attempts,
                worktree_run_id: worktree.id,
                branch: worktree.branch,
              },
              created_by_agent_id: "mvp-developer",
            })
            yield* projects.completeWorkItem(coding.id)
            yield* projects.startWorkItem(qa.id)
            yield* projects.addArtifact({
              project_id: project.id,
              work_item_id: qa.id,
              kind: "verification_report",
              title: "独立 QA 验收报告",
              path: "artifacts/verification/final.json",
              content: JSON.stringify({ agent: result.verification, host: hostVerification.verification }, null, 2) + "\n",
              evidence: { agent_commands: result.verification.commands, host: hostVerification.verification },
              created_by_agent_id: "qa-engineer",
            })
            yield* projects.completeWorkItem(qa.id)
            yield* projects.transition({ id: project.id, status: "verifying", actor_id: "qa-engineer" })
            yield* projects.requestMergeApproval({
              id: worktree.id,
              title: "批准合并已验证交付",
              summary: `分支 ${worktree.branch} 已通过独立 QA 与宿主验证。批准后会合并到 main，并重新执行相同验证命令。`,
              requested_by_agent_id: "project-lead",
              review: { agent: result.verification, host: hostVerification.verification },
            })
          }),
      })
    })

    const start = Effect.fn("CompanyProjectExecution.start")(function* (input: {
      goal: string
      title?: string
      session_id?: string
      provider_id?: string
      model_id?: string
    }) {
      yield* ensureTeam(RESEARCH_TEAM)
      const session = input.session_id
        ? yield* sessions.get(SessionID.make(input.session_id))
        : yield* sessions.create({
            title: input.title ?? `项目：${input.goal.slice(0, 60)}`,
            companyAgentID: "project-lead" as CompanyAgentID,
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
      const project = yield* projects.create({
        goal: input.goal,
        title: input.title,
        owner_agent_id: "project-lead",
        coordinator_session_id: session.id,
        provider_id: input.provider_id,
        model_id: input.model_id,
      })
      yield* projects.createCharter({
        project_id: project.id,
        scope: [input.goal],
        success_criteria: ["交付物可在本地独立验证", "范围、证据与审批链完整"],
        constraints: ["禁止公开部署或发布", "禁止绕过运行时权限与人工合并审批"],
        acceptance_criteria: ["代码位于独立 Git 工作树", "验证证据已持久化", "主分支复验通过"],
      })
      yield* projects.transition({ id: project.id, status: "researching", actor_id: "project-lead" })
      const plan = yield* projects.createPlan({
        project_id: project.id,
        phase: "research",
        summary: "并行验证市场机会、核心玩法和技术可行性，再由负责人独立做立项判断",
        acceptance_criteria: ["结论有来源", "负责人明确 go/no-go", "自行选择交付形态", "定义极简可试玩范围"],
      })
      const research = yield* Effect.all([
        projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "市场与竞品研究",
          description: "验证需求、竞品、机会和风险",
          kind: "research",
          owner_agent_id: "market-researcher",
          acceptance_criteria: ["包含来源 URL", "区分事实与推断"],
        }),
        projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "用户与玩法研究",
          description: "定义用户、核心乐趣和最小循环",
          kind: "research",
          owner_agent_id: "game-product-strategist",
          acceptance_criteria: ["核心循环可试玩", "明确非目标"],
        }),
        projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "技术可行性研究",
          description: "比较交付形态并选择最简可靠路线",
          kind: "research",
          owner_agent_id: "technical-researcher",
          acceptance_criteria: ["可安装、测试、启动", "明确技术风险"],
        }),
      ])
      const synthesis = yield* projects.createWorkItem({
        project_id: project.id,
        plan_id: plan.id,
        title: "产品立项建议",
        description: "综合证据并做 go/no-go 决策",
        kind: "synthesis",
        owner_agent_id: "project-lead",
        acceptance_criteria: ["明确建议", "MVP 范围", "成功指标"],
        depends_on: research.map((item) => item.id),
      })
      yield* Effect.forEach(research, (item) => projects.startWorkItem(item.id), { discard: true })
      const current = (yield* projects.get(project.id))!
      const run_id = yield* launch({
        project: current,
        script: researchScript(current.goal),
        onSuccess: (value) =>
          Effect.gen(function* () {
            const result = researchResult.parse(value)
            const reports = [
              [
                research[0],
                "market_report",
                "市场与竞品研究",
                "artifacts/research/market.json",
                result.market,
                "market-researcher",
              ],
              [
                research[1],
                "product_research",
                "用户与玩法研究",
                "artifacts/research/product.json",
                result.product,
                "game-product-strategist",
              ],
              [
                research[2],
                "technical_report",
                "技术可行性研究",
                "artifacts/research/technical.json",
                result.technical,
                "technical-researcher",
              ],
            ] as const
            yield* Effect.forEach(
              reports,
              ([item, kind, title, artifactPath, content, author]) =>
                Effect.gen(function* () {
                  yield* projects.addArtifact({
                    project_id: project.id,
                    work_item_id: item.id,
                    kind,
                    title,
                    path: artifactPath,
                    content: JSON.stringify(content, null, 2) + "\n",
                    evidence: {
                      sources: content.findings.flatMap((finding) => (finding.source_url ? [finding.source_url] : [])),
                    },
                    created_by_agent_id: author,
                  })
                  yield* projects.completeWorkItem(item.id)
                }),
              { discard: true },
            )
            yield* projects.startWorkItem(synthesis.id)
            yield* projects.addArtifact({
              project_id: project.id,
              work_item_id: synthesis.id,
              kind: "project_proposal",
              title: "产品立项建议",
              path: "artifacts/product/proposal.json",
              content: JSON.stringify(result.proposal, null, 2) + "\n",
              created_by_agent_id: "project-lead",
            })
            yield* projects.completeWorkItem(synthesis.id)
            yield* projects.requestGate({
              project_id: project.id,
              kind: "project_approval",
              title: "批准产品立项",
              summary: `${result.proposal.executive_summary}\n\n建议：${result.proposal.recommendation}\n交付形态：${result.proposal.delivery_surface}\nMVP：\n- ${result.proposal.mvp_scope.join("\n- ")}`,
              requested_by_agent_id: "project-lead",
            })
          }),
      })
      return { project: current, run_id }
    })

    const resolveGate = Effect.fn("CompanyProjectExecution.resolveGate")(function* (input: {
      gate_id: string
      decision: "approve" | "reject"
      note?: string
    }) {
      const gate = yield* projects.resolveGate({ id: input.gate_id, decision: input.decision, note: input.note })
      if (gate.kind === "merge_approval") {
        const project = yield* projects.get(gate.project_id)
        if (!project) throw new Error(`Company project not found: ${gate.project_id}`)
        if (input.decision === "reject") {
          yield* projects.transition({ id: project.id, status: "developing", actor_id: "user", reason: input.note })
          return { gate }
        }
        if (!gate.worktree_run_id) throw new Error("Merge approval has no worktree run")
        const merged = yield* projects.mergeWorktreeRun(gate.worktree_run_id)
        yield* projects.addArtifact({
          project_id: project.id,
          kind: "merge_report",
          title: "主分支合并与复验报告",
          path: "artifacts/verification/merge.json",
          content: JSON.stringify(merged, null, 2) + "\n",
          evidence: merged.verification,
          created_by_agent_id: "project-lead",
        })
        yield* projects.transition({ id: project.id, status: "completed", actor_id: "project-lead" })
        return { gate }
      }
      if (input.decision === "reject") return { gate }
      const project = yield* projects.get(gate.project_id)
      if (!project) throw new Error(`Company project not found: ${gate.project_id}`)
      const run_id = gate.kind === "project_approval" ? yield* startPlanning(project) : yield* startDevelopment(project)
      return { gate, run_id }
    })

    return Service.of({ start, resolveGate })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CompanyProject.defaultLayer),
  Layer.provide(CompanyAgent.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(WorkflowRuntime.defaultLayer),
)

export * as CompanyProjectExecution from "./execution"
