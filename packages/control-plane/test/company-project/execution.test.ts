import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CompanyProject, CompanyProjectExecution } from "../../src/company-project"
import { Instance } from "../../src/project/instance"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpError, reply, type Item, type Reply } from "../lib/llm-server"
import { makeLayer, providerCfg } from "../workflow/lib"
import { Bus } from "../../src/bus"
import { WorkflowAgentFailed } from "../../src/workflow/events"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { AgentRunSupervisor } from "../../src/agent-run/supervisor"

afterEach(async () => {
  await Instance.disposeAll()
})

const base = Layer.mergeAll(makeLayer(AgentRunSupervisor.defaultLayer), CompanyProject.defaultLayer)
const it = testEffect(Layer.mergeAll(base, CompanyProjectExecution.layer.pipe(Layer.provide(base))))

const report = (title: string) => ({
  title,
  summary: `${title} summary`,
  findings: [{ claim: `${title} claim`, evidence: "verified", source_url: "https://example.com/source" }],
  risks: ["scope"],
  recommendation: "Build a minimal browser text game",
})

const proposal = {
  title: "AI 文字冒险 MVP",
  executive_summary: "有明确的低成本验证机会，建议立项",
  recommendation: "go",
  target_user: "喜欢短局文字冒险的玩家",
  product_concept: "由 AI 驱动事件变化的五分钟文字冒险",
  delivery_surface: "terminal",
  mvp_scope: ["一条完整可通关路径", "选择改变状态", "失败与胜利结局"],
  non_goals: ["账号", "联网多人", "付费"],
  risks: ["内容重复"],
  success_metrics: ["可安装启动", "完整试玩通过"],
  evidence_summary: ["同类产品验证文字互动需求"],
}

