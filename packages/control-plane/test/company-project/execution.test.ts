import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AgentRun } from "../../src/agent-run/agent-run"
import { AgentRunSupervisor } from "../../src/agent-run/supervisor"
import { CompanyAgent } from "../../src/company-agent"
import { CompanyAgentID } from "../../src/company-agent/schema"
import { CompanyProject, CompanyProjectExecution } from "../../src/company-project"
import { CompanyRecruitment } from "../../src/company-recruitment"
import { ApprovalPolicyTable, CompanyTable } from "../../src/company/company.sql"
import { CompanyID } from "../../src/company/schema"
import { Conversation } from "../../src/conversation"
import { BOARD_CHANNEL_ID, LOCAL_USER_ID } from "../../src/conversation/conversation.sql"
import { Delegation } from "../../src/delegation/delegation"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as Reputation from "../../src/reputation/reputation"
import { Session } from "../../src/session"
import { Database } from "../../src/storage"
import * as WorkType from "../../src/work-type/work-type"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, type Item, type Reply } from "../lib/llm-server"
import { makeLayer, providerCfg } from "../workflow/lib"

afterEach(async () => {
  await Instance.disposeAll()
})

const dependencies = Layer.mergeAll(
  makeLayer(AgentRunSupervisor.defaultLayer),
  CompanyProject.defaultLayer,
  CompanyRecruitment.defaultLayer,
  Conversation.defaultLayer,
  Delegation.defaultLayer,
  Reputation.defaultLayer,
  AgentRun.defaultLayer,
  WorkType.defaultLayer,
)
const it = testEffect(Layer.mergeAll(dependencies, CompanyProjectExecution.layer.pipe(Layer.provide(dependencies))))

