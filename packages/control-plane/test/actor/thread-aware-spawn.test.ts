import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { AgentMessage } from "../../src/agent-message"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { CompanyAgent } from "../../src/company-agent"
import { CompanyAgentID } from "../../src/company-agent/schema"
import { Config } from "../../src/config"
import { LSP } from "../../src/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "../../src/provider"
import { Env } from "../../src/env"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { AppFileSystem } from "@agents-company/shared/filesystem"
import { SessionPrune } from "../../src/session/prune"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { Goal } from "../../src/session/goal"
import { TaskGateState } from "../../src/task/gate-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "../../src/tool"
import { Truncate } from "../../src/tool"
import { ActorRegistry } from "../../src/actor/registry"
import { ActorWaiter } from "../../src/actor/waiter"
import { Actor } from "../../src/actor/spawn"
import { Memory } from "../../src/memory"
import { History } from "../../src/history"
import { Team } from "../../src/team"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { SessionCompaction } from "../../src/session/compaction"
import { TaskRegistry } from "../../src/task/registry"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { Inbox } from "../../src/inbox"
import { Thread } from "../../src/thread/thread"
import type { ThreadID } from "../../src/thread/schema"

afterEach(async () => {
  await Instance.disposeAll()
})

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in thread-aware-spawn tests"),
    authenticate: () => Effect.die("unexpected MCP auth in thread-aware-spawn tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in thread-aware-spawn tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

function makeLayer() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Thread.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    AgentMessage.defaultLayer,
    Command.defaultLayer,
    CompanyAgent.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    status,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const checkpoint = SessionCheckpoint.defaultLayer
  const taskRegistry = ActorRegistry.defaultLayer
  const taskWaiter = ActorWaiter.defaultLayer
  const team = Team.defaultLayer
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(taskRegistry),
    Layer.provide(taskWaiter),
    Layer.provide(team),
    Layer.provide(checkpoint),
    Layer.provide(Memory.defaultLayer),
    Layer.provide(History.defaultLayer),
    Layer.provide(TaskRegistry.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps))
  const prune = SessionPrune.layer.pipe(Layer.provide(checkpoint), Layer.provideMerge(deps))
  const prompt = SessionPrompt.layer.pipe(
    Layer.provide(Goal.defaultLayer),
    Layer.provide(TaskGateState.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(summary),
    Layer.provide(checkpoint),
    Layer.provide(SessionCompaction.defaultLayer),
    Layer.provide(team),
    Layer.provide(taskRegistry),
    Layer.provideMerge(run),
    Layer.provideMerge(prune),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
    Layer.provide(Inbox.defaultLayer),
    Layer.provideMerge(deps),
  )
  return Layer.mergeAll(
    TestLLMServer.layer,
    Actor.layer.pipe(
      Layer.provideMerge(prompt),
      Layer.provideMerge(taskRegistry),
      Layer.provide(TaskRegistry.defaultLayer),
      Layer.provide(Inbox.defaultLayer),
    ),
  ).pipe(Layer.provide(summary))
}

const it = testEffect(makeLayer())

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function waitForThreadStatus(
  threadSvc: Thread.Interface,
  threadID: ThreadID,
  status: "active" | "paused" | "completed",
  attempts = 20,
): Effect.Effect<Thread.Info | undefined> {
  return Effect.gen(function* () {
    const thread = yield* threadSvc.get(threadID)
    if (thread?.status === status || attempts <= 0) return thread
    yield* Effect.sleep("50 millis")
    return yield* waitForThreadStatus(threadSvc, threadID, status, attempts - 1)
  })
}

