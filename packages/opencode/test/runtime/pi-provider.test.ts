import { describe, expect, test } from "bun:test"
import type { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { piProviderBaseUrl, piProviderCredential, piProviderModel } from "../../src/runtime/pi/provider"

const providerID = ProviderID.make("openai")
const model: Provider.Model = {
  id: ModelID.make("gpt-4.1"),
  providerID,
  api: { id: "gpt-4.1", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
  name: "GPT 4.1 through AgentCompany",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 1, output: 2, cache: { read: 0.5, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 16_384 },
  status: "active",
  options: {},
  headers: { "x-agent-company": "configured" },
  release_date: "2026-01-01",
}

const provider: Provider.Info = {
  id: providerID,
  name: "OpenAI proxy",
  source: "config",
  env: [],
  options: { baseURL: "http://127.0.0.1:4321/v1" },
  models: { [model.id]: model },
}

describe("Pi provider bridge", () => {
  test("reuses configured Provider credentials when Auth has no separate record", () => {
    expect(piProviderCredential(undefined, { key: undefined, options: { apiKey: "config-key" } })).toBe("config-key")
  })

  test("prefers the authoritative Auth record and configured base URL", () => {
    expect(piProviderCredential({ type: "api", key: "auth-key" }, { key: "env-key", options: {} })).toBe("auth-key")
    expect(piProviderBaseUrl({ options: { baseURL: "http://127.0.0.1:4321/v1" } }, "https://default.invalid")).toBe(
      "http://127.0.0.1:4321/v1",
    )
  })

  test("keeps AgentCompany connection overrides for Pi built-in models", () => {
    expect(piProviderModel(model, provider)).toMatchObject({
      id: "gpt-4.1",
      name: "GPT 4.1 through AgentCompany",
      baseUrl: "http://127.0.0.1:4321/v1",
      headers: { "x-agent-company": "configured" },
      contextWindow: 128_000,
      maxTokens: 16_384,
    })
  })
})
