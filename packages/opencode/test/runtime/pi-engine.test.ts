import { describe, expect, test } from "bun:test"
import { buildPiSystemPrompt, createPiTurnBudget } from "../../src/runtime/pi/engine"

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
})
