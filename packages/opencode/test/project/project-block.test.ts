import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Project } from "../../src/project"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A>(fn: (svc: Project.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* Project.Service
      return yield* fn(svc)
    }).pipe(Effect.provide(Project.defaultLayer)),
  )
}

describe("Project emergency stop", () => {
  test("blocks and unblocks a project", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await run((svc) => svc.fromDirectory(tmp.path))

    const blocked = await run((svc) =>
      svc.block({
        projectID: project.id,
        reason: "Token budget runaway",
        byAgentID: "dept-head",
      }),
    )

    expect(blocked.block).toMatchObject({
      reason: "Token budget runaway",
      byAgentID: "dept-head",
    })
    expect(blocked.time.blocked).toBeGreaterThan(0)

    const unblocked = await run((svc) => svc.unblock({ projectID: project.id, reason: "Budget recovered" }))
    expect(unblocked.block).toBeUndefined()
    expect(unblocked.time.blocked).toBeUndefined()
  })
})
