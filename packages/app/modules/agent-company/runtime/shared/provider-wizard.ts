// TRUST-03 — 面向用户的 Provider 连接向导（纯逻辑）。
// 预设入口、连接错误分类、模型能力摘要与请求体构造，均可脱离 UI 单测。

export type ProviderPresetId = "openai" | "anthropic" | "codex" | "claude_code" | "local" | "custom"

export type ProviderPreset = {
  id: ProviderPresetId
  label: string
  description: string
  format: "openai" | "anthropic"
  providerId: string
  baseUrl: string
  // 是否在“基础模式”下要求填写 API 密钥（自定义/需要凭据的服务为 true）。
  requiresKey: boolean
  // 本机运行的服务：密钥通常为占位值，端点默认指向本地回环。
  local: boolean
  // 自定义入口：端点、密钥、请求头全部由用户在高级模式填写。
  custom: boolean
  keyHint: string
}

export const providerPresets = [
  {
    id: "openai",
    label: "OpenAI",
    description: "OpenAI 官方 API（GPT 系列）",
    format: "openai",
    providerId: "openai",
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    local: false,
    custom: false,
    keyHint: "以 sk- 开头的 API 密钥",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Claude 系列模型",
    format: "anthropic",
    providerId: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    requiresKey: true,
    local: false,
    custom: false,
    keyHint: "Anthropic 控制台生成的 API 密钥",
  },
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI 兼容的 Codex 服务",
    format: "openai",
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    local: false,
    custom: false,
    keyHint: "服务方提供的 API 密钥",
  },
  {
    id: "claude_code",
    label: "Claude Code",
    description: "Anthropic 兼容的 Claude Code 服务",
    format: "anthropic",
    providerId: "claude-code",
    baseUrl: "https://api.anthropic.com/v1",
    requiresKey: true,
    local: false,
    custom: false,
    keyHint: "服务方提供的 API 密钥",
  },
  {
    id: "local",
    label: "本地模型",
    description: "本机运行的 OpenAI 兼容服务（如 Ollama、LM Studio）",
    format: "openai",
    providerId: "local",
    baseUrl: "http://localhost:11434/v1",
    requiresKey: true,
    local: true,
    custom: false,
    keyHint: "本地服务通常可填任意占位值（如 local）",
  },
  {
    id: "custom",
    label: "自定义",
    description: "手动填写接口格式、端点、密钥与请求头",
    format: "openai",
    providerId: "custom",
    baseUrl: "",
    requiresKey: true,
    local: false,
    custom: true,
    keyHint: "服务方提供的 API 密钥",
  },
] as const satisfies readonly ProviderPreset[]

// 未知预设 id 回退到自定义入口（用户可在高级模式完整配置）。
const fallbackPreset: ProviderPreset = providerPresets[providerPresets.length - 1] ?? {
  id: "custom",
  label: "自定义",
  description: "手动填写接口格式、端点、密钥与请求头",
  format: "openai",
  providerId: "custom",
  baseUrl: "",
  requiresKey: true,
  local: false,
  custom: true,
  keyHint: "服务方提供的 API 密钥",
}

export function providerPreset(id: ProviderPresetId): ProviderPreset {
  return providerPresets.find((preset) => preset.id === id) ?? fallbackPreset
}

export type ProviderErrorKind =
  | "invalid_credential"
  | "endpoint_unreachable"
  | "model_not_found"
  | "quota_limited"
  | "capability_unsupported"
  | "config_invalid"
  | "unknown"

export type ProviderErrorInfo = { kind: ProviderErrorKind; message: string }

function embeddedHttpStatus(message: string): number | undefined {
  const matched = message.match(/HTTP\s+(\d{3})/)
  return matched ? Number(matched[1]) : undefined
}

// 将 Control Plane 返回的错误（NamedError 名称 + HTTP 状态 + 文案）归类为面向用户的原因，
// 以区分凭据无效、端点不可达、模型不存在、配额限制与能力不兼容。
export function classifyProviderError(input: { name?: string; status?: number; message?: string }): ProviderErrorInfo {
  const message = input.message?.trim() ?? ""
  if (input.name === "CompanyModelNotAvailable")
    return { kind: "model_not_found", message: "所选模型在该服务中不存在，请重新选择可用模型。" }
  if (input.name === "CompanyProviderUnsupported")
    return { kind: "config_invalid", message: "暂不支持该服务类型，请改用自定义入口配置。" }

  const httpStatus = embeddedHttpStatus(message) ?? input.status
  if (httpStatus === 401 || httpStatus === 403)
    return { kind: "invalid_credential", message: "凭据无效或权限不足，请检查 API 密钥是否正确。" }
  if (httpStatus === 404)
    return { kind: "endpoint_unreachable", message: "端点未找到（HTTP 404），请检查 API 地址是否正确。" }
  if (httpStatus === 429)
    return { kind: "quota_limited", message: "已达到配额或速率限制（HTTP 429），请稍后重试或更换密钥。" }
  if (message.includes("无法连接"))
    return { kind: "endpoint_unreachable", message: "无法连接到该端点，请检查 API 地址与本机网络。" }
  if (message.includes("格式无效"))
    return { kind: "capability_unsupported", message: "该端点未返回兼容的模型列表，可能不支持所选接口格式。" }
  if (httpStatus !== undefined && httpStatus >= 500)
    return { kind: "endpoint_unreachable", message: `服务返回错误（HTTP ${httpStatus}），请稍后重试。` }
  return { kind: "unknown", message: message || "连接失败，请检查配置后重试。" }
}

// 模型发现端点仅返回 {model_id, name}（真实连接测试的产物）；
// 逐模型的工具调用/结构化输出/中断恢复能力后端尚未暴露，不在此虚构。
export type DiscoveredModel = { model_id: string; name: string }

export type ProviderDraft = {
  format: "openai" | "anthropic"
  providerId: string
  baseUrl: string
  apiKey: string
  headers: Record<string, string>
}

export function draftFromPreset(preset: ProviderPreset): ProviderDraft {
  return { format: preset.format, providerId: preset.providerId, baseUrl: preset.baseUrl, apiKey: "", headers: {} }
}

// 模型发现（连接测试）请求：密钥可选，与后端 CustomProviderModelsInput 对齐。
export function buildModelsRequest(draft: ProviderDraft) {
  return {
    format: draft.format,
    base_url: draft.baseUrl,
    ...(draft.apiKey ? { api_key: draft.apiKey } : {}),
    headers: draft.headers,
  }
}

// 绑定请求：后端要求 api_key 必填，与 CompanyProviderConfigureInput 对齐。
export function buildConfigureRequest(draft: ProviderDraft, modelId: string) {
  return {
    format: draft.format,
    provider_id: draft.providerId,
    base_url: draft.baseUrl,
    model_id: modelId,
    api_key: draft.apiKey,
    headers: draft.headers,
  }
}
