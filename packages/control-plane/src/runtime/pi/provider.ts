import type { Auth } from "@/auth"
import type { Provider } from "@/provider"
import { getModel, type Model } from "@earendil-works/pi-ai/compat"

type ProviderConnection = Pick<Provider.Info, "key" | "options" | "source">

function configuredProviderFallbackKey(provider: ProviderConnection) {
  if (provider.source !== "config") return
  const baseURL = typeof provider.options.baseURL === "string" ? provider.options.baseURL : ""
  const hostname = URL.canParse(baseURL) ? new URL(baseURL).hostname : ""
  if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return "agent-company-local-provider"
  if (provider.options.headers && typeof provider.options.headers === "object") return "agent-company-header-provider"
}

export function piProviderCredential(auth: Auth.Info | undefined, provider: ProviderConnection) {
  if (auth?.type === "oauth") return auth.access
  if (auth?.type === "wellknown") return auth.token
  if (auth?.type === "api") return auth.key
  if (provider.key) return provider.key
  if (typeof provider.options.apiKey === "string") return provider.options.apiKey
  return configuredProviderFallbackKey(provider)
}

export function piProviderBaseUrl(provider: Pick<Provider.Info, "options">, fallback: string) {
  return typeof provider.options.baseURL === "string" && provider.options.baseURL ? provider.options.baseURL : fallback
}

function api(model: Provider.Model) {
  if (model.api.npm.includes("anthropic")) return "anthropic-messages"
  if (model.api.npm.includes("google")) return "google-generative-ai"
  if (model.api.npm.includes("mistral")) return "mistral-conversations"
  if (model.api.id.includes("responses")) return "openai-responses"
  return "openai-completions"
}

export function piProviderModel(model: Provider.Model, provider: Provider.Info): Model<string> {
  const builtin = getModel(model.providerID as never, model.id as never)
  return {
    ...builtin,
    id: model.id,
    name: model.name,
    api: builtin?.api ?? api(model),
    provider: model.providerID,
    baseUrl: piProviderBaseUrl(provider, model.api.url || builtin?.baseUrl || ""),
    reasoning: model.capabilities.reasoning,
    input: model.capabilities.input.image ? ["text", "image"] : ["text"],
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cache.read,
      cacheWrite: model.cost.cache.write,
    },
    contextWindow: model.limit.context,
    maxTokens: model.limit.output,
    headers: { ...builtin?.headers, ...model.headers },
  }
}
