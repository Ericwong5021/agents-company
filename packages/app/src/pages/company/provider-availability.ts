import type { CompanyProviderList, CompanySetupGoal } from "@agents-company/sdk/v2/client"

export const COMPANY_PROVIDER_CONFIGURED_EVENT = "agent-company:provider-configured"

export function providerConfigured(providers: CompanyProviderList | undefined) {
  return providers?.providers.some((provider) => provider.connected) === true
}

export function projectExecutionModel(providers: CompanyProviderList | undefined, excludedProviderIDs: string[] = []) {
  const provider = providers?.providers.find(
    (item) =>
      item.connected &&
      !excludedProviderIDs.includes(item.provider_id) &&
      Boolean(providers.defaults[item.provider_id]) &&
      item.models.some((model) => model.model_id === providers.defaults[item.provider_id]),
  )
  if (!provider || !providers) return undefined
  return { provider_id: provider.provider_id, model_id: providers.defaults[provider.provider_id] }
}

export function shouldShowProviderSetupCard(goal: CompanySetupGoal | null | undefined, providers: CompanyProviderList | undefined) {
  if (providerConfigured(providers)) return null
  return goal ?? null
}
