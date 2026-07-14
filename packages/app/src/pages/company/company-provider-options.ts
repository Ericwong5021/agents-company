import type { CompanyProviderOption } from "@agents-company/sdk/v2/client"

export const companyProviderOrder = [
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
] as const

const companyProviderRank = new Map<string, number>(companyProviderOrder.map((providerID, index) => [providerID, index]))

export function companyProviderOptions(providers: CompanyProviderOption[], selectedProviderID?: string) {
  const known = providers
    .filter((provider) => companyProviderRank.has(provider.provider_id))
    .toSorted((left, right) => companyProviderRank.get(left.provider_id)! - companyProviderRank.get(right.provider_id)!)
  const selected = providers.find(
    (provider) => provider.provider_id === selectedProviderID && !companyProviderRank.has(provider.provider_id),
  )
  if (!selected) return known.slice(0, companyProviderOrder.length)
  return [...known.slice(0, companyProviderOrder.length - 1), selected]
}
