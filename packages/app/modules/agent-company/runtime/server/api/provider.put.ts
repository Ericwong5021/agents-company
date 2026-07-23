import { createError, defineEventHandler, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import z from "zod"

const Input = z
  .object({
    format: z.enum(["openai", "anthropic"]),
    base_url: z.string().url(),
    api_key: z.string().trim().min(1).max(8_192),
    headers: z.record(z.string(), z.string()),
    provider_id: z.string().trim().min(1).max(100),
    model_id: z.string().trim().min(1).max(300),
  })
  .strict()

export default defineEventHandler(async (event) => {
  const parsed = Input.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "Provider 配置不完整" })

  const config = useRuntimeConfig(event)
  return ofetch(new URL("/company/provider", config.agentCompanyControlPlaneUrl).toString(), {
    method: "PUT",
    headers: config.agentCompanyControlPlaneAuthorization
      ? { authorization: config.agentCompanyControlPlaneAuthorization }
      : undefined,
    body: parsed.data,
  })
})
