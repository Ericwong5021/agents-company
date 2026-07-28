import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import z from "zod"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

// TRUST-03 — 模型发现即真实连接测试：代理 Control Plane 的 POST /company/providers/models，
// 成功返回发现的模型列表；失败时透传后端错误名称/文案/状态，供前端向导分类展示。

const Input = z
  .object({
    format: z.enum(["openai", "anthropic"]),
    base_url: z.string().url(),
    api_key: z.string().trim().min(1).max(8_192).optional(),
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict()

function errorField(body: unknown, field: "name" | "message"): string | undefined {
  if (typeof body !== "object" || body === null) return undefined
  if (field === "name" && "name" in body && typeof body.name === "string") return body.name
  if ("data" in body && typeof body.data === "object" && body.data !== null && field in body.data) {
    const value = (body.data as Record<string, unknown>)[field]
    if (typeof value === "string") return value
  }
  return undefined
}

export default defineAgentCompanyHandler(async (event) => {
  const parsed = Input.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "连接测试参数不完整" })

  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })

  const result = await ofetch
    .raw<unknown>(new URL("/company/providers/models", baseURL).toString(), {
      method: "POST",
      headers: config.agentCompanyControlPlaneAuthorization
        ? { authorization: config.agentCompanyControlPlaneAuthorization }
        : undefined,
      body: parsed.data,
      ignoreResponseError: true,
      retry: 0,
      timeout: 15_000,
    })
    .then(
      (response) => ({ ok: true as const, response }),
      () => ({ ok: false as const }),
    )
  if (!result.ok) throw createError({ statusCode: 503, statusMessage: "连接测试服务暂时不可用" })

  if (result.response.status >= 200 && result.response.status < 300)
    return { ok: true as const, models: result.response._data }
  return {
    ok: false as const,
    error: {
      name: errorField(result.response._data, "name"),
      message: errorField(result.response._data, "message"),
      status: result.response.status,
    },
  }
})
