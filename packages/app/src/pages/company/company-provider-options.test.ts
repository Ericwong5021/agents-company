import { describe, expect, test } from "bun:test"
import type { CompanyProviderOption } from "@agents-company/sdk/v2/client"
import { companyProviderOptions } from "./company-provider-options"

const provider = (provider_id: string) =>
  ({ provider_id, name: provider_id, connected: false, models: [] }) satisfies CompanyProviderOption

describe("company provider options", () => {
  test("keeps only ten ranked providers and includes OpenCode Go", () => {
    const result = companyProviderOptions(
      [
        "groq",
        "unknown",
        "opencode-go",
        "anthropic",
        "openai",
        "xai",
        "mistral",
        "openrouter",
        "deepseek",
        "github-copilot",
        "google",
      ].map(provider),
    )

    expect(result.map((item) => item.provider_id)).toEqual([
      "openai",
      "anthropic",
      "google",
      "github-copilot",
      "deepseek",
      "opencode-go",
      "openrouter",
      "xai",
      "mistral",
      "groq",
    ])
  })

  test("keeps a restored custom provider selectable without exceeding the limit", () => {
    const result = companyProviderOptions(
      [
        "groq",
        "opencode-go",
        "anthropic",
        "openai",
        "xai",
        "mistral",
        "openrouter",
        "deepseek",
        "github-copilot",
        "google",
        "my-provider",
      ].map(provider),
      "my-provider",
    )

    expect(result).toHaveLength(10)
    expect(result.at(-1)?.provider_id).toBe("my-provider")
  })
})
