import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AgentRun } from "../../src/agent-run/agent-run"
import { AgentRunSupervisor } from "../../src/agent-run/supervisor"
import { CompanyAgent } from "../../src/company-agent"
import { CompanyProject, CompanyProjectExecution } from "../../src/company-project"
import { Delegation } from "../../src/delegation/delegation"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import * as Reputation from "../../src/reputation/reputation"
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
  Delegation.defaultLayer,
  Reputation.defaultLayer,
  AgentRun.defaultLayer,
  WorkType.defaultLayer,
)
const it = testEffect(Layer.mergeAll(dependencies, CompanyProjectExecution.layer.pipe(Layer.provide(dependencies))))

const match = (needle: string) => (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes(needle)

const provideGlobalTestProvider = <A, E, R>(
  dir: string,
  url: string,
  effect: Effect.Effect<A, E, R>,
) =>
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
      reply().text(JSON.stringify({
        summary: "分析本地证据并形成可复核结论",
        scope: ["分析给定证据"],
        success_criteria: ["结论可由证据复核"],
        constraints: ["不创建软件产品"],
        acceptance_criteria: ["方法、发现、结论与限制完整"],
        assumptions: [],
      })).stop(),
    )
    yield* llm.pushMatch(
      match("task decomposition specialist"),
      reply().tool("StructuredOutput", {
        subtasks: [
          {
            key: "evidence-analysis",
            summary: "分析现有证据并形成结论",
            acceptanceCriteria: "列出数据源、方法、发现、结论和限制",
            workType: "analysis",
            role: "evidence analyst",
            capabilityPacks: ["research-analysis@1"],
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
      reply().text(JSON.stringify({
        summary: "证据分析完成",
        submission: {
          question: "证据说明了什么",
          dataSources: ["Project Charter", "本地输入"],
          methodology: "对输入进行结构化归类，并将每个结论映射回对应证据。",
          findings: ["现有证据支持继续完成限定范围内的分析交付。"],
          conclusions: ["交付满足领域中立的分析目标。"],
          limitations: ["没有外部数据集"],
        },
      })).stop(),
    )
    yield* llm.pushMatch(
      match("你没有参与原任务"),
      reply().text(JSON.stringify({
        accepted: true,
        summary: "交付物满足验收条件",
        findings: [],
        evidence_checked: ["方法", "发现", "结论", "限制"],
      })).stop(),
    )
  })

describe("CompanyProject adaptive execution", () => {
  it.live("creates a dynamic planner-worker-reviewer tree and completes without fixed approval stages", () =>
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
                  throw new Error(`adaptive project blocked: ${JSON.stringify(items.map((item) => ({ title: item.title, error: item.error })))}`)
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
            expect((yield* (yield* AgentRun.Service).list({ companyProjectID: completed.id })).map((run) => run.workItemID)).toEqual(
              expect.arrayContaining(items.map((item) => item.id)),
            )
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

  it.live("cancels all running adaptive nodes and preserves the failed attempt", () =>
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
