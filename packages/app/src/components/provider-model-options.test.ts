import { describe, expect, test } from "bun:test"
import { globalModelOptions } from "./provider-model-options"

describe("global model options", () => {
  test("lists configured models and excludes disabled providers", () => {
    expect(
      globalModelOptions(
        {
          talktodo: { name: "talktodo", models: { "gpt-5": { name: "GPT-5" }, mini: {} } },
          disabled: { models: { hidden: {} } },
        },
        ["disabled"],
      ),
    ).toEqual([
      { id: "talktodo/gpt-5", label: "GPT-5", provider: "talktodo" },
      { id: "talktodo/mini", label: "mini", provider: "talktodo" },
    ])
  })
})
