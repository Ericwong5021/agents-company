import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { Company } from "../../src/company"
import { CompanyAgentTable } from "../../src/company-agent/company-agent.sql"
import { ChannelMessageTable, BOARD_CHANNEL_ID } from "../../src/conversation/conversation.sql"
import { ChannelMessageID } from "../../src/conversation/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { GroupSession } from "../../src/group-session"
import { GroupMessageTable, GroupSessionMemberTable } from "../../src/group-session/group-session.sql"
import { Global } from "../../src/global"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { SessionStatus } from "../../src/session/status"
import { SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { eq } from "../../src/storage"
import * as Database from "../../src/storage/db"

setDefaultTimeout(30_000)
import { BootstrapInput } from "../../src/company/schema"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse, toolCallResponse } from "../lib/scripted-llm-server"

const boardAgents = ["board-ceo", "board-cto", "board-product-lead"]
const canary = "M2_PRIVATE_MEMORY_CANARY_DO_NOT_LEAK"
const initialGlobalConfig = Global.Path.config
let testGlobalConfig: string | undefined

function providerConfig(baseURL: string, fallbackURL = baseURL) {
  return {
    model: "fallback-test/test-model",
    small_model: "fallback-test/test-model",
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
      "fallback-test": {
        name: "Fallback Test",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: {
          "test-model": {
            name: "Fallback Model",
            tool_call: true,
            limit: { context: 8_000, output: 2_000 },
          },
        },
        options: { apiKey: "test-key", baseURL: fallbackURL },
      },
    },
  }
}

async function reset() {
  await Instance.disposeAll()
  if (testGlobalConfig) {
    ;(Global.Path as { config: string }).config = initialGlobalConfig
    testGlobalConfig = undefined
  }
  await resetDatabase()
}

