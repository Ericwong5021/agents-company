import { describe, expect, test } from "bun:test"
import { buildPiSystemPrompt, createPiIdleTimer, createPiTurnBudget } from "../../src/runtime/pi/engine"

describe("Pi runtime engine policy", () => {
  test("adds the requested JSON schema to the system contract", () => {
    expect(
      buildPiSystemPrompt("You are a reviewer", {
        type: "object",
        required: ["verdict"],
        properties: { verdict: { enum: ["pass", "fail"] } },
      }),
    ).toContain('"required":["verdict"]')
  })

  test("fails before a provider request can exceed maxTurns", () => {
    const consume = createPiTurnBudget(2)

    expect(consume()).toBe(1)
    expect(consume()).toBe(2)
    expect(consume).toThrow("maximum turn budget of 2")
  })

  test("aborts an idle model request but pauses the timer while a tool runs", () => {
    const scheduled: Array<() => void> = []
    let aborted = 0
    const idle = createPiIdleTimer({
      timeoutMs: 60_000,
      abort: () => aborted++,
      schedule: ((callback: () => void) => {
        scheduled.push(callback)
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      cancel: (() => {}) as typeof clearTimeout,
    })

    idle.start()
    scheduled.at(-1)!()
    expect(aborted).toBe(1)

    idle.event({ type: "tool_execution_start" } as never)
    const beforeTool = scheduled.length
    idle.event({ type: "message_update" } as never)
    expect(scheduled).toHaveLength(beforeTool)

    idle.event({ type: "tool_execution_end" } as never)
    expect(scheduled).toHaveLength(beforeTool + 1)
  })
})
