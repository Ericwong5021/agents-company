import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import z from "zod"
import { AgentMessage } from "../../src/agent-message/agent-message"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { Session } from "../../src/session"
import { Thread } from "../../src/thread/thread"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const TokenStatsBody = z.object({
  trackedSpentTokens: z.number(),
  observedTokens: z.object({
    total: z.number(),
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    cost: z.number(),
  }),
  threads: z.array(
    z.object({
      threadID: z.string(),
      trackedSpentTokens: z.number(),
      observedTokens: z.object({ total: z.number() }),
      sessionIDs: z.array(z.string()),
    }),
  ),
})

afterEach(async () => {
  await Instance.disposeAll()
})

describe("project token stats routes", () => {
  test("surfaces project and RootNeed token usage", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rootNeedID = `need-token-${Math.random().toString(36).slice(2)}`
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const threads = yield* Thread.Service
            const sessions = yield* Session.Service
            const messages = yield* AgentMessage.Service

            const thread = yield* threads.create({
              agentID: `agent-token-${Math.random().toString(36).slice(2)}`,
              kind: "primary",
              budgetTokens: 1000,
              description: "RootNeed token route test",
            })
            yield* threads.addTokens(thread.id, 345)
            const session = yield* sessions.create({ title: "token stats", threadID: thread.id })
            yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "assistant",
              time: { created: Date.now(), completed: Date.now() },
              parentID: MessageID.ascending(),
              modelID: "test-model",
              providerID: "test-provider",
              mode: "build",
              agent: "executor",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0.25,
              tokens: {
                total: 123,
                input: 50,
                output: 40,
                reasoning: 20,
                cache: { read: 10, write: 3 },
              },
            } as unknown as MessageV2.Assistant)
            yield* messages.create({
              fromAgentID: "board",
              toAgentID: "executor",
              kind: "request",
              body: "Execute token-visible work",
              rootNeedID,
              threadID: thread.id,
              depth: 2,
            })
          }),
        )

        const app = Server.Default().app
        const project = await app.request(`/project/${Instance.project.id}/token-stats`)
        expect(project.status).toBe(200)
        const projectBody = TokenStatsBody.parse(await project.json())
        expect(projectBody.trackedSpentTokens).toBeGreaterThanOrEqual(345)
        expect(projectBody.observedTokens).toMatchObject({
          total: 123,
          input: 50,
          output: 40,
          reasoning: 20,
          cacheRead: 10,
          cacheWrite: 3,
          cost: 0.25,
        })
        expect(projectBody.threads.some((thread) => thread.trackedSpentTokens === 345)).toBe(true)

        const rootNeed = await app.request(`/project/token-stats/root-need/${rootNeedID}`)
        expect(rootNeed.status).toBe(200)
        const rootNeedBody = TokenStatsBody.extend({
          rootNeedID: z.string(),
          messageCount: z.number(),
          levels: z.array(
            z.object({
              depth: z.number(),
              messageCount: z.number(),
              trackedSpentTokens: z.number(),
              observedTokens: z.object({ total: z.number() }),
            }),
          ),
        }).parse(await rootNeed.json())
        expect(rootNeedBody).toMatchObject({
          rootNeedID,
          messageCount: 1,
          trackedSpentTokens: 345,
        })
        expect(rootNeedBody.observedTokens.total).toBe(123)
        expect(rootNeedBody.levels).toContainEqual(
          expect.objectContaining({
            depth: 2,
            messageCount: 1,
            trackedSpentTokens: 345,
            observedTokens: expect.objectContaining({ total: 123 }),
          }),
        )
      },
    })
  })
})