async function bootstrap(directory: string) {
  const config = path.join(directory, ".test-global-config")
  await mkdir(config, { recursive: true })
  await Bun.write(
    path.join(config, "provider-settings.json"),
    await Bun.file(path.join(directory, "agent-company.json")).text(),
  )
  ;(Global.Path as { config: string }).config = config
  testGlobalConfig = config
  const state = await Instance.provide({
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
  Database.use((db) => db.update(CompanyAgentTable).set({ preferred_runtime: "pi" }).run())
  return state
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
  test.serial("routes work-scoped structured prompts through the Company model", async () => {
    const companyServer = startScriptedLLMServer([
      {
        lines: toolCallResponse({
          id: "company-model-structured",
          name: "StructuredOutput",
          args: JSON.stringify({ publish: true }),
        }),
      },
    ])
    const fallbackServer = startScriptedLLMServer([
      { lines: textStopResponse("wrong model"), status: 503 },
    ])
    const repository = await tmpdir({
      git: true,
      config: providerConfig(`${companyServer.origin}/v1`, `${fallbackServer.origin}/v1`),
    })

    try {
      await bootstrap(repository.path)
      const group = await groupSession(repository.path, (service) =>
        service.create({ title: "Company structured routing", agentIDs: boardAgents, contextPolicy: "work_scoped" }),
      )
      const response = await groupSession(repository.path, (service) =>
        service.promptMember({
          groupSessionID: group.id,
          companyAgentID: "board-product-lead",
          text: "Return the structured result.",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { publish: { type: "boolean" } },
              required: ["publish"],
            },
            retryCount: 0,
          },
        }),
      )

      expect(response.info).toMatchObject({ role: "assistant", structured: { publish: true } })
      expect(companyServer.captures).toHaveLength(1)
      expect(fallbackServer.captures).toHaveLength(0)
    } finally {
      await Instance.disposeAll()
      await resetDatabase()
      await Bun.sleep(500)
      await Promise.all([companyServer.stop(), fallbackServer.stop()])
      await repository[Symbol.asyncDispose]()
    }
  }, 15_000)

  test.serial("persists idempotent external input, exact AgentRun sources, and excludes private memory in work scope", async () => {
    const server = startScriptedLLMServer(
      Array.from({ length: 16 }, () => ({
        lines: textStopResponse('{"level":"pass","type":"info","addressedAs":"none","reason":"not needed"}'),
      })),
    )
    const repository = await tmpdir({ git: true, config: providerConfig(`${server.origin}/v1`) })

    try {
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
              body: "Please discuss the M2 private-context boundary.",
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
            text: "Please discuss the M2 private-context boundary.",
            externalMessageID,
          }),
        )
        const replayed = await groupSession(repository.path, (service) =>
          service.chat({
            groupSessionID: group.id,
            text: "Please discuss the M2 private-context boundary.",
            externalMessageID,
          }),
        )

        expect(replayed).toEqual(accepted)
        await waitFor(async () =>
          groupSession(repository.path, (service) =>
            Effect.gen(function* () {
              const messages = yield* service.messages(group.id)
              return !(yield* service.isBusy(group.id)) && messages.filter((message) => message.agentRunID).length >= 1
            }),
          ),
        )

        const messages = await groupSession(repository.path, (service) => service.messages(group.id))
        const userMessages = messages.filter((message) => message.role === "user")
        const agentMessage = messages.find((message) => message.role === "agent" && message.agentRunID)

        expect(userMessages).toEqual([
          expect.objectContaining({
            id: accepted.userGroupMessageID,
            roundNum: accepted.roundNum,
            externalMessageID,
          }),
        ])
        expect(agentMessage?.agentRunID).toBeString()
        expect(agentMessage?.sessionID).toBeString()
        expect(
          group.members.map(
            (member) =>
              Database.use((db) => {
                const sessionID = SessionID.zod.safeParse(member.sessionID).data
                return sessionID ? db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()?.company_agent_id : undefined
              })?.toString(),
          ),
        ).toEqual(["assistant", "assistant", "assistant"])
        expect(JSON.stringify(server.captures)).not.toContain(canary)
      } finally {
        await rm(memoryPath, { force: true })
      }
    } finally {
      await Instance.disposeAll()
      await resetDatabase()
      await Bun.sleep(500)
      await server.stop()
      await repository[Symbol.asyncDispose]()
    }
  }, 15000)

  test.serial("resumes a persisted round after the first agent without replaying the user or first speaker", async () => {
    const server = startScriptedLLMServer(
      Array.from({ length: 16 }, () => ({
        lines: textStopResponse('{"level":"pass","type":"info","addressedAs":"none","reason":"not needed"}'),
      })),
    )
    const repository = await tmpdir({ git: true, config: providerConfig(`${server.origin}/v1`) })

    try {
      await bootstrap(repository.path)
      const group = await groupSession(repository.path, (service) =>
        service.create({ title: "M2 resume bridge", agentIDs: boardAgents, contextPolicy: "work_scoped" }),
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
      Database.use((db) =>
        db
          .insert(GroupMessageTable)
          .values([
            {
              id: Identifier.ascending("message"),
              group_session_id: group.id,
              round_num: 0,
              role: "user",
              content: "Resume after the first persisted board response.",
              time_created: time,
              time_updated: time,
            },
            {
              id: Identifier.ascending("message"),
              group_session_id: group.id,
              round_num: 0,
              role: "agent",
              company_agent_id: firstMember.company_agent_id,
              session_id: firstMember.session_id,
              content: "The first board member identified a concrete risk.",
              status_summary: "done",
              time_created: time + 1,
              time_updated: time + 1,
            },
          ])
          .run(),
      )

      await groupSession(repository.path, (service) => service.resume({ groupSessionID: group.id, roundNum: 0 }))
      await waitFor(async () =>
        groupSession(repository.path, (service) =>
          Effect.gen(function* () {
            const messages = yield* service.messages(group.id)
            return !(yield* service.isBusy(group.id)) && messages.filter((message) => message.role === "agent").length === 1
          }),
        ),
      )

      const messages = await groupSession(repository.path, (service) => service.messages(group.id))
      const userMessages = messages.filter((message) => message.role === "user")
      const agentMessages = messages.filter((message) => message.role === "agent")
      expect(userMessages).toHaveLength(1)
      expect(agentMessages).toHaveLength(1)
      expect(agentMessages[0]?.companyAgentID).toBe(firstMember.company_agent_id)
    } finally {
      await Instance.disposeAll()
      await resetDatabase()
      await Bun.sleep(500)
      await server.stop()
      await repository[Symbol.asyncDispose]()
    }
  }, 15000)

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
    const repository = await tmpdir({ git: true, config: providerConfig(`${server.url.origin}/v1`) })

    try {
      await bootstrap(repository.path)
      const group = await groupSession(repository.path, (service) =>
        service.create({ title: "M2 interrupt bridge", agentIDs: boardAgents, contextPolicy: "work_scoped" }),
      )
      await groupSession(repository.path, (service) => service.chat({ groupSessionID: group.id, text: "Can you start then interrupt?" }))
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
      await Instance.disposeAll()
      await resetDatabase()
      await Bun.sleep(500)
      server.stop(true)
      await repository[Symbol.asyncDispose]()
    }
  }, 15000)
})
