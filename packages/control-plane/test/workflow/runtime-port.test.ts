import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentRunSupervisor, type StartInput } from "../../src/agent-run/supervisor"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { WorkflowRuntime } from "../../src/workflow/runtime"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { makeLayer, providerCfg, ref } from "./lib"

const starts: StartInput[] = []
const supervisor = Layer.succeed(
  AgentRunSupervisor.Service,
  AgentRunSupervisor.Service.of({
    start: (input) => {
      starts.push(input)
      const now = Date.now()
      return Effect.succeed({
        runID: "runtime-child",
        completion: Promise.resolve({
          runID: "runtime-child",
          runtime: input.runtime,
          content: '{"decision":"approve"}',
          exitCode: 0,
          sessionID: "runtime-session",
          startedAt: now,
          finishedAt: now,
        }),
      })
    },
    discover: () => Effect.succeed([]),
    deliver: () => Effect.void,
    interrupt: () => Effect.succeed(true),
    stop: () => Effect.succeed(true),
    recover: () => Effect.succeed([]),
  }),
)

afterEach(async () => {
  starts.length = 0
  await Instance.disposeAll()
})

const it = testEffect(makeLayer(supervisor))

describe("Workflow Runtime Port host", () => {
  it.live(
    "routes a capability-backed agent node through AgentRunSupervisor with immutable workflow metadata",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* () {
        const runtime = yield* WorkflowRuntime.Service
        const session = yield* Session.Service
        const parent = yield* session.create({ title: "runtime workflow" })
        const script = [
          `export const meta = { name: "runtime-test", version: "7", description: "d", defaultRuntime: "pi" }`,
          `return await agent("decide", { role: "board-strategist", capabilityPacks: ["board-strategy@1"], schema: { type: "object", required: ["decision"], properties: { decision: { enum: ["approve", "reject"] } } } })`,
        ].join("\n")

        const started = yield* runtime.start({ script, sessionID: parent.id, parentActorID: "main", model: ref })
        const outcome = yield* runtime.wait({ runID: started.runID })

        expect(outcome).toEqual({ status: "completed", result: { decision: "approve" } })
        expect(starts).toHaveLength(1)
        expect(starts[0]).toMatchObject({
          runtime: "pi",
          role: "board-strategist",
          capabilityPacks: ["board-strategy@1"],
          workflowVersion: "7",
        })
        }),
        { git: true, config: providerCfg },
      ),
    15000,
  )
})
