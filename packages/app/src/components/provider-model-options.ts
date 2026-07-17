type ProviderConfig = {
  name?: string
  models?: Record<string, { name?: string }>
}

export type GlobalModelOption = {
  id: string
  label: string
  provider: string
}

export function globalModelOptions(providers: Record<string, ProviderConfig> | undefined, disabled: string[] | undefined) {
  const unavailable = new Set(disabled)
  return Object.entries(providers ?? {})
    .filter(([providerID]) => !unavailable.has(providerID))
    .flatMap(([providerID, provider]) =>
      Object.entries(provider.models ?? {}).map(([modelID, model]) => ({
        id: `${providerID}/${modelID}`,
        label: model.name ?? modelID,
        provider: provider.name ?? providerID,
      })),
    )
    .toSorted((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
}
