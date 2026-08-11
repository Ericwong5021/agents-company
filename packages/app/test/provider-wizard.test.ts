import { describe, expect, test } from "bun:test"
import {
  buildConfigureRequest,
  buildModelsRequest,
  classifyProviderError,
  providerPreset,
  providerPresets,
} from "../modules/agent-company/runtime/shared/provider-wizard"

// TRUST-03 — Provider 连接向导纯逻辑：预设、错误分类与请求体构造。

describe("TRUST-03 预设入口", () => {
  test("提供 OpenAI/Anthropic/Codex/Claude Code/本地/自定义六个入口", () => {
    expect(providerPresets.map((preset) => preset.id)).toEqual([
      "openai",
      "anthropic",
      "codex",
      "claude_code",
      "local",
      "custom",
    ])
  })

  test("本地预设指向本机端点，自定义预设不预填端点", () => {
    expect(providerPreset("local").local).toBe(true)
    expect(providerPreset("local").baseUrl).toContain("localhost")
    expect(providerPreset("custom").custom).toBe(true)
    expect(providerPreset("custom").baseUrl).toBe("")
  })

  test("未知预设回退到自定义", () => {
    // @ts-expect-error 故意传入非法预设 id 验证回退
    expect(providerPreset("nope").id).toBe("custom")
  })
})

describe("TRUST-03 错误分类", () => {
  test("凭据无效（HTTP 401/403 或嵌入状态）", () => {
    expect(classifyProviderError({ message: "提供商返回 HTTP 401" }).kind).toBe("invalid_credential")
    expect(classifyProviderError({ status: 403 }).kind).toBe("invalid_credential")
  })

  test("端点不可达（无法连接 / 404 / 5xx）", () => {
    expect(classifyProviderError({ message: "无法连接到提供商端点" }).kind).toBe("endpoint_unreachable")
    expect(classifyProviderError({ message: "提供商返回 HTTP 404" }).kind).toBe("endpoint_unreachable")
    expect(classifyProviderError({ message: "提供商返回 HTTP 502" }).kind).toBe("endpoint_unreachable")
  })

  test("配额限制（HTTP 429）", () => {
    expect(classifyProviderError({ message: "提供商返回 HTTP 429" }).kind).toBe("quota_limited")
  })

  test("模型不存在（CompanyModelNotAvailable）", () => {
    expect(classifyProviderError({ name: "CompanyModelNotAvailable", message: "x" }).kind).toBe("model_not_found")
  })

  test("能力不兼容（模型列表格式无效）", () => {
    expect(classifyProviderError({ message: "提供商返回的模型列表格式无效" }).kind).toBe("capability_unsupported")
  })

  test("无法识别时回退 unknown 并保留原始文案", () => {
    expect(classifyProviderError({ message: "奇怪的错误" })).toEqual({ kind: "unknown", message: "奇怪的错误" })
    expect(classifyProviderError({}).kind).toBe("unknown")
  })
})

describe("TRUST-03 请求体构造", () => {
  const draft = {
    format: "openai" as const,
    providerId: "custom",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    headers: { "x-team": "growth" },
  }

  test("模型发现请求：密钥可选，与后端 CustomProviderModelsInput 对齐", () => {
    expect(buildModelsRequest(draft)).toEqual({
      format: "openai",
      provider_id: "custom",
      base_url: "https://api.example.com/v1",
      api_key: "sk-test",
      headers: { "x-team": "growth" },
    })
    expect(buildModelsRequest({ ...draft, apiKey: "" })).not.toHaveProperty("api_key")
  })

  test("绑定请求：携带选择的模型与必填密钥", () => {
    expect(buildConfigureRequest(draft, "gpt-4o")).toEqual({
      format: "openai",
      provider_id: "custom",
      base_url: "https://api.example.com/v1",
      model_id: "gpt-4o",
      api_key: "sk-test",
      headers: { "x-team": "growth" },
    })
  })
})
