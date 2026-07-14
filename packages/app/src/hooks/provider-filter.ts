export const popularProviders = [
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]

const excludedProviders = new Set(["opencode", "opencode-go"])

export function isAgentCompanyProvider(providerID: string) {
  return !excludedProviders.has(providerID)
}
