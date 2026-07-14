import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { Company } from "../../src/company"
import { ChannelMessageTable, BOARD_CHANNEL_ID } from "../../src/conversation/conversation.sql"
import { ChannelMessageID } from "../../src/conversation/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { GroupSession } from "../../src/group-session"
import { Global } from "../../src/global"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionStatus } from "../../src/session/status"
import type { MessageID, SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { eq } from "../../src/storage"
import * as Database from "../../src/storage/db"
import { BootstrapInput } from "../../src/company/schema"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse } from "../lib/scripted-llm-server"

const boardAgents = ["board-ceo", "board-cto", "board-product-lead"]
const canary = "M2_PRIVATE_MEMORY_CANARY_DO_NOT_LEAK"

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
              request_id: "018f84f8-9c21-7d4d-a850-d63f8f9344ce",
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

async function groupSession<A, E>(directory: string, fn: (service: GroupSession.Interface) => Effect.Effect<A, E>) {
  return Instance.provide({
    directory,
    fn: () => AppRuntime.runPromise(GroupSession.Service.use(fn)),
  })
}

async function waitFor(check: () => Promise<boolean>, attempts = 200): Promise<void> {
  if (await check()) return
  if (attempts === 0) throw new Error("Group session did not settle")
  await Bun.sleep(10)
  return waitFor(check, attempts - 1)
}

beforeEach(reset)
afterEach(reset)

describe.serial("M2 GroupSession runtime source bridge", () => {
  test.serial("persists idempotent external input, exact MessageV2 sources, and excludes private memory in work scope", async () => {
    const server = startScriptedLLMServer(
      Array.from({ length: 16 }, () => ({
        lines: textStopResponse('{"level":"pass","type":"info","addressedAs":"none","reason":"not needed"}'),
      })),
    )

    try {
      await using repository = await tmpdir({ git: true, config: providerConfig(`${server.origin}/v1`) })
      await bootstrap(repository.path)

      const memoryPath = path.join(Global.Path.data, "agents", "board-ceo", "m2-work-scope-canary.md")
      await mkdir(path.dirname(memoryPath), { recursive: true })
      await Bun.write(memoryPath, `private-context boundary ${canary}\n`)

      try {
        const externalMessageID = ChannelMessageID.parse(Identifier.ascending("channelMessage"))
        Database.use((db) =>
          db
            .insert(ChannelMessageTable)
            .values({
              id: externalMessageID,
              channel_id: BOARD_CHANNEL_ID,
              author_kind: "user",
              author_id: "usr_local",
              body: "Discuss the M2 private-context boundary.",
              visibility: "channel",
              mentions: [],
              time_created: Date.now(),
              time_updated: Date.now(),
            })
            .run(),
        )

        const group = await groupSession(repository.path, (service) =>
          service.create({
            title: "M2 source bridge",
            agentIDs: boardAgents,
            contextPolicy: "work_scoped",
          }),
        )
        const accepted = await groupSession(repository.path, (service) =>
          service.chat({
            groupSessionID: group.id,
            text: "Discuss the M2 private-context boundary.",
            externalMessageID,
          }),
        )
        const replayed = await groupSession(repository.path, (service) =>
          service.chat({
            groupSessionID: group.id,
            text: "Discuss the M2 private-context boundary.",
            externalMessageID,
          }),
        )

        expect(replayed).toEqual(accepted)
        await waitFor(async () =>
          groupSession(repository.path, (service) =>
            Effect.gen(function* () {
              const messages = yield* service.messages(group.id)
              return !(yield* service.isBusy(group.id)) && messages.filter((message) => message.runtimeMessageID).length >= 2
            }),
          ),
        )

        const messages = await groupSession(repository.path, (service) => service.messages(group.id))
        const userMessages = messages.filter((message) => message.role === "user")
        const agentMessage = messages.find((message) => message.role === "agent" && message.runtimeMessageID)

        expect(userMessages).toEqual([
          expect.objectContaining({
            id: accepted.userGroupMessageID,
            roundNum: accepted.roundNum,
            externalMessageID,
          }),
        ])
        expect(agentMessage?.runtimeMessageID).toBeString()
        expect(agentMessage?.sessionID).toBeString()
        const source = MessageV2.get({
          sessionID: agentMessage!.sessionID as SessionID,
          messageID: agentMessage!.runtimeMessageID as MessageID,
        })
        expect(source.info.id).toBe(agentMessage!.runtimeMessageID)
        expect(source.parts.length).toBeGreaterThan(0)
        expect(
          group.members.map(
            (member) =>
              Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, member.sessionID)).get())
                ?.company_agent_id,
          ),
        ).toEqual(["assistant", "assistant", "assistant"])
        expect(JSON.stringify(server.captures)).not.toContain(canary)
      } finally {
        await rm(memoryPath, { force: true })
      }
    } finally {
      await server.stop()
    }
  })

  test.serial("interrupt propagates to every Board runtime session", async () => {
    let calls = 0
    let promptStarted!: () => void
    const agentPromptStarted = new Promise<void>((resolve) => {
      promptStarted = resolve
    })
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        calls += 1
        if (calls <= 3) {
          return new Response(textStopResponse('{"level":"pass","type":"info","addressedAs":"none","reason":"not needed"}').join(""), {
            headers: { "Content-Type": "text/event-stream" },
          })
        }
        if (calls === 4) {
          return new Response(
            new ReadableStream({
              start(controller) {
                promptStarted()
                request.signal.addEventListener("abort", () => controller.close(), { once: true })
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          )
        }
        return new Response(textStopResponse('{"level":"pass","type":"info","addressedAs":"none","reason":"not needed"}').join(""), {
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })

    try {
      await using repository = await tmpdir({ git: true, config: providerConfig(`${server.url.origin}/v1`) })
      await bootstrap(repository.path)
      const group = await groupSession(repository.path, (service) =>
        service.create({ title: "M2 interrupt bridge", agentIDs: boardAgents, contextPolicy: "work_scoped" }),
      )
      await groupSession(repository.path, (service) => service.chat({ groupSessionID: group.id, text: "Start then interrupt." }))
      await agentPromptStarted
      await groupSession(repository.path, (service) => service.interrupt(group.id))
      server.stop(true)
      await waitFor(async () => groupSession(repository.path, (service) => service.isBusy(group.id).pipe(Effect.map((busy) => !busy))))
      const statuses = await Instance.provide({
        directory: repository.path,
        fn: () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const status = yield* SessionStatus.Service
              return yield* Effect.forEach(group.members, (member) => status.get(member.sessionID as SessionID))
            }),
          ),
      })
      expect(statuses).toEqual([{ type: "idle" }, { type: "idle" }, { type: "idle" }])
      await Instance.disposeAll()
    } finally {
      server.stop(true)
    }
  })
})
