import type { CompanyProviderList, CompanySetupGoal } from "@agents-company/sdk/v2/client"

export const COMPANY_PROVIDER_CONFIGURED_EVENT = "agent-company:provider-configured"

export function providerConfigured(providers: CompanyProviderList | undefined) {
  return providers?.providers.some((provider) => provider.connected) === true
}

export function shouldShowProviderSetupCard(goal: CompanySetupGoal | null | undefined, providers: CompanyProviderList | undefined) {
  if (providerConfigured(providers)) return null
  return goal ?? null
}
