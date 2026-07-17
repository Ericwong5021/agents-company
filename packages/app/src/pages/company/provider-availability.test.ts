import { describe, expect, test } from "bun:test"
import { providerConfigured, shouldShowProviderSetupCard } from "./provider-availability"

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
})
