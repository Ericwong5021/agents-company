import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentRun } from "../../src/agent-run/agent-run"
import { AgentRunSupervisor } from "../../src/agent-run/supervisor"
import { CompanyProject, CompanyProjectExecution } from "../../src/company-project"
import { CompanyRecruitment } from "../../src/company-recruitment"
import * as CompanyRollout from "../../src/company-rollout/company-rollout"
import { CompanyTable } from "../../src/company/company.sql"
import { CompanyID } from "../../src/company/schema"
import { Conversation } from "../../src/conversation"
import { Delegation } from "../../src/delegation/delegation"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { SeedPolicyFactsValue } from "../../src/project-orchestrator/schema"
import * as Reputation from "../../src/reputation/reputation"
import { Database } from "../../src/storage"
import * as WorkType from "../../src/work-type/work-type"
import { provideTmpdirServer } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { reply, type Item, type Reply } from "../lib/llm-server"
import { makeLayer, providerCfg } from "../workflow/lib"

beforeEach(resetDatabase)
afterEach(resetDatabase)

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

const candidate: SeedPolicyFactsValue["slice_candidates"][number] = {
  id: "first-real-slice",
  title: "形成第一份可复核证据结论",
  description: "分析本地证据并形成可复核的 First Slice。",
  work_type: "analysis",
  role: "evidence analyst",
  capability_packs: ["research-analysis@1"],
  decision_scope: ["证据含义"],
  resource_scope: ["artifacts/evidence-analysis"],
  acceptance_criteria: ["方法、发现、结论与限制完整"],
  reality_contact: 3,
  information_gain: 3,
  user_value: 2,
  reversible: true,
  dependency_count: 0,
  reality_anchor: "本地运行时与项目文件",
  within_authorized_scope: true,
  external_side_effect: false,
}

const seedPolicy = (overrides: Partial<SeedPolicyFactsValue> = {}): SeedPolicyFactsValue => ({
  risk_level: "medium",
  scope_defined: true,
  reversible: true,
  stable_sop: false,
  unfamiliar_workspace: true,
  cross_module: true,
  external_side_effect: false,
  blocking_unknowns: [],
  slice_candidates: [candidate],
  ...overrides,
})

const enableSeedOptIn = () => {
  const initial = CompanyRollout.status().state.phase
  if (initial === "off")
    CompanyRollout.transition({
      idempotencyKey: "seed-execution-shadow",
      to: "shadow",
      reason: "prepare seed execution tests",
    })
  const current = CompanyRollout.status().state.phase
  if (current === "shadow")
    CompanyRollout.transition({
      idempotencyKey: "seed-execution-opt-in",
      to: "opt_in",
      reason: "enable seed execution tests",
    })
}

const withSeedFlag = <A, E, R>(value: "off" | "shadow" | "active", effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
      process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = value
      if (value === "active") enableSeedOptIn()
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
        else process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = previous
      }),
  )

