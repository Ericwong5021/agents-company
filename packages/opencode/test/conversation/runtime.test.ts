import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Company } from "../../src/company"
import { RepositoryBindingTable } from "../../src/company/company.sql"
import { BootstrapInput, CompanyID } from "../../src/company/schema"
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
import { GroupSession } from "../../src/group-session"
import { GroupMessageTable, GroupSessionMemberTable, GroupSessionTable } from "../../src/group-session/group-session.sql"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import type { MessageID, SessionID } from "../../src/session/schema"
import { eq } from "../../src/storage"
import * as Database from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse, toolCallResponse } from "../lib/scripted-llm-server"

const companyID = CompanyID.parse("cmp_local")

function providerConfig(baseURL: string) {
  return {
    model: "m2-test/test-model",
    small_model: "m2-test/test-model",
    checkpoint: { memory_reconcile_on_search: false },
    provider: {
      "m2-test": {
        name: "M2 Test",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: {
          "test-model": {
            name: "Test Model",
            tool_call: true,
            limit: { context: 8_000, output: 2_000 },
          },
        },
        options: { apiKey: "test-key", baseURL },
      },
    },
  }
}

async function reset() {
  await Instance.disposeAll()
  await resetDatabase()
}

async function bootstrap(directory: string) {
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

async function start(directory: string, runID: typeof ConversationRunTable.$inferSelect["id"]) {
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
  test.serial("uses the repository-bound Instance and preserves an exact GroupSession to MessageV2 source chain", async () => {
    const server = startScriptedLLMServer(
      Array.from({ length: 32 }, () => ({
        lines: textStopResponse('{"level":"pass","type":"info","addressedAs":"none","reason":"not needed"}'),
      })),
    )
    const repository = await tmpdir({ git: true, config: providerConfig(`${server.origin}/v1`) })

    try {
      await bootstrap(repository.path)
      const accepted = await Effect.runPromise(
        Conversation.Service.use((conversation) =>
          conversation.sendMessage({
            companyID,
            channelID: BOARD_CHANNEL_ID,
            principal: { kind: "user", id: "usr_local" },
            requestID: "018f84f8-9c21-7d4d-a850-d63f8f9344d0",
            body: "Run the real M2 board runtime from the imported repository.",
          }),
        ).pipe(Effect.provide(Conversation.layer)),
      )
      expect(accepted.runID).toBeString()

      const started = await start(repository.path, accepted.runID!)
      const replayed = await start(repository.path, accepted.runID!)
      expect(replayed).toEqual(started)
      expect(
        Database.use((db) => db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get()),
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
            .some((message) => message.runtime_message_id),
        ),
      )
      await waitFor(
        () =>
          Database.use((db) => {
            const run = db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get()
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
      const agentMessage = messages.find((message) => message.role === "agent" && message.runtime_message_id)

      expect(userMessage?.external_message_id).toBe(accepted.messageID)
      expect(agentMessage?.runtime_message_id).toBeString()
      const source = MessageV2.get({
        sessionID: agentMessage!.session_id as SessionID,
        messageID: agentMessage!.runtime_message_id as MessageID,
      })
      expect(source.info.id).toBe(agentMessage!.runtime_message_id!)
      expect(source.parts.length).toBeGreaterThan(0)
      await Instance.disposeAll()
      await Bun.sleep(500)
    } finally {
      await Instance.disposeAll()
      await resetDatabase()
      await Bun.sleep(500)
      await server.stop()
      await repository[Symbol.asyncDispose]()
    }
  })

  test.serial("synthesizes one grounded Product Lead high signal after the board round completes", async () => {
    const requests: Array<{ tools?: Array<{ function?: { name?: string } }> }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { tools?: Array<{ function?: { name?: string } }> }
        requests.push(body)
        const structured = body.tools?.some((tool) => tool.function?.name === "StructuredOutput")
        const lines = structured
          ? toolCallResponse({
              id: "structured-output",
              name: "StructuredOutput",
              args: JSON.stringify({
                publish: true,
                signal_type: "risk",
                body: "The board identified a provider smoke-test risk before release.",
              }),
            })
          : textStopResponse('{"level":"pass","type":"info","addressedAs":"none","reason":"not needed"}')
        return new Response(lines.join(""), { headers: { "Content-Type": "text/event-stream" } })
      },
    })
    const repository = await tmpdir({ git: true, config: providerConfig(`${server.url.origin}/v1`) })

    try {
      await bootstrap(repository.path)
      const accepted = await Effect.runPromise(
        Conversation.Service.use((conversation) =>
          conversation.sendMessage({
            companyID,
            channelID: BOARD_CHANNEL_ID,
            principal: { kind: "user", id: "usr_local" },
            requestID: "018f84f8-9c21-7d4d-a850-d63f8f9344d3",
            body: "Assess the provider risk before we release.",
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
        Database.use((db) => db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get()),
      ).toMatchObject({ state: "completed" })
      const projection = Database.use((db) =>
        db
          .select()
          .from(SignalProjectionTable)
          .where(eq(SignalProjectionTable.conversation_run_id, accepted.runID!))
          .get(),
      )
      const highSignal = projection
        ? Database.use((db) => db.select().from(ChannelMessageTable).where(eq(ChannelMessageTable.id, projection.channel_message_id)).get())
        : undefined
      expect(highSignal).toMatchObject({
        signal_type: "risk",
        author_kind: "agent",
        author_id: "board-product-lead",
        source_thread_id: accepted.threadID,
      })
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
      expect(requests.some((request) => request.tools?.some((tool) => tool.function?.name === "StructuredOutput"))).toBe(true)
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
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { tools?: Array<{ function?: { name?: string } }> }
        const structured = body.tools?.some((tool) => tool.function?.name === "StructuredOutput")
        const lines = structured
          ? toolCallResponse({
              id: "recovered-structured-output",
              name: "StructuredOutput",
              args: JSON.stringify({
                publish: true,
                signal_type: "status",
                body: "The recovered board run completed its provider review.",
              }),
            })
          : textStopResponse('{"level":"pass","type":"info","addressedAs":"none","reason":"not needed"}')
        return new Response(lines.join(""), { headers: { "Content-Type": "text/event-stream" } })
      },
    })
    const repository = await tmpdir({ git: true, config: providerConfig(`${server.url.origin}/v1`) })

    try {
      await bootstrap(repository.path)
      const accepted = await Effect.runPromise(
        Conversation.Service.use((conversation) =>
          conversation.sendMessage({
            companyID,
            channelID: BOARD_CHANNEL_ID,
            principal: { kind: "user", id: "usr_local" },
            requestID: "018f84f8-9c21-7d4d-a850-d63f8f9344d5",
            body: "Recover this committed board request.",
          }),
        ).pipe(Effect.provide(Conversation.layer)),
      )
      expect(await recover(repository.path)).toEqual([accepted.runID!])
      await waitFor(
        () =>
          Database.use((db) =>
            db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get()?.state === "completed",
          ),
        1_000,
      )
      expect(
        Database.use((db) =>
          db.select().from(SignalProjectionTable).where(eq(SignalProjectionTable.conversation_run_id, accepted.runID!)).all(),
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

  test.serial("recovers a board round after its first agent response without duplicating persisted sources", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { tools?: Array<{ function?: { name?: string } }> }
        const structured = body.tools?.some((tool) => tool.function?.name === "StructuredOutput")
        const lines = structured
          ? toolCallResponse({
              id: "resumed-structured-output",
              name: "StructuredOutput",
              args: JSON.stringify({
                publish: true,
                signal_type: "conclusion",
                body: "The recovered board round retained its first response and reached a conclusion.",
              }),
            })
          : textStopResponse('{"level":"pass","type":"info","addressedAs":"none","reason":"not needed"}')
        return new Response(lines.join(""), { headers: { "Content-Type": "text/event-stream" } })
      },
    })
    const repository = await tmpdir({ git: true, config: providerConfig(`${server.url.origin}/v1`) })

    try {
      await bootstrap(repository.path)
      const accepted = await Effect.runPromise(
        Conversation.Service.use((conversation) =>
          conversation.sendMessage({
            companyID,
            channelID: BOARD_CHANNEL_ID,
            principal: { kind: "user", id: "usr_local" },
            requestID: "018f84f8-9c21-7d4d-a850-d63f8f9344d6",
            body: "Resume the persisted board discussion after its first response.",
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
          Database.use((db) =>
            db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get()?.state === "completed",
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
      expect(messages.filter((message) => message.role === "agent")[0]?.company_agent_id).toBe(firstMember.company_agent_id)
      expect(messages.filter((message) => message.role === "agent")[1]?.company_agent_id).not.toBe(firstMember.company_agent_id)
    } finally {
      await Instance.disposeAll()
      await resetDatabase()
      await Bun.sleep(500)
      await server.stop()
      await repository[Symbol.asyncDispose]()
    }
  })

  test.serial("persists a safe retryable failure without provider or prompt leakage", async () => {
    const secret = "M2_PROVIDER_SECRET_DO_NOT_PERSIST"
    const server = startScriptedLLMServer(
      Array.from({ length: 32 }, () => ({
        lines: textStopResponse(`{"level":"pass","type":"info","addressedAs":"none","reason":"${secret}"}`),
      })),
    )
    const repository = await tmpdir({ git: true, config: providerConfig(`${server.origin}/v1`) })

    try {
      await bootstrap(repository.path)
      const accepted = await Effect.runPromise(
        Conversation.Service.use((conversation) =>
          conversation.sendMessage({
            companyID,
            channelID: BOARD_CHANNEL_ID,
            principal: { kind: "user", id: "usr_local" },
            requestID: "018f84f8-9c21-7d4d-a850-d63f8f9344d4",
            body: "Assess the private provider failure boundary.",
          }),
        ).pipe(Effect.provide(Conversation.layer)),
      )
      await start(repository.path, accepted.runID!)
      await waitFor(
        () =>
          Database.use((db) =>
            db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get()?.state === "failed",
          ),
        1_000,
      )
      const run = Database.use((db) =>
        db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, accepted.runID!)).get(),
      )
      expect(run).toMatchObject({ state: "failed", attempt: 1, retryable: true })
      expect(run?.safe_error_summary).toBe("The board discussion could not complete. Check the configured provider and retry.")
      expect(run?.safe_error_summary).not.toContain(secret)
      expect(run?.safe_error_summary).not.toContain("StructuredOutput")
    } finally {
      await Instance.disposeAll()
      await resetDatabase()
      await Bun.sleep(500)
      await server.stop()
      await repository[Symbol.asyncDispose]()
    }
  })
})
