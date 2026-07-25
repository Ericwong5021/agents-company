import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import z from "zod"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

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

export default defineAgentCompanyHandler(async (event) => {
  const parsed = Input.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "Provider 配置不完整" })

  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  return ofetch(new URL("/company/provider", baseURL).toString(), {
    method: "PUT",
    headers: config.agentCompanyControlPlaneAuthorization
      ? { authorization: config.agentCompanyControlPlaneAuthorization }
      : undefined,
    body: parsed.data,
  })
})
