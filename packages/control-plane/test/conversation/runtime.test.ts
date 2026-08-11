import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { AgentRunEventTable, AgentRunTable } from "../../src/agent-run/agent-run.sql"
import { Company } from "../../src/company"
import { RepositoryBindingTable } from "../../src/company/company.sql"
import { BootstrapInput, CompanyID } from "../../src/company/schema"
import { Config } from "../../src/config"
import { Conversation } from "../../src/conversation"
import {
  ChannelMessageTable,
  ConversationRunTable,
  SignalProjectionSourceTable,
  SignalProjectionTable,
} from "../../src/conversation/conversation.sql"
import { ConversationRuntime } from "../../src/conversation/runtime"
import { BOARD_CHANNEL_ID } from "../../src/conversation/conversation.sql"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Global } from "../../src/global"
import { GroupSession } from "../../src/group-session"
import {
  GroupMessageTable,
  GroupSessionMemberTable,
  GroupSessionTable,
} from "../../src/group-session/group-session.sql"
import { GroupSessionID } from "../../src/group-session/schema"
import { Instance } from "../../src/project/instance"
import { eq } from "../../src/storage"
import * as Database from "../../src/storage/db"
import { companyProviderConfig } from "../fixture/company-provider"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse, toolCallResponse } from "../lib/scripted-llm-server"

const companyID = CompanyID.parse("cmp_local")

setDefaultTimeout(30_000)

function providerConfig(baseURL: string) {
  return {
    model: "m2-test/test-model",
    small_model: "m2-test/test-model",
    provider: {
      ...companyProviderConfig.provider,
      "m2-test": {
        ...companyProviderConfig.provider["m2-test"],
        options: { ...companyProviderConfig.provider["m2-test"].options, baseURL },
      },
    },
  }
}

const passBid = '{"level":"pass","type":"info","addressedAs":"none","reason":"not needed"}'
const mustBid = '{"level":"must","type":"info","addressedAs":"none","reason":"board input requires a response"}'

function boardTurnResponses(...turn: Array<{ lines: string[]; status?: number }>) {
  return [
    { lines: textStopResponse(mustBid) },
    { lines: textStopResponse(passBid) },
    { lines: textStopResponse(passBid) },
    ...turn,
    { lines: textStopResponse(passBid) },
    { lines: textStopResponse(passBid) },
    { lines: textStopResponse(passBid) },
  ]
}

function boardFailureResponses(secret: string, ...beforeFailure: Array<{ lines: string[]; status?: number }>) {
  return [
    { lines: textStopResponse(mustBid) },
    { lines: textStopResponse(passBid) },
    { lines: textStopResponse(passBid) },
    ...beforeFailure,
    ...Array.from({ length: 16 }, () => ({
      lines: textStopResponse(secret),
      status: 400,
    })),
  ]
}

const initialGlobalConfig = Global.Path.config
let testGlobalConfig: string | undefined

async function reset() {
  await Instance.disposeAll()
  if (testGlobalConfig) {
    ;(Global.Path as { config: string }).config = initialGlobalConfig
    await AppRuntime.runPromise(Config.Service.use((config) => config.invalidate(true)))
    await fs.rm(testGlobalConfig, { recursive: true, force: true })
    testGlobalConfig = undefined
  }
  await resetDatabase()
}

async function bootstrap(directory: string, baseURL: string) {
  testGlobalConfig = path.join(directory, ".test-global-config")
  await fs.mkdir(testGlobalConfig, { recursive: true })
  await Bun.write(path.join(testGlobalConfig, "provider-settings.json"), JSON.stringify(providerConfig(baseURL)))
  ;(Global.Path as { config: string }).config = testGlobalConfig
  await AppRuntime.runPromise(Config.Service.use((config) => config.invalidate(true)))
  return Instance.provide({
    directory,
    fn: () =>
      AppRuntime.runPromise(
        Company.Service.use((company) =>
          company.bootstrap(
            BootstrapInput.parse({
              request_id: "018f84f8-9c21-7d4d-a850-d63f8f9344cf",
              company_name: "Agent Company",
              provider_id: "m2-test",
              model_id: "test-model",
              repository_path: directory,
            }),
          ),
        ),
      ),
  })
}

