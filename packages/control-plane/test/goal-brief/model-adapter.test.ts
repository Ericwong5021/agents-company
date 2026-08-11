import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { MockLanguageModelV3 } from "ai/test"
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider"
import { count, eq } from "drizzle-orm"
import { Effect } from "effect"
import { GoalBriefDraft, GoalBriefStructuredFailure } from "@agents-company/shared/experience"
import { CompanyProjectEventTable, CompanyProjectTable } from "../../src/company-project/company-project.sql"
import { GoalBriefModelAdapter, GoalBriefStore } from "../../src/goal-brief"
import {
  GoalBriefGenerationRequestTable,
  GoalBriefTable,
  GoalBriefVersionTable,
} from "../../src/goal-brief/goal-brief.sql"
import { Database } from "../../src/storage"
import { ProviderTest } from "../fake/provider"
import { resetDatabase } from "../fixture/db"

function brief() {
  return {
    goal: "适配两个结构化 Provider",
    deliverables: [{ id: "delivery-1", title: "统一 Brief", description: "返回同一领域结构" }],
    acceptanceCriteria: [{ id: "criterion-1", description: "结构一致", verification: "共享 Schema 解析通过" }],
    constraints: [],
    nonGoals: [],
    assumptions: [],
    openQuestions: [],
    riskLevel: "low" as const,
    recommendedPlan: {
      summary: "使用严格结构化输出",
      steps: [{ id: "step-1", title: "生成", outcome: "得到合法 Brief" }],
    },
    approvalMode: "balanced" as const,
    sourceRefs: [{ kind: "user" as const, id: "user-local" }],
  }
}

function generationResult(value: unknown): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  }
}

beforeEach(resetDatabase)
afterEach(resetDatabase)

