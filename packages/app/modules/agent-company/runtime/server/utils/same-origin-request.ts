const readOnlyMethods = new Set(["GET", "HEAD", "OPTIONS"])

export function isSameOriginAgentCompanyRequest(input: { method: string; origin?: string; requestOrigin: string }) {
  if (readOnlyMethods.has(input.method.toUpperCase())) return true
  return Boolean(input.origin && input.origin === input.requestOrigin)
}