const match = (needle: string) => (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes(needle)

const queueResearch = (llm: {
  pushMatch: (
    match: (hit: { url: URL; body: Record<string, unknown> }) => boolean,
    ...input: (Item | Reply)[]
  ) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    yield* llm.pushMatch(match("市场与竞品研究"), reply().tool("StructuredOutput", report("market")))
    yield* llm.pushMatch(match("用户与产品机会研究"), reply().tool("StructuredOutput", report("product")))
    yield* llm.pushMatch(match("技术可行性研究"), reply().tool("StructuredOutput", report("technical")))
    yield* llm.pushMatch(match("根据以下三份报告"), reply().tool("StructuredOutput", proposal))
  })

describe("CompanyProject autonomous execution", () => {
  it.live(
    "cancels a running project and preserves the blocked attempt for retry",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* () {
          const execution = yield* CompanyProjectExecution.Service
          const projects = yield* CompanyProject.Service
          const started = yield* execution.start({
            goal: "验证取消项目执行",
            provider_id: "test",
            model_id: "test-model",
          })

          const cancelled = yield* execution.cancel({ project_id: started.project.id, reason: "切换模型" })

          expect(cancelled.status).toBe("blocked")
          expect(cancelled.active_run_id).toBeUndefined()
          expect((yield* projects.listWorkItems(cancelled.id)).map((item) => item.status)).toEqual([
            "blocked",
            "blocked",
            "blocked",
            "pending",
          ])
          yield* Effect.sleep("300 millis")
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "uses the configured global default model when start omits an override",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* () {
          const execution = yield* CompanyProjectExecution.Service
          const started = yield* execution.start({ goal: "验证全局默认模型" })

          expect(started.project.provider_id).toBe("test")
          expect(started.project.model_id).toBe("test-model")
          yield* execution.cancel({ project_id: started.project.id })
          yield* Effect.sleep("300 millis")
        }),
        { git: true, config: (url) => ({ ...providerCfg(url), model: "test/test-model" }) },
      ),
    30000,
  )

  it.live(
    "resumes blocked research in place without duplicating its plan or work items",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const execution = yield* CompanyProjectExecution.Service
          const projects = yield* CompanyProject.Service
          const started = yield* execution.start({
            goal: "验证研究阶段原地恢复",
            provider_id: "test",
            model_id: "test-model",
          })
          yield* execution.cancel({ project_id: started.project.id, reason: "模拟模型不可用" })
          yield* queueResearch(llm)

          const retried = yield* execution.retry({
            project_id: started.project.id,
            provider_id: "test",
            model_id: "test-model",
          })
          expect(retried.project.id).toBe(started.project.id)
          expect(retried.project.status).toBe("researching")

          const completed = yield* Effect.gen(function* () {
            for (let i = 0; i < 300; i++) {
              const current = yield* projects.get(started.project.id)
              if (current?.status === "awaiting_project_approval") return current
              yield* Effect.sleep("50 millis")
            }
            const current = yield* projects.get(started.project.id)
            const items = yield* projects.listWorkItems(started.project.id)
            throw new Error(
              `retried research stage did not reach approval gate: status=${current?.status}, items=${JSON.stringify(items.map((item) => ({ title: item.title, status: item.status, error: item.error })))}, pending=${yield* llm.pending}, misses=${(yield* llm.misses).length}`,
            )
          })
          expect(completed.id).toBe(started.project.id)
          expect(yield* projects.listPlans(completed.id)).toHaveLength(1)
          expect(yield* projects.listWorkItems(completed.id)).toHaveLength(4)
          expect((yield* projects.listWorkItems(completed.id)).map((item) => item.status)).toEqual([
            "completed",
            "completed",
            "completed",
            "completed",
          ])
          // Workflow wait resolves before terminal bus/inbox tails finish.
          yield* Effect.sleep("300 millis")
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "runs parallel research, persists artifacts, and stops at the product approval gate",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          yield* queueResearch(llm)

          const execution = yield* CompanyProjectExecution.Service
          const projects = yield* CompanyProject.Service
          const started = yield* execution.start({
            goal: "调查 AI 小游戏并制作极简可试玩文字游戏 MVP",
            provider_id: "test",
            model_id: "test-model",
          })

          const completed = yield* Effect.gen(function* () {
            for (let i = 0; i < 200; i++) {
              const current = yield* projects.get(started.project.id)
              if (current?.status === "awaiting_project_approval") return current
              yield* Effect.sleep("50 millis")
            }
            throw new Error("research stage did not reach approval gate")
          })
          expect(completed.active_run_id).toBeUndefined()
          expect((yield* projects.listWorkItems(completed.id)).map((item) => item.status)).toEqual([
            "completed",
            "completed",
            "completed",
            "completed",
          ])
          expect((yield* projects.listArtifacts(completed.id)).map((item) => item.kind)).toEqual([
            "market_report",
            "product_research",
            "technical_report",
            "project_proposal",
          ])
          const gates = yield* projects.listGates(completed.id, "pending")
          expect(gates).toHaveLength(1)
          expect(gates[0].kind).toBe("project_approval")
          expect((yield* llm.inputs).every((input) => input.tool_choice === "auto")).toBe(true)
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "persists the underlying agent error when research exhausts its retries",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const invalidKey = () => httpError(401, { error: { message: "Invalid API Key" } })
          yield* llm.pushMatch(match("市场与竞品研究"), invalidKey(), invalidKey(), invalidKey())
          yield* llm.pushMatch(match("用户与产品机会研究"), invalidKey(), invalidKey(), invalidKey())
          yield* llm.pushMatch(match("技术可行性研究"), invalidKey(), invalidKey(), invalidKey())

          const execution = yield* CompanyProjectExecution.Service
          const projects = yield* CompanyProject.Service
          const started = yield* execution.start({
            goal: "验证认证错误可见",
            provider_id: "test",
            model_id: "test-model",
          })
          const blocked = yield* Effect.gen(function* () {
            for (let i = 0; i < 300; i++) {
              const current = yield* projects.get(started.project.id)
              if (current?.status === "blocked") return current
              yield* Effect.sleep("50 millis")
            }
            throw new Error("research stage did not block after authentication failures")
          })
          expect(blocked.status).toBe("blocked")
          expect((yield* projects.listWorkItems(blocked.id)).filter((item) => item.kind === "research"))
            .toHaveLength(3)
          expect(
            (yield* projects.listWorkItems(blocked.id))
              .filter((item) => item.kind === "research")
              .map((item) => item.error),
          ).toEqual([
            expect.stringContaining("Invalid API Key"),
            expect.stringContaining("Invalid API Key"),
            expect.stringContaining("Invalid API Key"),
          ])
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "crosses both gates and delivers a tested playable repository",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          yield* queueResearch(llm)
          yield* llm.pushMatch(
            match("制作极简 MVP PRD"),
            reply().tool("StructuredOutput", {
              product_name: "微光地牢",
              problem: "短时间内体验有状态变化的文字冒险",
              target_user: "轻量冒险玩家",
              core_loop: ["阅读事件", "选择行动", "状态变化", "抵达结局"],
              user_stories: ["玩家可以完成一局冒险"],
              functional_requirements: ["至少三个选择节点", "胜利与失败结局"],
              non_functional_requirements: ["本地启动", "自动化测试"],
              non_goals: ["账号", "支付", "部署"],
            }),
          )
          yield* llm.pushMatch(
            match("制作可直接开发的架构"),
            reply().tool("StructuredOutput", {
              delivery_surface: "terminal",
              stack: ["Bun", "TypeScript"],
              modules: [{ name: "game", responsibility: "deterministic text adventure" }],
              repository_layout: ["game.ts", "game.test.ts", "README.md"],
              run_commands: ["bun run start", "bun test"],
              test_strategy: ["state transition tests", "smoke playthrough"],
              risks: ["content depth"],
            }),
          )
          yield* llm.pushMatch(
            match("定义独立验收计划"),
            reply().tool("StructuredOutput", {
              acceptance_criteria: ["installable", "tests pass", "playable"],
              automated_tests: ["winning path", "invalid choice"],
              smoke_tests: ["bun run start --smoke"],
              playtest_scenarios: ["complete one winning run"],
              release_gate: ["all commands exit 0"],
            }),
          )
          yield* llm.pushMatch(
            match("综合 PRD、架构和 QA 计划"),
            reply().tool("StructuredOutput", {
              summary: "实现一个无外部依赖的终端文字冒险",
              implementation_order: ["game state", "CLI", "tests", "README"],
              definition_of_done: ["bun test passes", "bun run start exits successfully", "playable path exists"],
            }),
          )

          const developer = match("在当前独立 Git 仓库中完成 MVP")
          // A transient stage-level model failure must trigger a fresh workflow
          // attempt without human intervention or duplicating project records.
          yield* llm.pushMatch(developer, httpError(400, { error: { message: "transient developer failure" } }))
          yield* llm.pushMatch(
            developer,
            reply().tool("write", {
              path: "package.json",
              content:
                JSON.stringify(
                  {
                    name: "glimmer-dungeon",
                    type: "module",
                    scripts: { start: "bun game.ts --smoke", test: "bun test game.test.ts" },
                  },
                  null,
                  2,
                ) + "\n",
            }),
          )
          yield* llm.pushMatch(
            developer,
            reply().tool("write", {
              path: "game.ts",
              content:
                "export function play(choices: string[]) { return choices.join(',') === 'torch,left' ? 'WIN' : 'LOSE' }\nif (import.meta.main) console.log(play(['torch','left']))\n",
            }),
          )
          yield* llm.pushMatch(
            developer,
            reply().tool("write", {
              path: "game.test.ts",
              content:
                "import { expect, test } from 'bun:test'\nimport { play } from './game'\ntest('winning path', () => expect(play(['torch','left'])).toBe('WIN'))\ntest('losing path', () => expect(play(['right'])).toBe('LOSE'))\n",
            }),
          )
          yield* llm.pushMatch(
            developer,
            reply().tool("write", {
              path: "README.md",
              content: "# 微光地牢\n\n运行 `bun run start`，测试 `bun test`。选择火把并向左即可获胜。\n",
            }),
          )
          yield* llm.pushMatch(
            developer,
            reply().tool("bash", {
              command: "bun",
              args: ["test"],
            }),
          )
          yield* llm.textMatch(developer, "MVP implemented and committed")

          const qa = match("你是独立 QA。检查当前仓库")
          yield* llm.toolMatch(qa, "bash", {
            command: "bun",
            args: ["run", "test"],
          })
          yield* llm.textMatch(
            qa,
            JSON.stringify({
              passed: true,
              summary: "tests and smoke playthrough passed",
              commands: [
                { command: "bun run test", result: "2 pass, 0 fail" },
                { command: "bun run start", result: "WIN" },
              ],
              failures: [],
              playtest_notes: ["winning path completed"],
            }),
          )
          yield* llm.textMatch(
            match("你是董事会最终评审人"),
            JSON.stringify({
              approved: true,
              summary: "交付满足已批准范围和 Definition of Done",
              evidence_checked: ["独立 QA 命令", "宿主测试", "README"],
              strengths: ["范围小", "测试可复现"],
              concerns: [],
            }),
          )

          const execution = yield* CompanyProjectExecution.Service
          const projects = yield* CompanyProject.Service
          const failures: unknown[] = []
          let failedActorID: string | undefined
          const bus = yield* Bus.Service
          yield* bus.subscribeCallback(WorkflowAgentFailed, (event) => {
            failures.push(event.properties)
            failedActorID = event.properties.actorID
          })
          yield* bus.subscribeAllCallback((event) => {
            if (event.type === "session.error") failures.push(event)
          })
          const started = yield* execution.start({
            goal: "构建可试玩 AI 文字小游戏 MVP",
            provider_id: "test",
            model_id: "test-model",
          })
          const waitFor = (status: string) =>
            Effect.gen(function* () {
              for (let i = 0; i < 200; i++) {
                const current = yield* projects.get(started.project.id)
                if (current?.status === status) return current
                yield* Effect.sleep("50 millis")
              }
              const current = yield* projects.get(started.project.id)
              const items = yield* projects.listWorkItems(started.project.id)
              const misses = yield* llm.misses
              const pending = yield* llm.pending
              const calls = yield* llm.calls
              const messages = failedActorID
                ? yield* (yield* Session.Service).messages({
                    sessionID: SessionID.make(failedActorID),
                    agentID: failedActorID,
                  })
                : []
              throw new Error(
                `project did not reach ${status}: current=${current?.status}, items=${JSON.stringify(items.map((item) => ({ title: item.title, status: item.status, error: item.error })))}, calls=${calls}, pending=${pending}, misses=${misses.length}, failures=${JSON.stringify(failures)}, messages=${JSON.stringify(messages)}`,
              )
            })

          yield* waitFor("awaiting_project_approval")
          const productGate = (yield* projects.listGates(started.project.id, "pending"))[0]
          yield* execution.resolveGate({ gate_id: productGate.id, decision: "approve" })
          yield* waitFor("awaiting_development_approval")
          const developmentGate = (yield* projects.listGates(started.project.id, "pending"))[0]
          yield* execution.resolveGate({ gate_id: developmentGate.id, decision: "approve" })
          yield* waitFor("verifying")
          const mergeGate = (yield* projects.listGates(started.project.id, "pending"))[0]
          expect(mergeGate.kind).toBe("merge_approval")
          yield* execution.resolveGate({ gate_id: mergeGate.id, decision: "approve" })
          const completed = yield* waitFor("completed")
          const repo = `${completed.output_dir}/repo`
          expect(yield* Effect.promise(() => Bun.file(`${repo}/.git/HEAD`).exists())).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(`${repo}/game.ts`).exists())).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(`${repo}/README.md`).exists())).toBe(true)
          const test = Bun.spawn(["bun", "run", "test"], { cwd: repo, stdout: "pipe", stderr: "pipe" })
          expect(yield* Effect.promise(() => test.exited)).toBe(0)
          const verification = (yield* projects.listArtifacts(completed.id)).find(
            (item) => item.kind === "verification_report",
          )
          expect(verification).toBeDefined()
          expect(JSON.parse(verification!.content!).host).toMatchObject({ passed: true, worktree: [{ code: 0 }] })
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )
})
