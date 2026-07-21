import { describe, expect, test } from "bun:test"
import { extractRuntimeUsage } from "../../src/runtime/usage"

describe("extractRuntimeUsage", () => {
  test("normalizes OpenAI-compatible usage nested in a runtime event", () => {
    expect(extractRuntimeUsage({ response: { usage: {
      input_tokens: 120,
      output_tokens: 34,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens_details: { reasoning_tokens: 12 },
    } } })).toEqual({ inputTokens: 120, outputTokens: 34, cacheReadTokens: 40, reasoningTokens: 12 })
  })

  test("normalizes Anthropic-style cache fields", () => {
    expect(extractRuntimeUsage({ usage: {
      input_tokens: 80,
      output_tokens: 20,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
    } })).toEqual({ inputTokens: 80, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 })
  })

  test("does not invent usage when a runtime did not report it", () => {
    expect(extractRuntimeUsage({ type: "turn.completed" })).toBeUndefined()
  })
})
