import { describe, expect, test } from "bun:test"
import { projectExecutionModel, providerConfigured, shouldShowProviderSetupCard } from "./provider-availability"

const goal = { body: "规划第一版范围", created_at: 1, updated_at: 1 }

describe("company provider availability", () => {
  test("unblocks the composer and hides a deferred-goal card after a provider connects", () => {
    const providers = {
      providers: [
        { provider_id: "talktodo", name: "talktodo", connected: true, models: [], },
        { provider_id: "openai", name: "OpenAI", connected: false, models: [] },
      ],
      defaults: {},
    }

    expect(providerConfigured(providers)).toBe(true)
    expect(shouldShowProviderSetupCard(goal, providers)).toBeNull()
  })

  test("keeps the deferred-goal card visible until a provider is connected", () => {
    const providers = { providers: [{ provider_id: "talktodo", name: "talktodo", connected: false, models: [] }], defaults: {} }

    expect(providerConfigured(providers)).toBe(false)
    expect(shouldShowProviderSetupCard(goal, providers)).toEqual(goal)
  })

  test("selects the first connected provider with a valid default model for project execution", () => {
    const providers = {
      providers: [
        { provider_id: "broken", name: "Broken", connected: true, models: [] },
        {
          provider_id: "xiaomi",
          name: "Xiaomi",
          connected: true,
          models: [{ model_id: "mimo-v2.5", name: "MiMo", status: "active" as const, context_window: 128_000 }],
        },
        {
          provider_id: "codex",
          name: "Codex",
          connected: true,
          models: [{ model_id: "spark", name: "Spark", status: "active" as const, context_window: 128_000 }],
        },
      ],
      defaults: { broken: "missing", xiaomi: "mimo-v2.5", codex: "spark" },
    }

    expect(projectExecutionModel(providers)).toEqual({ provider_id: "xiaomi", model_id: "mimo-v2.5" })
    expect(projectExecutionModel(providers, ["xiaomi"])).toEqual({
      provider_id: "codex",
      model_id: "spark",
    })
  })
})
