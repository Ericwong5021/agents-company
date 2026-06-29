import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Thread } from "../../src/thread"
import { Log } from "../../src/util"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Thread.defaultLayer, CrossSpawnSpawner.defaultLayer))

afterEach(async () => {
  await Instance.disposeAll()
})

describe("Session thread binding", () => {
  it.live("binds multiple sessions to one thread and returns standard thread info", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const threads = yield* Thread.Service
        const thread = yield* threads.create({
          agentID: "build",
          kind: "primary",
          description: "Build thread",
          budgetTokens: 1200,
        })

        const first = yield* sessions.create({ title: "first bound session", threadID: thread.id })
        const second = yield* sessions.create({ title: "second bound session", threadID: thread.id })

        expect(first.directory).toBe(dir)
        expect(first.threadID).toBe(thread.id)
        expect(second.threadID).toBe(thread.id)
        expect((yield* sessions.listByThread(thread.id)).map((session) => session.title).sort()).toEqual([
          "first bound session",
          "second bound session",
        ])

        const resolved = yield* sessions.getThread(first.id)
        const parsed = Thread.Info.parse(resolved)

        expect(parsed).toMatchObject({
          id: thread.id,
          agentID: "build",
          kind: "primary",
          status: "active",
          description: "Build thread",
          budgetTokens: 1200,
          spentTokens: 0,
          timeStarted: thread.timeStarted,
        })
        expect(parsed.time.created).toBe(thread.time.created)
        expect(parsed.time.updated).toBe(thread.time.updated)
      }),
      { git: true },
    ),
  )

  it.live("rejects binding a session to a missing thread", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const exit = yield* sessions.create({ threadID: "thr_missing" }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
      }),
      { git: true },
    ),
  )
})