const match = (needle: string) => (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes(needle)

const containsText = (value: unknown, needle: string): boolean =>
  typeof value === "string"
    ? value.includes(needle)
    : Array.isArray(value)
      ? value.some((item) => containsText(item, needle))
      : Boolean(
          value &&
            typeof value === "object" &&
            Object.values(value).some((item) => containsText(item, needle)),
        )

const seedCompany = (companyID: CompanyID) =>
  Effect.sync(() => {
    const now = Date.now()
    Database.use((db) =>
      db
        .insert(CompanyTable)
        .values({
          id: companyID,
          name: "Execution Test Company",
          data_version: 1,
          default_provider_id: ProviderID.make("test"),
          default_model_id: ModelID.make("test-model"),
          bootstrap_request_id: crypto.randomUUID(),
          bootstrap_input_path: "/tmp/execution-test-company",
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .run(),
    )
  })

const provideGlobalTestProvider = <A, E, R>(dir: string, url: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const previous = Global.Path.config
      const config = path.join(dir, "global-config")
      await fs.mkdir(config, { recursive: true })
      await Bun.write(
        path.join(config, "provider-settings.json"),
        JSON.stringify({
          ...providerCfg(url),
          model: "test/test-model",
          model_groups: {
            ultra: "test/test-model",
            standard: "test/test-model",
            lite: "test/test-model",
          },
        }),
      )
      ;(Global.Path as { config: string }).config = config
      return previous
    }),
    () => effect,
    (previous) => Effect.sync(() => void ((Global.Path as { config: string }).config = previous)),
  )

const queueAdaptiveAnalysis = (llm: {
  pushMatch: (
    match: (hit: { url: URL; body: Record<string, unknown> }) => boolean,
    ...input: (Item | Reply)[]
  ) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    yield* llm.pushMatch(
      match("临时项目规划者"),
      reply()
        .text(
          JSON.stringify({
            summary: "分析本地证据并形成可复核结论",
            scope: ["分析给定证据"],
            success_criteria: ["结论可由证据复核"],
            constraints: ["不创建软件产品"],
            acceptance_criteria: ["方法、发现、结论与限制完整"],
            assumptions: [],
          }),
        )
        .stop(),
    )
    yield* llm.pushMatch(
      match("task decomposition specialist"),
      reply().tool("StructuredOutput", {
        subtasks: [
          {
            key: "independent_review_and_acceptance",
            summary: "分析现有证据并形成结论",
            acceptanceCriteria: "列出数据源、方法、发现、结论和限制",
            workType: "analysis",
            role: "evidence analyst",
            capabilityPacks: ["research-analysis"],
            decisionScope: ["证据含义"],
            resourceScope: ["artifacts/evidence-analysis"],
            modelGroup: "lite",
            riskLevel: "low",
            dependsOn: [],
          },
        ],
      }),
    )
    yield* llm.pushMatch(
      match("只执行这一个叶子任务"),
      reply()
        .text(
          JSON.stringify({
            summary: "证据分析完成",
            submission: {
              question: "证据说明了什么",
              dataSources: ["Project Charter", "本地输入"],
              methodology: "对输入进行结构化归类，并将每个结论映射回对应证据。",
              findings: ["现有证据支持继续完成限定范围内的分析交付。"],
              conclusions: ["交付满足领域中立的分析目标。"],
              limitations: ["没有外部数据集"],
            },
          }),
        )
        .stop(),
    )
    yield* llm.pushMatch(
      match("你没有参与原任务"),
      reply()
        .text(
          JSON.stringify({
            accepted: true,
            summary: "交付物满足验收条件",
            findings: [],
            evidence_checked: ["方法", "发现", "结论", "限制"],
          }),
        )
        .stop(),
    )
  })

describe.serial("CompanyProject adaptive execution", () => {
  it.live(
    "creates a dynamic planner-worker-reviewer tree and completes without fixed approval stages",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          return yield* provideGlobalTestProvider(
            dir,
            llm.url,
            Effect.gen(function* () {
              yield* queueAdaptiveAnalysis(llm)
              const execution = yield* CompanyProjectExecution.Service
              const projects = yield* CompanyProject.Service
              const started = yield* execution.start({
                goal: "分析本地证据并产出一份可复核结论",
                provider_id: "test",
                model_id: "test-model",
              })
              const completed = yield* Effect.gen(function* () {
                for (let attempt = 0; attempt < 300; attempt++) {
                  const current = yield* projects.get(started.project.id)
                  if (current?.status === "completed") return current
                  if (current?.status === "blocked") {
                    const items = yield* projects.listWorkItems(current.id)
                    throw new Error(
                      `adaptive project blocked: ${JSON.stringify(items.map((item) => ({ title: item.title, error: item.error })))}`,
                    )
                  }
                  yield* Effect.sleep("50 millis")
                }
                const current = yield* projects.get(started.project.id)
                const items = yield* projects.listWorkItems(started.project.id)
                const runService = yield* AgentRun.Service
                const runs = yield* runService.list({ companyProjectID: started.project.id })
                throw new Error(
                  `adaptive project did not complete: ${JSON.stringify({
                    project: current?.status,
                    items: items.map((item) => ({
                      title: item.title,
                      kind: item.kind,
                      status: item.status,
                      review: item.review_status,
                      run: item.workflow_run_id,
                      error: item.error,
                    })),
                    pending: yield* llm.pending,
                    misses: (yield* llm.misses).map((hit) => JSON.stringify(hit.body).slice(0, 240)),
                    runs: yield* Effect.forEach(runs, (run) =>
                      Effect.map(runService.events(run.id), (events) => ({
                        id: run.id,
                        state: run.state,
                        error: run.safeErrorSummary,
                        events: events.map((event) => ({ type: event.type, payload: event.payloadJSON })),
                      })),
                    ),
                  })}`,
                )
              })
              const items = yield* projects.listWorkItems(completed.id)
              expect(items.map((item) => item.kind)).toEqual(["planner", "worker", "reviewer"])
              expect(items.find((item) => item.kind === "worker")).toMatchObject({
                role: "evidence analyst",
                work_type: "analysis",
                model_group: "lite",
                review_status: "accepted",
              })
              expect(yield* projects.listGates(completed.id)).toEqual([])
              expect(
                (yield* (yield* AgentRun.Service).list({ companyProjectID: completed.id })).map(
                  (run) => run.workItemID,
                ),
              ).toEqual(expect.arrayContaining(items.map((item) => item.id)))
              const companyAgents = yield* CompanyAgent.Service
              expect((yield* companyAgents.list()).map((agent) => agent.id)).not.toEqual(
                expect.arrayContaining(["market-researcher", "product-strategist", "mvp-developer", "qa-engineer"]),
              )
            }),
          )
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "reopens a rejected worker-reviewer pair and reviews the corrected artifact",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          return yield* provideGlobalTestProvider(
            dir,
            llm.url,
            Effect.gen(function* () {
              const finding = "X-REWORK：补充自然结束的可复核证据"
              yield* llm.pushMatch(
                match("临时项目规划者"),
                reply()
                  .text(
                    JSON.stringify({
                      summary: "验证独立复核返工闭环",
                      scope: ["分析给定证据"],
                      success_criteria: ["返工结论可由证据复核"],
                      constraints: ["不创建软件产品"],
                      acceptance_criteria: ["方法、发现、结论与限制完整"],
                      assumptions: [],
                    }),
                  )
                  .stop(),
              )
              yield* llm.pushMatch(
                match("task decomposition specialist"),
                reply().tool("StructuredOutput", {
                  subtasks: [
                    {
                      key: "review-rework",
                      summary: "分析现有证据并根据独立复核返工",
                      acceptanceCriteria: "列出数据源、方法、发现、结论和限制",
                      workType: "analysis",
                      role: "evidence analyst",
                      capabilityPacks: ["research-analysis@1"],
                      decisionScope: ["证据含义"],
                      resourceScope: ["artifacts/review-rework"],
                      modelGroup: "lite",
                      riskLevel: "low",
                      dependsOn: [],
                    },
                  ],
                }),
              )
              yield* llm.pushMatch(
                match("只执行这一个叶子任务"),
                reply()
                  .text(
                    JSON.stringify({
                      summary: "worker-v1",
                      submission: {
                        question: "证据说明了什么",
                        dataSources: ["Project Charter"],
                        methodology: "对输入进行结构化归类，并逐项将结论映射到对应的项目证据。",
                        findings: ["初稿虽有结构化结论，但缺少自然结束状态的可复核证据。"],
                        conclusions: ["初稿结论待独立复核。"],
                        limitations: ["尚未覆盖自然结束状态"],
                      },
                    }),
                  )
                  .stop(),
              )
              yield* llm.pushMatch(
                (hit) => match("只执行这一个叶子任务")(hit) && containsText(hit.body, finding),
                reply()
                  .text(
                    JSON.stringify({
                      summary: "worker-v2",
                      submission: {
                        question: "证据说明了什么",
                        dataSources: ["Project Charter", "自然结束状态"],
                        methodology: "逐条回应独立复核 findings，并将结论映射回自然结束证据。",
                        findings: ["修订版已补充自然结束状态，并将该状态映射到可复核证据。"],
                        conclusions: ["修订版满足验收条件。"],
                        limitations: ["仅验证当前项目范围"],
                      },
                    }),
                  )
                  .stop(),
              )
              yield* llm.pushMatch(
                match("你没有参与原任务"),
                reply()
                  .text(
                    JSON.stringify({
                      accepted: false,
                      summary: "初稿需要返工",
                      findings: [finding],
                      evidence_checked: ["worker-v1"],
                    }),
                  )
                  .stop(),
              )
              yield* llm.pushMatch(
                (hit) =>
                  match("你没有参与原任务")(hit) &&
                  containsText(hit.body, '交付物：{"summary":"worker-v2"'),
                reply()
                  .text(
                    JSON.stringify({
                      accepted: true,
                      summary: "修订版满足验收条件",
                      findings: [],
                      evidence_checked: ["worker-v2", finding],
                    }),
                  )
                  .stop(),
              )
              const execution = yield* CompanyProjectExecution.Service
              const projects = yield* CompanyProject.Service
              const started = yield* execution.start({
                goal: "验证独立复核 findings 能驱动真实返工闭环",
                provider_id: "test",
                model_id: "test-model",
              })
              const completed = yield* Effect.gen(function* () {
                for (let attempt = 0; attempt < 300; attempt++) {
                  const current = yield* projects.get(started.project.id)
                  if (current?.status === "completed") return current
                  if (current?.status === "blocked") {
                    throw new Error(
                      `review rework project blocked: ${JSON.stringify(
                        (yield* projects.listWorkItems(current.id)).map((item) => ({
                          title: item.title,
                          status: item.status,
                          attempt: item.attempt,
                          review: item.review_status,
                          error: item.error,
                        })),
                      )}`,
                    )
                  }
                  yield* Effect.sleep("50 millis")
                }
                throw new Error("review rework project did not complete")
              })
              const items = yield* projects.listWorkItems(completed.id)
              const worker = items.find((item) => item.kind === "worker")!
              const reviewer = items.find((item) => item.kind === "reviewer")!
              expect(worker).toMatchObject({ status: "completed", attempt: 2, review_status: "accepted" })
              expect(reviewer).toMatchObject({ status: "completed", attempt: 2 })
              const artifacts = yield* projects.listArtifacts(completed.id)
              expect(
                artifacts
                  .filter((artifact) => artifact.work_item_id === worker.id && artifact.kind === "analysis")
                  .map((artifact) => JSON.parse(artifact.content!).summary),
              ).toEqual(["worker-v1", "worker-v2"])
              expect(
                artifacts
                  .filter(
                    (artifact) =>
                      artifact.work_item_id === reviewer.id && artifact.kind === "independent_review",
                  )
                  .map((artifact) => JSON.parse(artifact.content!).accepted),
              ).toEqual([false, true])
              const hits = yield* llm.hits
              const workerRequests = hits.filter((hit) => containsText(hit.body, "只执行这一个叶子任务"))
              const reviewerRequests = hits.filter((hit) => containsText(hit.body, "你没有参与原任务"))
              expect(workerRequests).toHaveLength(2)
              expect(containsText(workerRequests[1]!.body, finding)).toBe(true)
              expect(reviewerRequests).toHaveLength(2)
              expect(containsText(reviewerRequests[1]!.body, '交付物：{"summary":"worker-v2"')).toBe(true)
              expect(yield* llm.pending).toBe(0)
            }),
          )
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "gives reassigned workers and reviewers bounded cross-project recruitment evidence",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          return yield* provideGlobalTestProvider(
            dir,
            llm.url,
            Effect.gen(function* () {
              const companyID = CompanyID.parse("cmp_local")
              const reassignmentReason = "复用上一项目已验证候选，并保留错误初选与纠正原因"
              const performanceSummary = "上一项目独立复核通过，可复用其证据追踪能力"
              yield* seedCompany(companyID)
              const projects = yield* CompanyProject.Service
              const recruitment = yield* CompanyRecruitment.Service
              const companyAgents = yield* CompanyAgent.Service
              const sessions = yield* Session.Service

              const historyProject = yield* projects.create({
                company_id: companyID,
                goal: "完成上一项目的交付证据复核",
                title: "上一项目",
              })
              const historyNeed = yield* recruitment.createNeed({
                company_id: companyID,
                project_id: historyProject.id,
                need_key: "delivery-evidence-history",
                role: "delivery evidence auditor",
                work_type: "analysis",
                capability_packs: ["research-analysis@1"],
                risk_level: "low",
                demand_horizon: "recurring",
                department_key: "delivery-assurance",
              })
              const historySelectionResult = yield* recruitment.selectForNeed({
                capability_need_id: historyNeed.id,
                exclude_agent_ids: [],
              })
              const historySelection = historySelectionResult.selections.find(
                (selection) => selection.decision === "selected",
              )!
              yield* projects.transition({ id: historyProject.id, status: "planning", actor_id: "board-cto" })
              yield* projects.transition({ id: historyProject.id, status: "completed", actor_id: "board-cto" })
              yield* recruitment.recordPerformance({
                selection_id: historySelection.id,
                outcome: "success",
                quality_score: 96,
                reliability_score: 95,
                cost_score: 90,
                speed_score: 92,
                review_summary: performanceSummary,
              })
              yield* recruitment.releaseProject({ company_id: companyID, project_id: historyProject.id })

              const session = yield* sessions.create({
                title: "项目：跨项目候选复用证据",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const project = yield* projects.create({
                company_id: companyID,
                goal: "复用上一项目候选完成交付证据核验",
                title: "候选复用项目",
                owner_agent_id: "board-cto",
                coordinator_session_id: session.id,
                provider_id: "test",
                model_id: "test-model",
              })
              yield* projects.createCharter({
                project_id: project.id,
                title: project.title,
                value: project.goal,
                deliverables: ["跨项目候选复用核验记录"],
                scope: ["核验招聘与改派证据"],
                non_goals: ["不修改外部系统"],
                success_criteria: ["改派与跨项目历史可复核"],
                constraints: ["只使用 Control Plane 已持久化事实"],
                resources: [{ kind: "data", scope: "Control Plane 事实", disposition: "retain" }],
                risks: [],
                dri_agent_id: "board-cto",
                milestones: ["完成独立复核"],
                open_decisions: [],
                acceptance_criteria: ["from/to/reason、当前 owner 与跨项目复用历史完整"],
              })
              const plan = yield* projects.createPlan({
                project_id: project.id,
                phase: "execution",
                summary: "执行候选复用证据核验",
                acceptance_criteria: ["改派与跨项目历史可复核"],
              })
              const currentNeed = yield* recruitment.createNeed({
                company_id: companyID,
                project_id: project.id,
                need_key: "delivery-evidence-current",
                role: historyNeed.role,
                work_type: historyNeed.work_type,
                capability_packs: historyNeed.capability_packs,
                risk_level: historyNeed.risk_level,
                demand_horizon: "recurring",
                department_key: "delivery-assurance",
              })
              const currentSelectionResult = yield* recruitment.selectForNeed({
                capability_need_id: currentNeed.id,
                exclude_agent_ids: [],
              })
              const currentSelection = currentSelectionResult.selections.find(
                (selection) => selection.decision === "selected",
              )!
              expect(currentSelection.agent_id).toBe(historySelection.agent_id)
              const wrongAgent = yield* companyAgents.create({
                id: "wrong-evidence-agent",
                company_id: companyID,
                lifecycle: "candidate",
                name: "错误初选候选",
                description: "不具备跨项目交付历史",
                system_prompt: "只执行被分配的任务。",
                org_layer: "execution",
                responsibilities: ["unrelated work"],
              })
              const reviewerAgent = yield* companyAgents.create({
                id: "independent-evidence-reviewer",
                company_id: companyID,
                lifecycle: "candidate",
                name: "独立证据复核者",
                description: "独立复核交付证据。",
                system_prompt: "只根据可验证证据独立复核。",
                org_layer: "execution",
                responsibilities: ["independent review"],
              })
              const worker = yield* projects.createWorkItem({
                project_id: project.id,
                plan_id: plan.id,
                source_task_key: "delivery-evidence",
                title: "核验跨项目候选复用证据",
                description: "核验当前改派和上一项目候选复用历史。",
                kind: "worker",
                work_type: "analysis",
                role: historyNeed.role,
                capability_packs: historyNeed.capability_packs,
                decision_scope: ["证据含义"],
                resource_scope: ["artifacts/delivery-evidence"],
                inputs: ["招聘与项目事件"],
                expected_outputs: ["可复核分析"],
                validators: ["改派与跨项目历史完整"],
                disposition: "retain",
                model_group: "lite",
                risk_level: "low",
                review_status: "pending",
                owner_agent_id: wrongAgent.id,
                acceptance_criteria: ["from/to/reason、当前 owner 与跨项目复用历史完整"],
                max_attempts: 2,
              })
              const reviewer = yield* projects.createWorkItem({
                project_id: project.id,
                plan_id: plan.id,
                source_task_key: "delivery-evidence",
                parent_id: worker.id,
                title: "独立复核候选复用证据",
                description: "独立复核改派和跨项目复用历史。",
                kind: "reviewer",
                work_type: "analysis",
                role: "delivery evidence independent reviewer",
                capability_packs: ["independent-review@1"],
                decision_scope: [],
                resource_scope: ["artifacts/delivery-evidence"],
                inputs: ["Worker 交付物"],
                expected_outputs: ["独立复核结论"],
                validators: ["改派与跨项目历史完整"],
                disposition: "retain",
                model_group: "standard",
                risk_level: "low",
                review_status: "not_required",
                owner_agent_id: reviewerAgent.id,
                acceptance_criteria: worker.acceptance_criteria,
                max_attempts: 2,
                depends_on: [worker.id],
              })
              yield* projects.startWorkItem(worker.id)
              yield* projects.blockWorkItem({ id: worker.id, error: "初始 Agent 不满足跨项目复用要求" })
              yield* projects.transition({
                id: project.id,
                status: "blocked",
                actor_id: "board-cto",
                reason: "等待改派到已验证候选",
              })
              yield* projects.assignWorkItem({
                id: worker.id,
                owner_agent_id: currentSelection.agent_id,
                reason: reassignmentReason,
              })

              yield* llm.pushMatch(
                (hit) =>
                  match("只执行这一个叶子任务")(hit) &&
                  containsText(hit.body, reassignmentReason) &&
                  containsText(hit.body, historyProject.id),
                reply()
                  .text(
                    JSON.stringify({
                      summary: "跨项目候选复用证据已核验",
                      submission: {
                        question: "改派和跨项目复用是否有完整证据",
                        dataSources: ["work_item_reassignments", "selected_agent_history", "history_needs"],
                        methodology: "逐项核对改派事件、当前 owner、候选状态与上一项目入选和绩效记录。",
                        findings: ["from/to/reason、当前 owner 和上一项目复用历史一致。"],
                        conclusions: ["跨项目候选复用证据完整。"],
                        limitations: ["仅覆盖当前公司已持久化事实"],
                      },
                    }),
                  )
                  .stop(),
              )
              yield* llm.pushMatch(
                (hit) =>
                  match("你没有参与原任务")(hit) &&
                  containsText(hit.body, reassignmentReason) &&
                  containsText(hit.body, historyProject.id),
                reply()
                  .text(
                    JSON.stringify({
                      accepted: true,
                      summary: "改派和跨项目候选复用证据完整",
                      findings: [],
                      evidence_checked: ["from/to/reason", "current owner", "selected agent history"],
                    }),
                  )
                  .stop(),
              )

              const execution = yield* CompanyProjectExecution.Service
              yield* execution.retry({ project_id: project.id })
              const completed = yield* Effect.gen(function* () {
                for (let attempt = 0; attempt < 300; attempt++) {
                  const current = yield* projects.get(project.id)
                  if (current?.status === "completed") return current
                  if (current?.status === "blocked")
                    throw new Error(
                      `reassigned evidence project blocked: ${JSON.stringify(yield* projects.listWorkItems(project.id))}`,
                    )
                  yield* Effect.sleep("50 millis")
                }
                throw new Error("reassigned evidence project did not complete")
              })
              expect(completed.status).toBe("completed")
              expect((yield* projects.listWorkItems(project.id)).find((item) => item.id === worker.id)).toMatchObject({
                owner_agent_id: currentSelection.agent_id,
                review_status: "accepted",
              })
              expect((yield* projects.listWorkItems(project.id)).find((item) => item.id === reviewer.id)).toMatchObject({
                status: "completed",
              })

              const requests = (yield* llm.hits).filter(
                (hit) => containsText(hit.body, "只执行这一个叶子任务") || containsText(hit.body, "你没有参与原任务"),
              )
              expect(requests).toHaveLength(2)
              requests.forEach((request) => {
                expect(containsText(request.body, `"from_agent_id":"${wrongAgent.id}"`)).toBe(true)
                expect(containsText(request.body, `"to_agent_id":"${currentSelection.agent_id}"`)).toBe(true)
                expect(containsText(request.body, '"actor_id":null')).toBe(true)
                expect(containsText(request.body, reassignmentReason)).toBe(true)
                expect(containsText(request.body, `"owner_agent_id":"${currentSelection.agent_id}"`)).toBe(true)
                expect(containsText(request.body, '"selected_agent_history"')).toBe(true)
                expect(containsText(request.body, historyProject.id)).toBe(true)
                expect(containsText(request.body, historyNeed.id)).toBe(true)
                expect(containsText(request.body, currentNeed.id)).toBe(true)
                expect(containsText(request.body, performanceSummary)).toBe(true)
                expect(containsText(request.body, `"lifecycle":"assigned"`)).toBe(true)
                expect(containsText(request.body, '"type":"project.created"')).toBe(false)
              })
              const events = yield* projects.listEvents(project.id)
              expect(events).toEqual(
                events.toSorted(
                  (left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id),
                ),
              )
              expect(events.find((event) => event.type === "work_item.reassigned")).toMatchObject({
                data: {
                  work_item_id: worker.id,
                  from_agent_id: wrongAgent.id,
                  to_agent_id: currentSelection.agent_id,
                  reason: reassignmentReason,
                },
              })
              expect(yield* llm.pending).toBe(0)
            }),
          )
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "requires the project DRI to sign the final Board closeout before independent review",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          return yield* provideGlobalTestProvider(
            dir,
            llm.url,
            Effect.gen(function* () {
              const companyID = CompanyID.parse("cmp_local")
              yield* seedCompany(companyID)
              const companyAgents = yield* CompanyAgent.Service
              yield* Effect.sync(() =>
                Database.use((db) =>
                  db
                    .insert(ApprovalPolicyTable)
                    .values({ company_id: companyID, preset: "balanced", time_created: 1, time_updated: 1 })
                    .onConflictDoNothing()
                    .run(),
                ),
              )
              if (!(yield* companyAgents.get(CompanyAgentID.make("board-ceo"))))
                yield* companyAgents.create({
                  id: "board-ceo",
                  company_id: companyID,
                  lifecycle: "employee",
                  role_key: "ceo",
                  name: "CEO",
                  org_layer: "board",
                  responsibilities: ["公司目标与最终取舍"],
                })
              if (!(yield* companyAgents.get(CompanyAgentID.make("board-cto"))))
                yield* companyAgents.create({
                  id: "board-cto",
                  company_id: companyID,
                  lifecycle: "employee",
                  role_key: "cto",
                  name: "CTO",
                  description: "项目 DRI",
                  system_prompt: "只签署自己负责项目的最终决策。",
                  org_layer: "board",
                  reports_to: "board-ceo",
                  responsibilities: ["技术方向与工程质量"],
                })
              if (!(yield* companyAgents.get(CompanyAgentID.make("board-product-lead"))))
                yield* companyAgents.create({
                  id: "board-product-lead",
                  company_id: companyID,
                  lifecycle: "employee",
                  role_key: "product_lead",
                  name: "Product Lead",
                  org_layer: "board",
                  reports_to: "board-ceo",
                  responsibilities: ["用户价值与验收"],
                })
              yield* companyAgents.create({
                id: "wrong-closeout-owner",
                company_id: companyID,
                lifecycle: "candidate",
                name: "错误收口负责人",
                description: "不具备项目 DRI 身份。",
                system_prompt: "只执行分配的任务。",
                org_layer: "execution",
                responsibilities: ["准备收口材料"],
              })
              yield* companyAgents.create({
                id: "closeout-reviewer",
                company_id: companyID,
                lifecycle: "candidate",
                name: "收口独立复核者",
                description: "独立复核 Board 最终决策。",
                system_prompt: "只根据持久化证据验收。",
                org_layer: "execution",
                responsibilities: ["独立复核"],
              })
              const conversation = yield* Conversation.Service
              yield* conversation.ensureCompanyChannels({
                companyID,
                boardAgentIDs: ["board-cto"],
              })
              const board = yield* conversation.sendMessage({
                companyID,
                channelID: BOARD_CHANNEL_ID,
                principal: { kind: "user", id: LOCAL_USER_ID },
                requestID: crypto.randomUUID(),
                body: "建立可审计的交付保障闭环。",
              })
              const sessions = yield* Session.Service
              const session = yield* sessions.create({
                title: "项目：Board 最终收口",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const projects = yield* CompanyProject.Service
              const initialDecisionRequestID = crypto.randomUUID()
              const project = yield* projects.create({
                company_id: companyID,
                root_need_id: board.rootNeedID,
                source_thread_id: board.threadID,
                decision_request_id: initialDecisionRequestID,
                goal: "由项目 DRI 在原 Board Thread 签署最终收口，并经独立复核完成。",
                title: "Board 最终收口",
                owner_agent_id: "board-cto",
                coordinator_session_id: session.id,
                provider_id: "test",
                model_id: "test-model",
              })
              const initialDecision = yield* conversation.recordBoardDecision({
                companyID,
                threadID: board.threadID!,
                principal: { kind: "agent", id: "board-cto" },
                requestID: initialDecisionRequestID,
                projectScopeID: project.id,
                driAgentID: "board-cto",
                body: "正式立项：Board 最终收口\nDRI：board-cto",
              })
              expect(
                (yield* conversation.recordBoardDecision({
                  companyID,
                  threadID: board.threadID!,
                  principal: { kind: "agent", id: "board-cto" },
                  requestID: initialDecisionRequestID,
                  projectScopeID: project.id,
                  driAgentID: "board-cto",
                  body: initialDecision.body,
                })).id,
              ).toBe(initialDecision.id)
              yield* projects.createCharter({
                project_id: project.id,
                title: project.title,
                value: project.goal,
                deliverables: ["DRI 签署的最终收口决策"],
                scope: ["原 Board Thread 与项目证据"],
                non_goals: ["不代替 DRI 签署"],
                success_criteria: ["Reviewer 能从快照看到最终决策"],
                constraints: ["最终决策必须由项目 DRI 签署"],
                resources: [{ kind: "data", scope: "Board Thread", disposition: "retain" }],
                risks: [],
                dri_agent_id: "board-cto",
                milestones: ["最终收口完成"],
                open_decisions: [],
                acceptance_criteria: ["消息关联 Project、Work Item、Artifact，并包含完整受控决策内容"],
              })
              const plan = yield* projects.createPlan({
                project_id: project.id,
                phase: "execution",
                summary: "执行并独立复核最终收口。",
                acceptance_criteria: ["DRI 决策在 Board Thread 可追溯"],
              })
              const worker = yield* projects.createWorkItem({
                project_id: project.id,
                plan_id: plan.id,
                source_task_key: "board_closeout_and_organization_decision",
                title: "签署 Board 最终收口",
                description: "形成受控最终决策并写回原 Board Thread。",
                kind: "worker",
                work_type: "decision",
                role: "board closeout owner",
                capability_packs: ["board-strategy@1"],
                decision_scope: ["最终收口决策"],
                resource_scope: ["Board Thread"],
                inputs: ["项目交付证据"],
                expected_outputs: ["DRI 最终决策"],
                validators: ["DRI 署名与完整关联"],
                disposition: "retain",
                model_group: "standard",
                risk_level: "medium",
                review_status: "pending",
                owner_agent_id: "wrong-closeout-owner",
                acceptance_criteria: ["由项目 DRI 签署，正文包含完整 Artifact"],
                max_attempts: 3,
              })
              const reviewer = yield* projects.createWorkItem({
                project_id: project.id,
                plan_id: plan.id,
                source_task_key: "board_closeout_and_organization_decision",
                parent_id: worker.id,
                title: "独立复核 Board 最终收口",
                description: "检查原 Board Thread 中的 DRI 最终决策。",
                kind: "reviewer",
                work_type: "decision",
                role: "board closeout independent reviewer",
                capability_packs: ["independent-review@1"],
                decision_scope: [],
                resource_scope: ["Board Thread"],
                inputs: ["Worker Artifact", "Board Thread"],
                expected_outputs: ["独立复核结论"],
                validators: ["DRI、Artifact 与消息关联一致"],
                disposition: "retain",
                model_group: "standard",
                risk_level: "medium",
                review_status: "not_required",
                owner_agent_id: "closeout-reviewer",
                acceptance_criteria: worker.acceptance_criteria,
                max_attempts: 3,
                depends_on: [worker.id],
              })
              yield* projects.transition({ id: project.id, status: "planning", actor_id: "board-cto" })
              yield* projects.transition({ id: project.id, status: "executing", actor_id: "board-cto" })
              yield* projects.startWorkItem(worker.id)
              yield* projects.blockWorkItem({ id: worker.id, error: "验证错误 owner 不得签署" })
              yield* projects.transition({
                id: project.id,
                status: "blocked",
                actor_id: "board-cto",
                reason: "触发错误 owner 验证",
              })

              const decision = (summary: string, marker: string) =>
                reply()
                  .text(
                    JSON.stringify({
                      summary,
                      submission: {
                        question: "如何完成最终收口",
                        approaches: [
                          {
                            id: "close",
                            title: "按证据正式收口",
                            description: marker,
                            pros: ["可审计"],
                            cons: ["需 DRI 签署"],
                          },
                          {
                            id: "defer",
                            title: "延后收口",
                            description: "继续等待更多证据。",
                            pros: ["降低遗漏风险"],
                            cons: ["项目无法完成"],
                          },
                        ],
                        recommendedId: "close",
                        reasoning: `${marker}，当前证据已经满足验收。`,
                      },
                    }),
                  )
                  .stop()
              yield* llm.pushMatch(match("只执行这一个叶子任务"), decision("非 DRI 收口尝试", "WRONG-SIGNER"))
              const execution = yield* CompanyProjectExecution.Service
              yield* execution.retry({ project_id: project.id })
              yield* Effect.gen(function* () {
                for (let attempt = 0; attempt < 300; attempt++) {
                  const current = yield* projects.get(project.id)
                  if (current?.status === "blocked") return
                  yield* Effect.sleep("50 millis")
                }
                throw new Error("non-DRI closeout did not block")
              })
              expect(
                (yield* conversation.pageEntries({
                  companyID,
                  threadID: board.threadID!,
                  principal: { kind: "agent", id: "board-cto" },
                  limit: 100,
                })).items.filter(
                  (entry) =>
                    entry.type === "message" &&
                    entry.message.signalType === "decision" &&
                    entry.message.body.includes("项目最终收口决策"),
                ),
              ).toEqual([])
              expect((yield* projects.listWorkItems(project.id)).find((item) => item.id === worker.id)).toMatchObject({
                status: "blocked",
                owner_agent_id: "wrong-closeout-owner",
                error: expect.stringContaining("must be owned by project DRI board-cto"),
              })
              expect(
                (yield* projects.listArtifacts(project.id)).findLast(
                  (artifact) =>
                    artifact.work_item_id === worker.id &&
                    artifact.kind === "decision" &&
                    artifact.created_by_agent_id === "wrong-closeout-owner",
                )?.content,
              ).toContain("WRONG-SIGNER")
              expect(
                (yield* projects.listArtifacts(project.id)).findLast(
                  (artifact) =>
                    artifact.work_item_id === worker.id &&
                    artifact.kind === "attempt_failure" &&
                    artifact.created_by_agent_id === "wrong-closeout-owner",
                ),
              ).toMatchObject({
                evidence: {
                  error: expect.stringContaining("must be owned by project DRI board-cto"),
                  retryable: true,
                },
              })

              yield* projects.assignWorkItem({
                id: worker.id,
                owner_agent_id: "board-cto",
                reason: "最终收口只能由项目 DRI 签署",
              })
              yield* llm.pushMatch(
                (hit) =>
                  match("只执行这一个叶子任务")(hit) &&
                  containsText(hit.body, '"stage":"before_board_closeout_writeback"') &&
                  containsText(hit.body, '"prewrite_board_record":"expected_absent"') &&
                  containsText(hit.body, "不得据此建议 hold、拒绝签署或判定最终收口未满足"),
                decision("DRI 最终收口已完成", "CLOSEOUT-DRI-CONTENT"),
              )
              yield* llm.pushMatch(
                (hit) =>
                  match("你没有参与原任务")(hit) &&
                  containsText(hit.body, "项目最终收口决策") &&
                  containsText(hit.body, "CLOSEOUT-DRI-CONTENT") &&
                  containsText(hit.body, project.id),
                reply()
                  .text(
                    JSON.stringify({
                      accepted: true,
                      summary: "DRI 最终决策、Artifact 与 Board Thread 关联完整",
                      findings: [],
                      evidence_checked: ["Board decision", "Project ID", "Work Item ID", "Artifact ID"],
                    }),
                  )
                  .stop(),
              )
              yield* execution.retry({ project_id: project.id })
              const completed = yield* Effect.gen(function* () {
                for (let attempt = 0; attempt < 300; attempt++) {
                  const current = yield* projects.get(project.id)
                  if (current?.status === "completed") return current
                  if (current?.status === "blocked")
                    throw new Error(
                      `DRI closeout blocked: ${JSON.stringify(yield* projects.listWorkItems(project.id))}`,
                    )
                  yield* Effect.sleep("50 millis")
                }
                throw new Error("DRI closeout project did not complete")
              })
              const artifact = (yield* projects.listArtifacts(completed.id)).findLast(
                (candidate) =>
                  candidate.work_item_id === worker.id &&
                  candidate.kind === "decision" &&
                  candidate.created_by_agent_id === "board-cto",
              )!
              const boardDecision = (yield* conversation.pageEntries({
                companyID,
                threadID: board.threadID!,
                principal: { kind: "agent", id: "board-cto" },
                limit: 100,
              })).items.find(
                (entry) =>
                  entry.type === "message" &&
                  entry.message.signalType === "decision" &&
                  entry.message.body.includes("项目最终收口决策"),
              )
              if (boardDecision?.type !== "message") throw new Error("Board closeout decision is missing")
              const closeoutBody = boardDecision.message.body
              expect(boardDecision.message.author).toEqual({ kind: "agent", id: "board-cto" })
              expect(boardDecision.message.dri).toEqual({ kind: "agent", id: "board-cto" })
              expect(closeoutBody.includes(artifact.id)).toBe(true)
              expect(closeoutBody.includes(project.id)).toBe(true)
              expect(closeoutBody.includes(worker.id)).toBe(true)
              expect(closeoutBody.includes("DRI 最终收口已完成")).toBe(true)
              expect(closeoutBody.includes("CLOSEOUT-DRI-CONTENT")).toBe(true)
              expect(closeoutBody.length).toBeLessThanOrEqual(20_000)
              expect(artifact.content).not.toContain("尚无最终 Board 记录")
              expect(JSON.parse(artifact.content!).submission.recommendedId).toBe("close")
              const closeoutEvent = (yield* projects.listEvents(project.id)).find(
                (event) => event.type === "board_closeout.recorded",
              )!
              expect(closeoutEvent).toMatchObject({
                  actor_id: "board-cto",
                  data: {
                    work_item_id: worker.id,
                    artifact_id: artifact.id,
                    channel_message_id: boardDecision.message.id,
                  },
                })
              const closeoutRequestID = String(closeoutEvent.data.request_id)
              expect(
                (yield* conversation.recordBoardDecision({
                  companyID,
                  threadID: board.threadID!,
                  principal: { kind: "agent", id: "board-cto" },
                  requestID: closeoutRequestID,
                  projectScopeID: project.id,
                  driAgentID: "board-cto",
                  body: closeoutBody,
                })).id,
              ).toBe(boardDecision.message.id)
              expect(
                (yield* conversation.pageEntries({
                  companyID,
                  threadID: board.threadID!,
                  principal: { kind: "agent", id: "board-cto" },
                  limit: 100,
                })).items.filter(
                  (entry) => entry.type === "message" && entry.message.signalType === "decision",
                ),
              ).toHaveLength(2)
              expect((yield* projects.listWorkItems(project.id)).find((item) => item.id === reviewer.id)).toMatchObject({
                status: "completed",
              })
              const reviewRequest = (yield* llm.hits).find(
                (hit) => match("你没有参与原任务")(hit) && containsText(hit.body, "CLOSEOUT-DRI-CONTENT"),
              )
              expect(reviewRequest).toBeDefined()
              expect(containsText(reviewRequest!.body, artifact.id)).toBe(true)
              expect(yield* llm.pending).toBe(0)
            }),
          )
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "persists an approved Board Charter, decomposes it, executes it, and replays the decision idempotently",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          return yield* provideGlobalTestProvider(
            dir,
            llm.url,
            Effect.gen(function* () {
              yield* queueAdaptiveAnalysis(llm)
              const execution = yield* CompanyProjectExecution.Service
              const projects = yield* CompanyProject.Service
              const companyID = CompanyID.parse("cmp_local")
              yield* seedCompany(companyID)
              const input = {
                company_id: companyID,
                root_need_id: "need_board_test",
                source_thread_id: "thread_board_test",
                request_id: "019f8f0d-8af1-7398-b127-8bc7b96cc31d",
                goal: "分析本地证据并产出一份可复核结论",
                charter: {
                  title: "本地证据分析",
                  value: "让董事会基于可复核证据作出后续决策",
                  deliverables: ["一份结构化分析结论"],
                  acceptance_criteria: ["方法、发现、结论与限制完整"],
                  scope: ["分析给定的本地证据"],
                  non_goals: ["不创建软件产品"],
                  constraints: ["仅使用当前本地输入"],
                  resources: [{ kind: "data" as const, scope: "本地输入", disposition: "retain" }],
                  risks: [{ description: "证据范围有限", mitigation: "明确记录限制" }],
                  dri_agent_id: "board-ceo",
                  milestones: ["完成证据分析与独立复核"],
                  open_decisions: [],
                },
                provider_id: "test",
                model_id: "test-model",
              }
              const started = yield* execution.startFromCharter(input)
              const replayed = yield* execution.startFromCharter(input)
              expect(replayed).toMatchObject({
                replayed: true,
                project: { id: started.project.id },
                charter: { project_id: started.project.id, title: input.charter.title },
              })
              const completed = yield* Effect.gen(function* () {
                for (let attempt = 0; attempt < 300; attempt++) {
                  const current = yield* projects.get(started.project.id)
                  if (current?.status === "completed") return current
                  if (current?.status === "blocked") {
                    throw new Error(
                      `approved Board project blocked: ${JSON.stringify(
                        (yield* projects.listWorkItems(current.id)).map((item) => ({
                          title: item.title,
                          status: item.status,
                          error: item.error,
                        })),
                      )}`,
                    )
                  }
                  yield* Effect.sleep("50 millis")
                }
                throw new Error("approved Board project did not complete")
              })
              expect(completed).toMatchObject({
                company_id: input.company_id,
                root_need_id: input.root_need_id,
                source_thread_id: input.source_thread_id,
                decision_request_id: input.request_id,
                owner_agent_id: input.charter.dri_agent_id,
              })
              expect(yield* projects.getCharter(completed.id)).toMatchObject(input.charter)
              const items = yield* projects.listWorkItems(completed.id)
              expect(items.map((item) => item.kind)).toEqual(["planner", "worker", "reviewer"])
              expect(items[0]).toMatchObject({
                inputs: expect.arrayContaining(["已批准 Project Charter"]),
                expected_outputs: ["依赖有序的 worker/reviewer Work Items"],
                disposition: "retain",
                status: "completed",
              })
              expect(items[1]).toMatchObject({ status: "completed", review_status: "accepted", depends_on: [] })
              expect(items[2]).toMatchObject({ status: "completed", depends_on: [items[1].id] })
              const recruitment = yield* CompanyRecruitment.Service
              const snapshot = yield* recruitment.snapshot({ company_id: companyID, project_id: completed.id })
              expect(snapshot.needs.map((need) => [need.role, need.work_type, need.capability_packs])).toEqual([
                ["project-planner", "decision", ["product-charter@1"]],
                ["evidence analyst", "analysis", ["research-analysis@1"]],
                ["evidence analyst independent reviewer", "analysis", ["independent-review@1"]],
              ])
              expect(snapshot.selections.filter((selection) => selection.decision === "selected")).toHaveLength(3)
              expect(
                snapshot.selections.filter((selection) => selection.decision === "rejected").length,
              ).toBeGreaterThan(0)
              expect(
                snapshot.selections
                  .filter((selection) => selection.decision === "rejected")
                  .every((selection) => selection.reason.includes("未入选")),
              ).toBe(true)
              expect(
                snapshot.selections
                  .filter((selection) => selection.decision === "selected")
                  .every((selection) => typeof selection.time_released === "number"),
              ).toBe(true)
              expect(snapshot.assigned_candidates).toEqual([])
              expect(snapshot.candidate_pool.map((agent) => agent.id)).toEqual(
                expect.arrayContaining(
                  snapshot.selections
                    .filter(
                      (selection) =>
                        selection.decision === "selected" && selection.lifecycle_at_selection === "candidate",
                    )
                    .map((selection) => selection.agent_id),
                ),
              )
            }),
          )
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "cancels all running adaptive nodes and preserves the failed attempt",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* () {
          const execution = yield* CompanyProjectExecution.Service
          const projects = yield* CompanyProject.Service
          const started = yield* execution.start({
            goal: "验证动态项目取消",
            provider_id: "test",
            model_id: "test-model",
          })
          const cancelled = yield* execution.cancel({ project_id: started.project.id, reason: "用户停止" })
          expect(cancelled.status).toBe("blocked")
          expect((yield* projects.listWorkItems(cancelled.id))[0]).toMatchObject({ kind: "planner", status: "blocked" })
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )
})
