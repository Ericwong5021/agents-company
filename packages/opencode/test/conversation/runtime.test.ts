import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Company } from "../../src/company"
import { RepositoryBindingTable } from "../../src/company/company.sql"
import { BootstrapInput, CompanyID } from "../../src/company/schema"
import { Conversation } from "../../src/conversation"
import { ConversationRunTable } from "../../src/conversation/conversation.sql"
import { ConversationRuntime } from "../../src/conversation/runtime"
import { BOARD_CHANNEL_ID } from "../../src/conversation/conversation.sql"
import { AppRuntime } from "../../src/effect/app-runtime"
import { GroupSession } from "../../src/group-session"
import { GroupMessageTable, GroupSessionTable } from "../../src/group-session/group-session.sql"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import type { MessageID, SessionID } from "../../src/session/schema"
import { eq } from "../../src/storage"
import * as Database from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse } from "../lib/scripted-llm-server"

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

async function start(directory: string, runID: ConversationRunTable["$inferSelect"]["id"]) {
  return Instance.provide({
    directory,
    fn: () => AppRuntime.runPromise(ConversationRuntime.Service.use((runtime) => runtime.start(runID))),
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
      Array.from({ length: 16 }, () => ({
        lines: textStopResponse('{"level":"pass","type":"info","addressedAs":"none","reason":"not needed"}'),
      })),
    )

    try {
      await using repository = await tmpdir({ git: true, config: providerConfig(`${server.origin}/v1`) })
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
      await Instance.provide({
        directory: repository.path,
        fn: () => AppRuntime.runPromise(GroupSession.Service.use((service) => service.interrupt(started.groupSessionID))),
      })
      await waitFor(
        () =>
          Instance.provide({
            directory: repository.path,
            fn: () => AppRuntime.runPromise(GroupSession.Service.use((service) => service.isBusy(started.groupSessionID))),
          }).then((busy) => !busy),
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
      expect(source.info.id).toBe(agentMessage!.runtime_message_id)
      expect(source.parts.length).toBeGreaterThan(0)
      await Instance.disposeAll()
      await Bun.sleep(500)
    } finally {
      await server.stop()
    }
  })
})