describe.serial("Goal Brief model adapter", () => {
  test.serial("uses the default Provider service and repairs only generated structural output", async () => {
    const { sourceRefs: _, ...draft } = brief()
    let calls = 0
    const language = new MockLanguageModelV3({
      doGenerate: async () => generationResult(calls++ === 0 ? '{"goal":"truncated"' : draft),
    })
    const provider = ProviderTest.fake({
      getLanguage: () => Effect.succeed(language),
    })
    const result = await Effect.runPromise(
      GoalBriefModelAdapter.createFromDefaultModel({
        requestId: "request-default-model",
        goal: "通过默认 Provider 生成 Goal Brief",
      }).pipe(Effect.provide(provider.layer)),
    )

    expect(result.sourceRefs).toEqual([{ kind: "goal_request", id: "request-default-model" }])
    expect(language.doGenerateCalls).toHaveLength(2)
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefTable).get())?.value).toBe(1)
  })

  test.serial("propagates Provider failures while preserving the request payload binding", async () => {
    const providerError = Object.assign(new Error("rate limited"), { statusCode: 429 })
    const language = new MockLanguageModelV3({
      doGenerate: async () => {
        throw providerError
      },
    })
    const provider = ProviderTest.fake({
      getLanguage: () => Effect.succeed(language),
    })
    const error = await Effect.runPromise(
      GoalBriefModelAdapter.createFromDefaultModel({
        requestId: "request-default-provider-error",
        goal: "验证 Provider 错误边界",
      }).pipe(Effect.provide(provider.layer)),
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    )

    expect(error).toBe(providerError)
    expect(language.doGenerateCalls).toHaveLength(1)
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefTable).get())?.value).toBe(0)
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefGenerationRequestTable).get())?.value).toBe(
      1,
    )
    const conflict = await Effect.runPromise(
      GoalBriefModelAdapter.createFromDefaultModel({
        requestId: "request-default-provider-error",
        goal: "复用 requestId 改写请求内容",
      }).pipe(Effect.provide(provider.layer)),
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(conflict).toBeInstanceOf(GoalBriefModelAdapter.GoalBriefRequestConflictError)
    expect(language.doGenerateCalls).toHaveLength(1)
  })

  test.serial("uses a resolved default language model and persists only validated structured output", async () => {
    const calls: GoalBriefModelAdapter.GoalBriefStructuredGenerationCall[] = []
    const result = await GoalBriefModelAdapter.generateAndCreate(
      {
        requestId: "request-model-brief",
        goal: "生成可验证的体验重构 Goal Brief",
        context: "交付物和验收标准必须语义分离",
      },
      {
        resolveDefaultModel: async () => ({
          adapterProvider: "openai_compatible",
          model: new MockLanguageModelV3(),
        }),
        generate: async (call) => {
          calls.push(call)
          const { sourceRefs: _, ...output } = brief()
          return call.schema.parse(output)
        },
      },
      "strict",
    )

    expect(result.source).toBe("system_suggestion")
    expect(result.sourceRefs).toEqual([{ kind: "goal_request", id: "request-model-brief" }])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toContain("生成可验证的体验重构 Goal Brief")
    expect(result.approvalMode).toBe("strict")
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefTable).get())?.value).toBe(1)
  })

  test.serial("binds requestId durably and returns one Brief without duplicate model work or events", async () => {
    Database.use((db) => {
      db.insert(CompanyProjectTable)
        .values({
          id: "project-idempotent-brief",
          goal: "只生成一次 Goal Brief",
          title: "幂等 Goal Brief",
          status: "intake",
          output_dir: "/tmp/project-idempotent-brief",
          created_at: 100,
          updated_at: 100,
        })
        .run()
    })
    let resolveCalls = 0
    let generateCalls = 0
    const input = {
      requestId: "request-idempotent-brief",
      goal: "生成一次且仅一次 Goal Brief",
      context: "并发和顺序重试都返回相同结果",
      projectId: "project-idempotent-brief",
    }
    const dependencies: GoalBriefModelAdapter.GoalBriefGenerationDependencies = {
      resolveDefaultModel: async () => {
        resolveCalls += 1
        return {
          adapterProvider: "openai_compatible",
          model: new MockLanguageModelV3(),
        }
      },
      generate: async (call) => {
        generateCalls += 1
        const { sourceRefs: _, ...output } = brief()
        return call.schema.parse(output)
      },
    }

    const concurrent = await Promise.all([
      GoalBriefModelAdapter.generateAndCreate(input, dependencies),
      GoalBriefModelAdapter.generateAndCreate(input, dependencies),
    ])
    const replay = await GoalBriefModelAdapter.generateAndCreate(input, dependencies)
    const normalizedReplay = await GoalBriefModelAdapter.generateAndCreate(
      {
        ...input,
        goal: ` ${input.goal} `,
        context: ` ${input.context} `,
        projectId: ` ${input.projectId} `,
      },
      dependencies,
    )
    const appended = GoalBriefStore.append(concurrent[0]!.id, {
      expectedVersion: 1,
      source: "user_confirmation",
      brief: { ...brief(), goal: "确认后的 Goal Brief" },
    })
    const replayAfterAppend = await GoalBriefModelAdapter.generateAndCreate(input, dependencies)

    expect(concurrent[0]).toEqual(concurrent[1])
    expect(replay).toEqual(concurrent[0])
    expect(normalizedReplay).toEqual(concurrent[0])
    expect(appended).toMatchObject({ ok: true, brief: { version: 2 } })
    expect(replayAfterAppend).toEqual(concurrent[0])
    expect(resolveCalls).toBe(1)
    expect(generateCalls).toBe(1)
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefTable).get())?.value).toBe(1)
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefVersionTable).get())?.value).toBe(2)
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefGenerationRequestTable).get())?.value).toBe(
      1,
    )
    expect(Database.use((db) => db.select({ value: count() }).from(CompanyProjectEventTable).get())?.value).toBe(2)

    for (const conflicting of [
      { ...input, goal: "复用 requestId 但改变目标" },
      { ...input, context: "复用 requestId 但改变上下文" },
      { ...input, projectId: "project-other" },
      { ...input, sourceThreadId: "thread-other" },
    ]) {
      const conflict = await GoalBriefModelAdapter.generateAndCreate(conflicting, dependencies).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(conflict).toBeInstanceOf(GoalBriefModelAdapter.GoalBriefRequestConflictError)
    }
    expect(resolveCalls).toBe(1)
    expect(generateCalls).toBe(1)
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefTable).get())?.value).toBe(1)
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefVersionTable).get())?.value).toBe(2)
    expect(Database.use((db) => db.select({ value: count() }).from(CompanyProjectEventTable).get())?.value).toBe(2)
  })

  test.serial("rejects a conflicting in-flight payload before a second model call", async () => {
    let releaseGeneration = () => {}
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve
    })
    let calls = 0
    const dependencies: GoalBriefModelAdapter.GoalBriefGenerationDependencies = {
      resolveDefaultModel: async () => ({
        adapterProvider: "anthropic_compatible",
        model: new MockLanguageModelV3(),
      }),
      generate: async (call) => {
        calls += 1
        await generationGate
        const { sourceRefs: _, ...output } = brief()
        return call.schema.parse(output)
      },
    }
    const pending = GoalBriefModelAdapter.generateAndCreate(
      {
        requestId: "request-in-flight-conflict",
        goal: "保持生成中的请求唯一",
      },
      dependencies,
    )
    const conflict = await GoalBriefModelAdapter.generateAndCreate(
      {
        requestId: "request-in-flight-conflict",
        goal: "冲突的生成内容",
      },
      dependencies,
    ).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(conflict).toBeInstanceOf(GoalBriefModelAdapter.GoalBriefRequestConflictError)
    releaseGeneration()
    expect((await pending).id).toStartWith("goalBrief_")
    expect(calls).toBe(1)
  })

  test.serial("prevents a stale model owner from completing or releasing a taken-over lease", async () => {
    let releaseGeneration = () => {}
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve
    })
    const input = {
      requestId: "request-stale-owner",
      goal: "崩溃恢复后只允许当前 owner 完成",
    }
    const pending = GoalBriefModelAdapter.generateAndCreate(input, {
      resolveDefaultModel: async () => ({
        adapterProvider: "openai_compatible",
        model: new MockLanguageModelV3(),
      }),
      generate: async (call) => {
        await generationGate
        const { sourceRefs: _, ...output } = brief()
        return call.schema.parse(output)
      },
    })
    const reservation = Database.use((db) =>
      db
        .select()
        .from(GoalBriefGenerationRequestTable)
        .where(eq(GoalBriefGenerationRequestTable.request_id, input.requestId))
        .get(),
    )
    if (!reservation) throw new Error("Expected a generation reservation")
    expect(
      GoalBriefStore.reserveGeneration(
        input.requestId,
        reservation.payload_hash,
        "owner-takeover",
        reservation.lease_expires_at,
        30_000,
      ),
    ).toEqual({ status: "reserved" })
    releaseGeneration()
    const error = await pending.then(
      () => undefined,
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(GoalBriefModelAdapter.GoalBriefRequestInProgressError)
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefTable).get())?.value).toBe(0)
    expect(
      Database.use((db) =>
        db
          .select()
          .from(GoalBriefGenerationRequestTable)
          .where(eq(GoalBriefGenerationRequestTable.request_id, input.requestId))
          .get(),
      ),
    ).toMatchObject({ owner_token: "owner-takeover" })
    GoalBriefStore.releaseGeneration(input.requestId, reservation.payload_hash, "owner-takeover")
  })

  test.serial("takes over an expired lease and prevents followers or stale owners from releasing it", () => {
    expect(GoalBriefStore.reserveGeneration("request-lease", "hash-lease", "owner-leader", 100, 10)).toEqual({
      status: "reserved",
    })
    expect(GoalBriefStore.reserveGeneration("request-lease", "hash-lease", "owner-follower", 105, 10)).toEqual({
      status: "pending",
    })
    GoalBriefStore.releaseGeneration("request-lease", "hash-lease", "owner-follower")
    expect(Database.use((db) => db.select().from(GoalBriefGenerationRequestTable).get())).toMatchObject({
      owner_token: "owner-leader",
      lease_expires_at: 110,
    })

    expect(GoalBriefStore.reserveGeneration("request-lease", "hash-lease", "owner-takeover", 110, 10)).toEqual({
      status: "reserved",
    })
    expect(GoalBriefStore.extendGenerationLease("request-lease", "hash-lease", "owner-leader", 10)).toBe(false)
    GoalBriefStore.releaseGeneration("request-lease", "hash-lease", "owner-leader")
    expect(Database.use((db) => db.select().from(GoalBriefGenerationRequestTable).get())).toMatchObject({
      owner_token: "owner-takeover",
      lease_expires_at: 120,
    })

    GoalBriefStore.releaseGeneration("request-lease", "hash-lease", "owner-takeover")
    expect(Database.use((db) => db.select().from(GoalBriefGenerationRequestTable).get())).toMatchObject({
      owner_token: "owner-takeover",
      lease_expires_at: 0,
    })
    expect(GoalBriefStore.reserveGeneration("request-lease", "hash-lease", "owner-retry", 121, 10)).toEqual({
      status: "reserved",
    })
  })

  test.serial("normalizes OpenAI-compatible and Anthropic-compatible structured outputs", async () => {
    const openAI = await GoalBriefModelAdapter.adapt({
      provider: "openai_compatible",
      generate: async () => ({ output: brief() }),
    })
    const anthropic = await GoalBriefModelAdapter.adapt({
      provider: "anthropic_compatible",
      generate: async () => ({ input: structuredClone(brief()) }),
    })
    const directAnthropic = await GoalBriefModelAdapter.adapt({
      provider: "anthropic_compatible",
      generate: async () => structuredClone(brief()),
    })

    expect(GoalBriefDraft.parse(openAI)).toEqual(GoalBriefDraft.parse(anthropic))
    expect(GoalBriefDraft.parse(directAnthropic)).toEqual(GoalBriefDraft.parse(anthropic))
  })

  test.serial("performs a bounded repair and exposes the prior validation error", async () => {
    const requests: GoalBriefModelAdapter.GoalBriefModelRequest[] = []
    const result = await GoalBriefModelAdapter.adapt({
      provider: "openai_compatible",
      maxRepairAttempts: 2,
      generate: async (request) => {
        requests.push(request)
        return request.attempt === 1 ? { output: '{"goal":"truncated"' } : { output: brief() }
      },
    })

    expect(result).toEqual(brief())
    expect(requests.map((request) => request.mode)).toEqual(["generate", "repair"])
    expect(requests[1]?.previousError).toMatch(/valid JSON/)
  })

  test.serial("fails explicitly after the repair budget and never persists invalid output", async () => {
    const requests: GoalBriefModelAdapter.GoalBriefModelRequest[] = []

    const error = await GoalBriefModelAdapter.createFromModel({
      provider: "anthropic_compatible",
      maxRepairAttempts: 2,
      generate: async (request) => {
        requests.push(request)
        return { input: { goal: "incomplete" } }
      },
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toMatchObject({
      name: "GoalBriefModelAdaptationError",
      provider: "anthropic_compatible",
      attempts: 3,
    })
    if (!(error instanceof GoalBriefModelAdapter.GoalBriefModelAdaptationError))
      throw new Error("Expected GoalBriefModelAdaptationError")
    expect(GoalBriefStructuredFailure.parse(error.toApiError())).toEqual({
      code: "goal_brief_structured_output_failed",
      message: "未能生成完整 Goal Brief。你可以重试，或手动补充目标信息。",
      attempts: 3,
      recoveryActions: ["retry", "manual_edit"],
    })
    expect(JSON.stringify(error.toApiError())).not.toMatch(/prompt|reasoning|chain.of.thought|anthropic/i)
    expect(requests).toHaveLength(3)
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefTable).get())?.value).toBe(0)
  })

  test.serial("does not retry or rewrite provider failures and never persists them", async () => {
    const providerError = Object.assign(new Error("authentication failed"), { code: "invalid_api_key" })
    let calls = 0
    const error = await GoalBriefModelAdapter.createFromModel({
      provider: "openai_compatible",
      generate: async () => {
        calls += 1
        throw providerError
      },
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    )

    expect(error).toBe(providerError)
    expect(error).not.toBeInstanceOf(GoalBriefModelAdapter.GoalBriefModelAdaptationError)
    expect(calls).toBe(1)
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefTable).get())?.value).toBe(0)
  })
})