const seedCompany = (companyID: CompanyID) =>
  Effect.sync(() => {
    const now = Date.now()
    Database.use((db) =>
      db
        .insert(CompanyTable)
        .values({
          id: companyID,
          name: "Seed Execution Test Company",
          data_version: 1,
          default_provider_id: ProviderID.make("test"),
          default_model_id: ModelID.make("test-model"),
          bootstrap_request_id: crypto.randomUUID(),
          bootstrap_input_path: "/tmp/seed-execution-test-company",
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .run(),
    )
  })

const queueWayfinder = (
  llm: {
    pushMatch: (
      match: (hit: { body: Record<string, unknown> }) => boolean,
      ...input: (Item | Reply)[]
    ) => Effect.Effect<void>
  },
  facts: { unknowns?: string[]; questions?: string[] } = {},
) =>
  llm.pushMatch(
    (hit) => JSON.stringify(hit.body).includes("你是 Wayfinder，只读检查现实环境"),
    reply()
      .text(
        JSON.stringify({
          summary: "已完成只读现实检查",
          confirmed_facts: ["项目文件可读取", "First Slice 可在本地完成"],
          invalidated_assumptions: [],
          unknowns: facts.unknowns ?? [],
          blockers: [],
          capability_gaps: [],
          recommended_first_slice: candidate,
          dependency_proposals: [],
          questions: facts.questions ?? [],
        }),
      )
      .stop(),
  )

const queueBuilder = (llm: {
  pushMatch: (
    match: (hit: { body: Record<string, unknown> }) => boolean,
    ...input: (Item | Reply)[]
  ) => Effect.Effect<void>
}) =>
  llm.pushMatch(
    (hit) => JSON.stringify(hit.body).includes("你的临时角色：evidence analyst"),
    reply()
      .text(
        JSON.stringify({
          summary: "第一份证据结论已完成",
          submission: {
            question: "本地证据说明了什么",
            dataSources: ["项目文件", "本地运行时"],
            methodology: "先读取项目文件与本地运行时，再结构化归类事实，并将每个结论逐项映射回对应证据。",
            findings: ["First Slice 已接触真实项目文件与运行时。"],
            conclusions: ["限定范围内的分析交付满足验收条件。"],
            limitations: ["未执行外部发布"],
          },
        }),
      )
      .stop(),
  )

describe.serial("Seed-and-Grow project execution", () => {
  it.live(
    "starts a Seed Pair with independent Wayfinder and Builder assignments",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          return yield* withSeedFlag(
            "active",
            Effect.gen(function* () {
              yield* queueWayfinder(llm)
              yield* queueBuilder(llm)
              const execution = yield* CompanyProjectExecution.Service
              const projects = yield* CompanyProject.Service
              const recruitment = yield* CompanyRecruitment.Service
              const runs = yield* AgentRun.Service
              const started = yield* execution.start({
                goal: "分析本地证据并产出第一份可复核结论",
                provider_id: "test",
                model_id: "test-model",
                execution_strategy: "seed_and_grow",
                seed_policy: seedPolicy(),
              })
              expect(started.project).toMatchObject({
                execution_strategy: "seed_and_grow",
                seed_mode: "seed_pair",
              })
              const items = yield* projects.listWorkItems(started.project.id)
              expect(items).toHaveLength(2)
              expect(items.map((item) => [item.purpose, item.origin_kind, item.kind])).toEqual([
                ["discovery", "seed", "worker"],
                ["first_slice", "seed", "worker"],
              ])
              expect(items.some((item) => item.kind === "reviewer")).toBe(false)
              expect(items.every((item) => Boolean(item.owner_agent_id))).toBe(true)
              expect(new Set(items.map((item) => item.owner_agent_id)).size).toBe(2)
              const assignments = yield* recruitment.listAssignments({ project_id: started.project.id })
              expect(assignments).toHaveLength(2)
              expect(new Set(assignments.map((assignment) => assignment.agent_id)).size).toBe(2)
              expect(
                assignments.every((assignment) => assignment.status === "assigned" || assignment.status === "active"),
              ).toBe(true)
              const agentRuns = yield* Effect.gen(function* () {
                for (let attempt = 0; attempt < 100; attempt++) {
                  const current = yield* runs.list({ companyProjectID: started.project.id })
                  if (current.length === 2) return current
                  yield* Effect.sleep("20 millis")
                }
                return yield* runs.list({ companyProjectID: started.project.id })
              })
              expect(agentRuns).toHaveLength(2)
              expect(
                agentRuns.find((run) => run.workItemID === items.find((item) => item.purpose === "discovery")!.id),
              ).toMatchObject({
                permissionMode: "read_only",
              })
              const completed = yield* Effect.gen(function* () {
                for (let attempt = 0; attempt < 200; attempt++) {
                  const current = yield* projects.get(started.project.id)
                  if (current?.status === "completed") return current
                  if (current?.status === "blocked")
                    throw new Error(
                      JSON.stringify({
                        items: (yield* projects.listWorkItems(started.project.id)).map((item) => ({
                          purpose: item.purpose,
                          status: item.status,
                          error: item.error,
                        })),
                        misses: (yield* llm.misses).map((hit) => JSON.stringify(hit.body).slice(0, 240)),
                      }),
                    )
                  yield* Effect.sleep("20 millis")
                }
                return yield* projects.get(started.project.id)
              })
              expect(completed?.status).toBe("completed")
            }),
          )
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "starts a direct_single project with one Builder and no Reviewer",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          return yield* withSeedFlag(
            "active",
            Effect.gen(function* () {
              yield* queueBuilder(llm)
              const execution = yield* CompanyProjectExecution.Service
              const projects = yield* CompanyProject.Service
              const recruitment = yield* CompanyRecruitment.Service
              const runs = yield* AgentRun.Service
              const started = yield* execution.start({
                goal: "按稳定方法改写一段本地文案",
                provider_id: "test",
                model_id: "test-model",
                execution_strategy: "seed_and_grow",
                seed_policy: seedPolicy({
                  risk_level: "low",
                  stable_sop: true,
                  unfamiliar_workspace: false,
                  cross_module: false,
                }),
              })
              expect(started.project).toMatchObject({
                execution_strategy: "seed_and_grow",
                seed_mode: "direct_single",
              })
              const items = yield* projects.listWorkItems(started.project.id)
              expect(items).toHaveLength(1)
              expect(items[0]).toMatchObject({
                kind: "worker",
                purpose: "first_slice",
                origin_kind: "seed",
              })
              expect(yield* recruitment.listAssignments({ project_id: started.project.id })).toHaveLength(1)
              const completed = yield* Effect.gen(function* () {
                for (let attempt = 0; attempt < 200; attempt++) {
                  const current = yield* projects.get(started.project.id)
                  if (current?.status === "completed") return current
                  yield* Effect.sleep("20 millis")
                }
                return yield* projects.get(started.project.id)
              })
              expect(completed?.status).toBe("completed")
              expect(
                new Set((yield* runs.list({ companyProjectID: started.project.id })).map((run) => run.workItemID)),
              ).toEqual(new Set([items[0].id]))
            }),
          )
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "cancels concurrent Seed Pair runs without scheduling retries",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          return yield* withSeedFlag(
            "active",
            Effect.gen(function* () {
              yield* llm.pushMatch(
                (hit) => JSON.stringify(hit.body).includes("你是 Wayfinder，只读检查现实环境"),
                reply().hang(),
              )
              yield* llm.pushMatch(
                (hit) => JSON.stringify(hit.body).includes("你的临时角色：evidence analyst"),
                reply().hang(),
              )
              const execution = yield* CompanyProjectExecution.Service
              const projects = yield* CompanyProject.Service
              const started = yield* execution.start({
                goal: "验证 Seed Pair 并发取消",
                provider_id: "test",
                model_id: "test-model",
                execution_strategy: "seed_and_grow",
                seed_policy: seedPolicy(),
              })
              const cancelled = yield* execution.cancel({
                project_id: started.project.id,
                reason: "用户停止 Seed Pair",
              })
              expect(cancelled.status).toBe("blocked")
              expect(yield* projects.listWorkItems(started.project.id)).toEqual([
                expect.objectContaining({ purpose: "discovery", status: "blocked", attempt: 1 }),
                expect.objectContaining({ purpose: "first_slice", status: "blocked", attempt: 1 }),
              ])
            }),
          )
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "blocks the Builder behind S15 until the discovery approval is resolved",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          return yield* withSeedFlag(
            "active",
            Effect.gen(function* () {
              yield* queueWayfinder(llm)
              yield* queueBuilder(llm)
              const execution = yield* CompanyProjectExecution.Service
              const projects = yield* CompanyProject.Service
              const recruitment = yield* CompanyRecruitment.Service
              const runs = yield* AgentRun.Service
              const started = yield* execution.start({
                goal: "确认生产发布边界后形成第一份分析结论",
                provider_id: "test",
                model_id: "test-model",
                execution_strategy: "seed_and_grow",
                seed_policy: seedPolicy({
                  risk_level: "high",
                  external_side_effect: true,
                  blocking_unknowns: ["生产发布凭据与授权范围未知"],
                }),
              })
              expect(started.project).toMatchObject({
                execution_strategy: "seed_and_grow",
                seed_mode: "discovery_first",
                status: "awaiting_approval",
              })
              const initialItems = yield* projects.listWorkItems(started.project.id)
              const wayfinder = initialItems.find((item) => item.purpose === "discovery")!
              const builder = initialItems.find((item) => item.purpose === "first_slice")!
              expect(wayfinder.owner_agent_id).toBeDefined()
              expect(builder.owner_agent_id).toBeUndefined()
              expect(yield* recruitment.listAssignments({ project_id: started.project.id })).toHaveLength(1)
              expect(
                yield* Effect.gen(function* () {
                  for (let attempt = 0; attempt < 100; attempt++) {
                    const current = yield* runs.list({ companyProjectID: started.project.id })
                    if (current.length === 1) return current
                    yield* Effect.sleep("20 millis")
                  }
                  return yield* runs.list({ companyProjectID: started.project.id })
                }),
              ).toHaveLength(1)
              const gate = (yield* projects.listGates(started.project.id, "pending"))[0]
              expect(gate.kind).toBe("risk_approval")
              const approved = yield* execution.resolveGate({
                gate_id: gate.id,
                decision: "approve",
                note: "批准限定范围内的 First Slice",
              })
              expect(approved.run_id).toBeDefined()
              const staffedItems = yield* projects.listWorkItems(started.project.id)
              const staffedWayfinder = staffedItems.find((item) => item.purpose === "discovery")!
              const staffedBuilder = staffedItems.find((item) => item.purpose === "first_slice")!
              expect(staffedBuilder.owner_agent_id).toBeDefined()
              expect(staffedBuilder.owner_agent_id).not.toBe(staffedWayfinder.owner_agent_id)
              expect(yield* recruitment.listAssignments({ project_id: started.project.id })).toHaveLength(2)
              const completedRuns = yield* Effect.gen(function* () {
                for (let attempt = 0; attempt < 200; attempt++) {
                  const current = yield* runs.list({ companyProjectID: started.project.id })
                  const project = yield* projects.get(started.project.id)
                  if (project?.status === "completed") return current
                  if (project?.status === "blocked")
                    throw new Error(
                      JSON.stringify({
                        items: (yield* projects.listWorkItems(started.project.id)).map((item) => ({
                          purpose: item.purpose,
                          status: item.status,
                          error: item.error,
                        })),
                        misses: (yield* llm.misses).map((hit) => JSON.stringify(hit.body).slice(0, 240)),
                      }),
                    )
                  yield* Effect.sleep("20 millis")
                }
                return yield* runs.list({ companyProjectID: started.project.id })
              })
              expect(new Set(completedRuns.map((run) => run.workItemID))).toEqual(
                new Set([staffedWayfinder.id, staffedBuilder.id]),
              )
              expect((yield* projects.get(started.project.id))?.status).toBe("completed")
            }),
          )
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "persists a WayfinderReceipt through the existing WorkReceipt model",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          return yield* withSeedFlag(
            "active",
            Effect.gen(function* () {
              yield* queueWayfinder(llm, {
                unknowns: ["生产发布凭据未知"],
                questions: ["是否允许后续生产发布"],
              })
              const execution = yield* CompanyProjectExecution.Service
              const projects = yield* CompanyProject.Service
              const started = yield* execution.start({
                goal: "只读确认项目现实边界",
                provider_id: "test",
                model_id: "test-model",
                execution_strategy: "seed_and_grow",
                seed_policy: seedPolicy({
                  risk_level: "high",
                  blocking_unknowns: ["生产发布凭据未知"],
                }),
              })
              const receipt = yield* Effect.gen(function* () {
                for (let attempt = 0; attempt < 200; attempt++) {
                  const receipts = yield* projects.listWorkReceipts(started.project.id)
                  if (receipts.length) return receipts[0]
                  yield* Effect.sleep("50 millis")
                }
                throw new Error("WayfinderReceipt was not persisted")
              })
              expect(receipt).toMatchObject({
                outcome: "completed",
                summary: "已完成只读现实检查",
                confirmed_facts: ["项目文件可读取", "First Slice 可在本地完成"],
                unknowns: ["生产发布凭据未知"],
                questions: ["是否允许后续生产发布"],
              })
              expect(
                (yield* projects.listArtifacts(started.project.id)).find((item) => item.kind === "wayfinder_receipt"),
              ).toMatchObject({
                work_item_id: receipt.work_item_id,
                evidence: { confirmed_facts: 2, unknowns: 1, blockers: 0 },
              })
              expect(
                (yield* projects.listWorkItems(started.project.id)).find((item) => item.purpose === "first_slice"),
              ).toMatchObject({
                status: "pending",
                owner_agent_id: undefined,
              })
              yield* execution.cancel({ project_id: started.project.id })
            }),
          )
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "records a SeedPolicy shadow verdict while keeping the legacy path authoritative",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* () {
          return yield* withSeedFlag(
            "shadow",
            Effect.gen(function* () {
              CompanyRollout.transition({
                idempotencyKey: "seed-execution-runtime-shadow",
                to: "shadow",
                reason: "compare SeedPolicy with the authoritative legacy path",
              })
              const execution = yield* CompanyProjectExecution.Service
              const started = yield* execution.start({
                goal: "验证同一项目输入的 SeedPolicy 影子判定",
                provider_id: "test",
                model_id: "test-model",
                execution_strategy: "seed_and_grow",
                seed_policy: seedPolicy(),
              })
              expect(started.project).toMatchObject({
                execution_strategy: "legacy_full_plan",
                seed_mode: undefined,
              })
              const shadow = CompanyRollout.evidence().shadowEvaluations
              expect(shadow).toHaveLength(1)
              expect(shadow[0]).toMatchObject({
                projectId: started.project.id,
                kind: "seed_policy",
                status: "evaluated",
                output: { verdict: { mode: "seed_pair" } },
              })
              expect(shadow[0].businessStateAfterSha256).toBe(shadow[0].businessStateBeforeSha256)
              yield* execution.cancel({ project_id: started.project.id })
            }),
          )
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "falls back to legacy when disabled and keeps an existing Board project pinned across rollback",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* () {
          return yield* withSeedFlag(
            "off",
            Effect.gen(function* () {
              const execution = yield* CompanyProjectExecution.Service
              const projects = yield* CompanyProject.Service
              const legacy = yield* execution.start({
                goal: "验证关闭开关后的兼容路径",
                provider_id: "test",
                model_id: "test-model",
                execution_strategy: "seed_and_grow",
                seed_policy: seedPolicy(),
              })
              expect(legacy.project).toMatchObject({
                execution_strategy: "legacy_full_plan",
                seed_mode: undefined,
              })
              expect(yield* projects.listWorkItems(legacy.project.id)).toHaveLength(1)
              expect((yield* projects.listWorkItems(legacy.project.id))[0]).toMatchObject({ kind: "planner" })
              yield* execution.cancel({ project_id: legacy.project.id })

              process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "active"
              enableSeedOptIn()
              const companyID = CompanyID.parse("cmp_local")
              yield* seedCompany(companyID)
              const input = {
                company_id: companyID,
                root_need_id: "need_seed_board",
                source_thread_id: "thread_seed_board",
                request_id: "019fbd38-1dfb-72f9-b1c8-bdb95b6f00a5",
                goal: "从已批准 Charter 启动 First Slice",
                charter: {
                  title: "Board Seed Project",
                  value: "尽快接触现实证据",
                  deliverables: ["第一份可复核结论"],
                  acceptance_criteria: ["方法、发现、结论与限制完整"],
                  scope: ["本地证据"],
                  non_goals: ["不发布生产"],
                  constraints: ["仅使用本地输入"],
                  resources: [{ kind: "data" as const, scope: "本地输入", disposition: "retain" }],
                  risks: [],
                  dri_agent_id: "board-ceo",
                  milestones: ["完成 First Slice"],
                  open_decisions: [],
                },
                provider_id: "test",
                model_id: "test-model",
                execution_strategy: "seed_and_grow" as const,
                seed_policy: seedPolicy(),
              }
              const started = yield* execution.startFromCharter(input)
              process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "off"
              const replayed = yield* execution.startFromCharter(input)
              expect(replayed).toMatchObject({
                replayed: true,
                project: {
                  id: started.project.id,
                  execution_strategy: "seed_and_grow",
                  seed_mode: "seed_pair",
                },
              })
              expect(yield* projects.listWorkItems(started.project.id)).toHaveLength(2)
              expect(
                yield* (yield* CompanyRecruitment.Service).listAssignments({ project_id: started.project.id }),
              ).toHaveLength(2)
              yield* execution.cancel({ project_id: started.project.id })
            }),
          )
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )
})