async function start(directory: string, runID: (typeof ConversationRunTable.$inferSelect)["id"]) {
  return Instance.provide({
    directory,
    fn: () => AppRuntime.runPromise(ConversationRuntime.Service.use((runtime) => runtime.start(runID))),
  })
}

async function recover(directory: string) {
  return Instance.provide({
    directory,
    fn: () => AppRuntime.runPromise(ConversationRuntime.Service.use((runtime) => runtime.recover())),
  })
}

async function groupSession<A, E>(directory: string, fn: (service: GroupSession.Interface) => Effect.Effect<A, E>) {
  return Instance.provide({
    directory,
    fn: () => AppRuntime.runPromise(GroupSession.Service.use(fn)),
  })
}

async function waitFor(check: () => boolean | Promise<boolean>, attempts = 200): Promise<void> {
  if (await check()) return
  if (attempts === 0) throw new Error("Conversation runtime did not persist an agent source")
  await Bun.sleep(10)
  return waitFor(check, attempts - 1)
}

beforeEach(reset)
afterEach(reset)

describe.serial("M2 conversation runtime", () => {
  test.serial(
    "uses the repository-bound Instance and preserves an exact GroupSession to AgentRun source chain",
    async () => {
      const server = startScriptedLLMServer(
        boardTurnResponses({ lines: textStopResponse("The selected board member completed the requested review.") }),
      )
      const repository = await tmpdir({
        git: true,
        config: { checkpoint: { memory_reconcile_on_search: false } },
      })

      try {
        await bootstrap(repository.path, `${server.origin}/v1`)
        const accepted = await Effect.runPromise(
          Conversation.Service.use((conversation) =>
            conversation.sendMessage({
              companyID,
              channelID: BOARD_CHANNEL_ID,
              principal: { kind: "user", id: "usr_local" },
              requestID: "018f84f8-9c21-7d4d-a850-d63f8f9344d0",
              body: "Run the real M2 board runtime from the imported repository.",
              intentOverride: "execute",
            }),
          ).pipe(Effect.provide(Conversation.layer)),
        )
        expect(accepted.runID).toBeString()

        const started = await start(repository.path, accepted.runID!)
        const replayed = await start(repository.path, accepted.runID!)
        expect(replayed).toEqual(started)
        expect(
          Database.use((db) =>
            db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get(),
          ),
        ).toMatchObject({
          state: "running",
          runtime_id: started.groupSessionID,
          runtime_round_num: started.roundNum,
        })

        const binding = Database.use((db) =>
          db.select().from(RepositoryBindingTable).where(eq(RepositoryBindingTable.company_id, companyID)).get(),
        )
        const group = Database.use((db) =>
          db.select().from(GroupSessionTable).where(eq(GroupSessionTable.id, started.groupSessionID)).get(),
        )
        expect(group).toMatchObject({ project_id: binding?.project_id, context_policy: "work_scoped" })

        await waitFor(() =>
          Database.use((db) =>
            db
              .select()
              .from(GroupMessageTable)
              .where(eq(GroupMessageTable.group_session_id, started.groupSessionID))
              .all()
              .some((message) => message.agent_run_id),
          ),
        )
        await waitFor(
          () =>
            Database.use((db) => {
              const run = db
                .select()
                .from(ConversationRunTable)
                .where(eq(ConversationRunTable.id, accepted.runID!))
                .get()
              return run?.state === "completed" || run?.state === "failed"
            }),
          1_000,
        )
        const messages = Database.use((db) =>
          db
            .select()
            .from(GroupMessageTable)
            .where(eq(GroupMessageTable.group_session_id, started.groupSessionID))
            .all(),
        )
        const userMessage = messages.find((message) => message.role === "user")
        const agentMessage = messages.find((message) => message.role === "agent" && message.agent_run_id)

        expect(userMessage?.external_message_id).toBe(accepted.messageID)
        expect(agentMessage?.agent_run_id).toBeString()
        expect(
          Database.use((db) =>
            db.select().from(AgentRunTable).where(eq(AgentRunTable.id, agentMessage!.agent_run_id!)).get(),
          ),
        ).toMatchObject({
          id: agentMessage!.agent_run_id,
          group_session_id: started.groupSessionID,
          state: "completed",
          model: "m2-test/test-model",
          cwd: repository.path,
        })
        expect(
          Database.use((db) =>
            db
              .select()
              .from(AgentRunEventTable)
              .where(eq(AgentRunEventTable.agent_run_id, agentMessage!.agent_run_id!))
              .all()
              .some((event) => event.type === "runtime.completed"),
          ),
        ).toBe(true)
        await Instance.disposeAll()
        await Bun.sleep(500)
      } finally {
        await Instance.disposeAll()
        await resetDatabase()
        await Bun.sleep(500)
        await server.stop()
        await repository[Symbol.asyncDispose]()
      }
    },
  )

  test.serial("serializes concurrent starts of the same persisted runtime binding", async () => {
    const server = startScriptedLLMServer(
      Array.from({ length: 32 }, () => ({
        lines: textStopResponse('{"level":"pass","type":"info","addressedAs":"none","reason":"not needed"}'),
      })),
    )
    const repository = await tmpdir({
      git: true,
      config: { checkpoint: { memory_reconcile_on_search: false } },
    })

    try {
      await bootstrap(repository.path, `${server.origin}/v1`)
      const accepted = await Effect.runPromise(
        Conversation.Service.use((conversation) =>
          conversation.sendMessage({
            companyID,
            channelID: BOARD_CHANNEL_ID,
            principal: { kind: "user", id: "usr_local" },
            requestID: "018f84f8-9c21-7d4d-a850-d63f8f9344d8",
            body: "Start this persisted board runtime exactly once.",
            intentOverride: "execute",
          }),
        ).pipe(Effect.provide(Conversation.layer)),
      )
      const reservedGroupSessionID = GroupSessionID.ascending()
      await groupSession(repository.path, (service) =>
        service.create({
          id: reservedGroupSessionID,
          title: "Concurrent M2 board start",
          agentIDs: ["board-ceo", "board-cto", "board-product-lead"],
          contextPolicy: "work_scoped",
        }),
      )
      Database.use((db) =>
        db
          .update(ConversationRunTable)
          .set({
            state: "running",
            runtime_id: reservedGroupSessionID,
            runtime_round_num: null,
            time_started: Date.now(),
            time_updated: Date.now(),
          })
          .where(eq(ConversationRunTable.id, accepted.runID!))
          .run(),
      )

      const started = await Instance.provide({
        directory: repository.path,
        fn: () =>
          AppRuntime.runPromise(
            ConversationRuntime.Service.use((runtime) =>
              Effect.all([runtime.start(accepted.runID!), runtime.start(accepted.runID!)], {
                concurrency: "unbounded",
              }),
            ),
          ),
      })
      expect(started[1]).toEqual(started[0])
      expect(
        Database.use((db) =>
          db
            .select()
            .from(GroupMessageTable)
            .where(eq(GroupMessageTable.group_session_id, reservedGroupSessionID))
            .all()
            .filter((message) => message.external_message_id === accepted.messageID),
        ),
      ).toHaveLength(1)
      expect(
        Database.use((db) =>
          db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get(),
        ),
      ).toMatchObject({ state: "running", runtime_id: reservedGroupSessionID, runtime_round_num: started[0].roundNum })
      await waitFor(
        () =>
          Database.use((db) => {
            const run = db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get()
            return run?.state === "completed" || run?.state === "failed"
          }),
        1_000,
      )
    } finally {
      await Instance.disposeAll()
      await resetDatabase()
      await Bun.sleep(500)
      await server.stop()
      await repository[Symbol.asyncDispose]()
    }
  })

  test.serial("projects one grounded high signal after the selected board member publishes it", async () => {
    const server = startScriptedLLMServer(
      boardTurnResponses(
        {
          lines: toolCallResponse({
            id: "publish-board-risk",
            name: "publish_signal",
            args: JSON.stringify({
              signal_type: "risk",
              body: "The board identified a provider smoke-test risk before release.",
            }),
          }),
        },
        { lines: textStopResponse("The provider smoke-test risk is now recorded.") },
      ),
    )
    const repository = await tmpdir({
      git: true,
      config: { checkpoint: { memory_reconcile_on_search: false } },
    })

    try {
      await bootstrap(repository.path, `${server.origin}/v1`)
      const accepted = await Effect.runPromise(
        Conversation.Service.use((conversation) =>
          conversation.sendMessage({
            companyID,
            channelID: BOARD_CHANNEL_ID,
            principal: { kind: "user", id: "usr_local" },
            requestID: "018f84f8-9c21-7d4d-a850-d63f8f9344d3",
            body: "Assess the provider risk before we release.",
            intentOverride: "execute",
          }),
        ).pipe(Effect.provide(Conversation.layer)),
      )
      const started = await start(repository.path, accepted.runID!)

      await waitFor(
        () =>
          Database.use((db) => {
            const run = db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get()
            return run?.state === "completed" || run?.state === "failed"
          }),
        1_000,
      )
      expect(
        Database.use((db) =>
          db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get(),
        ),
      ).toMatchObject({ state: "completed" })
      const projection = Database.use((db) =>
        db
          .select()
          .from(SignalProjectionTable)
          .where(eq(SignalProjectionTable.conversation_run_id, accepted.runID!))
          .get(),
      )
      const highSignal = projection
        ? Database.use((db) =>
            db
              .select()
              .from(ChannelMessageTable)
              .where(eq(ChannelMessageTable.id, projection.channel_message_id))
              .get(),
          )
        : undefined
      expect(highSignal).toMatchObject({
        signal_type: "risk",
        author_kind: "agent",
        source_thread_id: accepted.threadID,
      })
      if (!highSignal) throw new Error("Expected a projected governance signal")
      expect(["board-ceo", "board-cto", "board-product-lead"]).toContain(highSignal.author_id)
      expect(
        projection
          ? Database.use((db) =>
              db
                .select()
                .from(SignalProjectionSourceTable)
                .where(eq(SignalProjectionSourceTable.signal_projection_id, projection.id))
                .all(),
            ).length
          : 0,
      ).toBeGreaterThan(1)
      expect(started.roundNum).toBe(0)
    } finally {
      await Instance.disposeAll()
      await resetDatabase()
      await Bun.sleep(500)
      await server.stop()
      await repository[Symbol.asyncDispose]()
    }
  })

  test.serial("recovers a queued committed board input after a process exit", async () => {
    const server = startScriptedLLMServer(
      boardTurnResponses(
        {
          lines: toolCallResponse({
            id: "publish-recovered-status",
            name: "publish_signal",
            args: JSON.stringify({
              signal_type: "status",
              body: "The recovered board run completed its provider review.",
            }),
          }),
        },
        { lines: textStopResponse("The recovered status is now recorded.") },
      ),
    )
    const repository = await tmpdir({
      git: true,
      config: { checkpoint: { memory_reconcile_on_search: false } },
    })

    try {
      await bootstrap(repository.path, `${server.origin}/v1`)
      const accepted = await Effect.runPromise(
        Conversation.Service.use((conversation) =>
          conversation.sendMessage({
            companyID,
            channelID: BOARD_CHANNEL_ID,
            principal: { kind: "user", id: "usr_local" },
            requestID: "018f84f8-9c21-7d4d-a850-d63f8f9344d5",
            body: "Recover this committed board request.",
            intentOverride: "execute",
          }),
        ).pipe(Effect.provide(Conversation.layer)),
      )
      expect(await recover(repository.path)).toEqual([accepted.runID!])
      await waitFor(
        () =>
          Database.use(
            (db) =>
              db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get()
                ?.state === "completed",
          ),
        1_000,
      )
      expect(
        Database.use((db) =>
          db
            .select()
            .from(SignalProjectionTable)
            .where(eq(SignalProjectionTable.conversation_run_id, accepted.runID!))
            .all(),
        ),
      ).toHaveLength(1)
    } finally {
      await Instance.disposeAll()
      await resetDatabase()
      await Bun.sleep(500)
      await server.stop()
      await repository[Symbol.asyncDispose]()
    }
  })

  test.serial(
    "recreates a persisted runtime binding when the process exited before GroupSession creation",
    async () => {
      const server = startScriptedLLMServer(
        Array.from({ length: 32 }, () => ({
          lines: textStopResponse('{"level":"pass","type":"info","addressedAs":"none","reason":"not needed"}'),
        })),
      )
      const repository = await tmpdir({
        git: true,
        config: { checkpoint: { memory_reconcile_on_search: false } },
      })

      try {
        await bootstrap(repository.path, `${server.origin}/v1`)
        const accepted = await Effect.runPromise(
          Conversation.Service.use((conversation) =>
            conversation.sendMessage({
              companyID,
              channelID: BOARD_CHANNEL_ID,
              principal: { kind: "user", id: "usr_local" },
              requestID: "018f84f8-9c21-7d4d-a850-d63f8f9344d7",
              body: "Recover the board binding created before the runtime group.",
              intentOverride: "execute",
            }),
          ).pipe(Effect.provide(Conversation.layer)),
        )
        const reservedGroupSessionID = GroupSessionID.ascending()
        Database.use((db) =>
          db
            .update(ConversationRunTable)
            .set({
              state: "running",
              runtime_id: reservedGroupSessionID,
              runtime_round_num: null,
              time_started: Date.now(),
              time_updated: Date.now(),
            })
            .where(eq(ConversationRunTable.id, accepted.runID!))
            .run(),
        )

        expect(await recover(repository.path)).toEqual([accepted.runID!])
        expect(
          Database.use((db) =>
            db.select().from(GroupSessionTable).where(eq(GroupSessionTable.id, reservedGroupSessionID)).get(),
          ),
        ).toMatchObject({ id: reservedGroupSessionID, context_policy: "work_scoped" })
        expect(
          Database.use((db) =>
            db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get(),
          ),
        ).toMatchObject({ runtime_id: reservedGroupSessionID })
      } finally {
        await Instance.disposeAll()
        await resetDatabase()
        await Bun.sleep(500)
        await server.stop()
        await repository[Symbol.asyncDispose]()
      }
    },
  )

  test.serial(
    "recovers a board round after its first agent response without duplicating persisted sources",
    async () => {
      const server = startScriptedLLMServer(
        boardTurnResponses({ lines: textStopResponse("A remaining board member completed the resumed discussion.") }),
      )
      const repository = await tmpdir({
        git: true,
        config: { checkpoint: { memory_reconcile_on_search: false } },
      })

      try {
        await bootstrap(repository.path, `${server.origin}/v1`)
        const accepted = await Effect.runPromise(
          Conversation.Service.use((conversation) =>
            conversation.sendMessage({
              companyID,
              channelID: BOARD_CHANNEL_ID,
              principal: { kind: "user", id: "usr_local" },
              requestID: "018f84f8-9c21-7d4d-a850-d63f8f9344d6",
              body: "Resume the persisted board discussion after its first response.",
              intentOverride: "execute",
            }),
          ).pipe(Effect.provide(Conversation.layer)),
        )
        const group = await groupSession(repository.path, (service) =>
          service.create({
            title: "Resume an interrupted M2 board round",
            agentIDs: ["board-ceo", "board-cto", "board-product-lead"],
            contextPolicy: "work_scoped",
          }),
        )
        const firstMember = Database.use((db) =>
          db
            .select()
            .from(GroupSessionMemberTable)
            .where(eq(GroupSessionMemberTable.group_session_id, group.id))
            .orderBy(GroupSessionMemberTable.position)
            .get(),
        )
        if (!firstMember) throw new Error("Board group has no members")

        const time = Date.now()
        Database.use((db) => {
          db.insert(GroupMessageTable)
            .values([
              {
                id: "gmsg_runtime-recovery-user",
                group_session_id: group.id,
                round_num: 0,
                role: "user",
                content: "Resume the persisted board discussion after its first response.",
                external_message_id: accepted.messageID,
                time_created: time,
                time_updated: time,
              },
              {
                id: "gmsg_runtime-recovery-agent",
                group_session_id: group.id,
                round_num: 0,
                role: "agent",
                company_agent_id: firstMember.company_agent_id,
                session_id: firstMember.session_id,
                content: "The first board member completed before the process stopped.",
                status_summary: "done",
                time_created: time + 1,
                time_updated: time + 1,
              },
            ])
            .run()
          db.update(ConversationRunTable)
            .set({
              state: "running",
              runtime_id: group.id,
              runtime_round_num: 0,
              time_started: time,
              time_updated: time,
            })
            .where(eq(ConversationRunTable.id, accepted.runID!))
            .run()
        })

        expect(await recover(repository.path)).toEqual([accepted.runID!])
        await waitFor(
          () =>
            Database.use(
              (db) =>
                db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get()
                  ?.state === "completed",
            ),
          1_000,
        )
        const messages = Database.use((db) =>
          db
            .select()
            .from(GroupMessageTable)
            .where(eq(GroupMessageTable.group_session_id, group.id))
            .orderBy(GroupMessageTable.time_created)
            .all(),
        )
        expect(messages.filter((message) => message.role === "user")).toHaveLength(1)
        expect(messages.filter((message) => message.role === "agent")).toHaveLength(2)
        expect(messages.filter((message) => message.role === "agent")[0]?.company_agent_id).toBe(
          firstMember.company_agent_id,
        )
        expect(messages.filter((message) => message.company_agent_id === firstMember.company_agent_id)).toHaveLength(1)
      } finally {
        await Instance.disposeAll()
        await resetDatabase()
        await Bun.sleep(500)
        await server.stop()
        await repository[Symbol.asyncDispose]()
      }
    },
  )

  test.serial("persists a safe retryable failure without provider or prompt leakage", async () => {
    const secret = "M2_PROVIDER_SECRET_DO_NOT_PERSIST"
    const server = startScriptedLLMServer(boardFailureResponses(secret))
    const repository = await tmpdir({
      git: true,
      config: { checkpoint: { memory_reconcile_on_search: false } },
    })

    try {
      await bootstrap(repository.path, `${server.origin}/v1`)
      const accepted = await Effect.runPromise(
        Conversation.Service.use((conversation) =>
          conversation.sendMessage({
            companyID,
            channelID: BOARD_CHANNEL_ID,
            principal: { kind: "user", id: "usr_local" },
            requestID: "018f84f8-9c21-7d4d-a850-d63f8f9344d4",
            body: "Assess the private provider failure boundary.",
            intentOverride: "execute",
          }),
        ).pipe(Effect.provide(Conversation.layer)),
      )
      await start(repository.path, accepted.runID!)
      await waitFor(
        () =>
          Database.use(
            (db) =>
              db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get()
                ?.state === "failed",
          ),
        1_000,
      )
      const run = Database.use((db) =>
        db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get(),
      )
      expect(run).toMatchObject({ state: "failed", attempt: 1, retryable: true })
      expect(run?.safe_error_summary).toBe(
        "模型提供方不可用或未配置 API Key。请在设置中重新连接 Provider、配置 API Key，或切换到可用模型后重试。",
      )
      expect(run?.safe_error_summary).not.toContain(secret)
      expect(run?.safe_error_summary).not.toContain("StructuredOutput")
      expect(server.captures).toHaveLength(4)
    } finally {
      await Instance.disposeAll()
      await resetDatabase()
      await Bun.sleep(500)
      await server.stop()
      await repository[Symbol.asyncDispose]()
    }
  })

  test.serial("does not project signal-shaped markdown without an explicit governance event", async () => {
    const server = startScriptedLLMServer(
      boardTurnResponses({
        lines: textStopResponse(
          '```json\n{"publish":true,"signal_type":"conclusion","body":"The board agreed to validate the provider before release."}\n```',
        ),
      }),
    )
    const repository = await tmpdir({
      git: true,
      config: { checkpoint: { memory_reconcile_on_search: false } },
    })

    try {
      await bootstrap(repository.path, `${server.origin}/v1`)
      const accepted = await Effect.runPromise(
        Conversation.Service.use((conversation) =>
          conversation.sendMessage({
            companyID,
            channelID: BOARD_CHANNEL_ID,
            principal: { kind: "user", id: "usr_local" },
            requestID: "018f84f8-9c21-7d4d-a850-d63f8f9344d8",
            body: "Decide whether the provider is ready for release.",
            intentOverride: "execute",
          }),
        ).pipe(Effect.provide(Conversation.layer)),
      )
      await start(repository.path, accepted.runID!)
      await waitFor(
        () =>
          Database.use(
            (db) =>
              db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get()
                ?.state === "completed",
          ),
        1_000,
      )
      expect(
        Database.use((db) =>
          db
            .select()
            .from(SignalProjectionTable)
            .where(eq(SignalProjectionTable.conversation_run_id, accepted.runID!))
            .get(),
        ),
      ).toBeUndefined()
    } finally {
      await Instance.disposeAll()
      await resetDatabase()
      await Bun.sleep(500)
      await server.stop()
      await repository[Symbol.asyncDispose]()
    }
  })

  test.serial("does not project a signal from a board turn that fails after publishing", async () => {
    const secret = "M2_TEXT_SUMMARY_PROVIDER_SECRET_DO_NOT_PERSIST"
    const server = startScriptedLLMServer(
      boardFailureResponses(secret, {
        lines: toolCallResponse({
          id: "publish-before-failure",
          name: "publish_signal",
          args: JSON.stringify({
            signal_type: "risk",
            body: "This signal must not be projected from a failed turn.",
          }),
        }),
      }),
    )
    const repository = await tmpdir({
      git: true,
      config: { checkpoint: { memory_reconcile_on_search: false } },
    })

    try {
      await bootstrap(repository.path, `${server.origin}/v1`)
      const accepted = await Effect.runPromise(
        Conversation.Service.use((conversation) =>
          conversation.sendMessage({
            companyID,
            channelID: BOARD_CHANNEL_ID,
            principal: { kind: "user", id: "usr_local" },
            requestID: "018f84f8-9c21-7d4d-a850-d63f8f9344d9",
            body: "Assess the provider failure boundary for a board summary.",
            intentOverride: "execute",
          }),
        ).pipe(Effect.provide(Conversation.layer)),
      )
      await start(repository.path, accepted.runID!)
      await waitFor(
        () =>
          Database.use(
            (db) =>
              db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get()
                ?.state === "failed",
          ),
        1_000,
      )
      const run = Database.use((db) =>
        db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get(),
      )
      expect(run).toMatchObject({ state: "failed", attempt: 1, retryable: true })
      expect(run?.safe_error_summary).toBe(
        "模型提供方不可用或未配置 API Key。请在设置中重新连接 Provider、配置 API Key，或切换到可用模型后重试。",
      )
      expect(run?.safe_error_summary).not.toContain(secret)
      expect(
        Database.use((db) =>
          db
            .select()
            .from(SignalProjectionTable)
            .where(eq(SignalProjectionTable.conversation_run_id, accepted.runID!))
            .get(),
        ),
      ).toBeUndefined()
    } finally {
      await Instance.disposeAll()
      await resetDatabase()
      await Bun.sleep(500)
      await server.stop()
      await repository[Symbol.asyncDispose]()
    }
  })
})