function cancelAndWaitForThread(actor: Actor.Interface, threadSvc: Thread.Interface, result: Actor.SpawnResult) {
  return Effect.gen(function* () {
    yield* actor.cancel(result.sessionID, result.actorID, "forced").pipe(Effect.ignore, Effect.forkDetach)
    return yield* waitForThreadStatus(threadSvc, result.threadID!, "completed")
  })
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

describe("Thread-aware spawn (P1.3)", () => {
  describe("subagent spawn creates primary thread", () => {
    it.live("spawnSubagent creates a primary thread and returns threadID", () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const actor = yield* Actor.Service
          const session = yield* Session.Service
          const threadSvc = yield* Thread.Service

          const parent = yield* session.create({
            title: "thread subagent test",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          const gate = Promise.withResolvers<void>()
          yield* llm.hold("done", gate.promise)

          const result = yield* actor.spawn({
            mode: "subagent",
            sessionID: parent.id,
            agentType: "build",
            task: "create thread test",
            context: "none",
            tools: ["read"],
            background: true,
            model: ref,
          })

          // threadID must be present in SpawnResult
          expect(result.threadID).toBeDefined()
          expect(result.threadID).toStartWith("thr_")

          // Thread must exist and be active while actor is running
          const thread = yield* threadSvc.get(result.threadID!)
          expect(thread).toBeDefined()
          expect(thread?.kind).toBe("primary")
          expect(thread?.agentID).toBe(result.actorID)
          expect(thread?.status).toBe("active")

          yield* Effect.sync(() => gate.resolve())
          const outcome = yield* Deferred.await(result.outcome).pipe(Effect.timeout("10 seconds"))
          expect(["success", "failure"]).toContain(outcome.status)
        }),
        { git: true, config: providerCfg },
      ),
    )
  })

  describe("peer spawn creates reactive thread", () => {
    it.live("spawnPeer creates a reactive thread and returns threadID", () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const actor = yield* Actor.Service
          const session = yield* Session.Service
          const threadSvc = yield* Thread.Service

          const parent = yield* session.create({
            title: "thread peer test",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          const gate = Promise.withResolvers<void>()
          yield* llm.hold("done", gate.promise)

          const result = yield* actor.spawn({
            mode: "peer",
            sessionID: parent.id,
            agentType: "build",
            task: "peer thread test",
            context: "none",
            tools: ["read"],
            background: true,
            model: ref,
          })

          // threadID must be present in SpawnResult
          expect(result.threadID).toBeDefined()
          expect(result.threadID).toStartWith("thr_")

          // Thread must exist and be reactive
          const thread = yield* threadSvc.get(result.threadID!)
          expect(thread).toBeDefined()
          expect(thread?.kind).toBe("reactive")
          expect(thread?.agentID).toBe("build")

          yield* Effect.sync(() => gate.resolve())
          const outcome = yield* Deferred.await(result.outcome).pipe(Effect.timeout("10 seconds"))
          expect(["success", "failure"]).toContain(outcome.status)
        }),
        { git: true, config: providerCfg },
      ),
    )
  })

  describe("thread completion on terminal outcome", () => {
    it.live("thread is completed when subagent reaches a terminal outcome", () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const actor = yield* Actor.Service
          const session = yield* Session.Service
          const threadSvc = yield* Thread.Service

          const parent = yield* session.create({
            title: "thread completion success",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* llm.text("done")

          const result = yield* actor.spawn({
            mode: "subagent",
            sessionID: parent.id,
            agentType: "build",
            task: "complete on success",
            context: "none",
            tools: ["read"],
            background: false,
            model: ref,
          })

          // Wait for the actor to finish
          const outcome = yield* Deferred.await(result.outcome)
          expect(["success", "failure"]).toContain(outcome.status)

          // Thread must be completed
          const thread = yield* waitForThreadStatus(threadSvc, result.threadID!, "completed")
          expect(thread).toBeDefined()
          expect(thread?.status).toBe("completed")
          expect(thread?.timeCompleted).toBeDefined()
        }),
        { git: true, config: providerCfg },
      ),
    )
  })

  describe("thread completion on cancel", () => {
    it.live("thread is completed when actor is cancelled", () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const actor = yield* Actor.Service
          const session = yield* Session.Service
          const threadSvc = yield* Thread.Service

          const parent = yield* session.create({
            title: "thread completion cancel",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          // Hang the LLM so the fiber stays alive long enough to interrupt
          yield* llm.hang

          const result = yield* actor.spawn({
            mode: "subagent",
            sessionID: parent.id,
            agentType: "build",
            task: "cancel thread test",
            context: "none",
            tools: ["read"],
            background: true,
            model: ref,
          })

          // Thread should be active while actor is running
          const threadBefore = yield* threadSvc.get(result.threadID!)
          expect(threadBefore?.status).toBe("active")

          const threadAfter = yield* cancelAndWaitForThread(actor, threadSvc, result)
          expect(threadAfter?.status).toBe("completed")
          expect(threadAfter?.timeCompleted).toBeDefined()
        }),
        { git: true, config: providerCfg },
      ),
    )
  })

  describe("canAccept check", () => {
    it.live("subagent spawn fails when a company agent already has an active primary thread", () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const actor = yield* Actor.Service
          const session = yield* Session.Service
          const threadSvc = yield* Thread.Service
          const companyAgentID = CompanyAgentID.make("shared-build-agent")

          const parent = yield* session.create({
            title: "canAccept test",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          const gate = Promise.withResolvers<void>()
          yield* llm.hold("done", gate.promise)

          // First spawn creates an active primary thread for "build"
          const first = yield* actor.spawn({
            mode: "subagent",
            sessionID: parent.id,
            agentType: "build",
            task: "first spawn",
            context: "none",
            tools: ["read"],
            background: true,
            model: ref,
            companyAgentID,
          })

          expect(first.threadID).toBeDefined()

          // Second spawn should fail because "build" already has an active primary thread
          const secondEffect = actor.spawn({
            mode: "subagent",
            sessionID: parent.id,
            agentType: "build",
            task: "second spawn should fail",
            context: "none",
            tools: ["read"],
            background: true,
            model: ref,
            companyAgentID,
          })

          // The spawn should fail with an error about thread capacity
          const exit = yield* secondEffect.pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")

          yield* Effect.sync(() => gate.resolve())
          const outcome = yield* Deferred.await(first.outcome).pipe(Effect.timeout("10 seconds"))
          expect(["success", "failure"]).toContain(outcome.status)
        }),
        { git: true, config: providerCfg },
      ),
    )
  })
})
