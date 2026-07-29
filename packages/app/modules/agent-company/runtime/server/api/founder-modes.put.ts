import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import z from "zod"
import { createFounderModesClient } from "@agents-company/sdk/v2/founder-os"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

const Input = z
  .object({
    founderTwinMode: z.enum(["off", "shadow"]),
    companyCommonsMode: z.enum(["off", "ingest-only", "reading"]),
  })
  .strict()

export default defineAgentCompanyHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const parsed = Input.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "Founder OS 模式请求无效" })
  const input = parsed.data
  const client = createFounderModesClient({
    baseUrl: baseURL.origin,
    headers: config.agentCompanyControlPlaneAuthorization
      ? { authorization: config.agentCompanyControlPlaneAuthorization }
      : undefined,
  })
  const current = await client.get()
  const founderModes = ["off", "shadow"] as const
  const commonsModes = ["off", "ingest-only", "reading"] as const
  const founderModeOrder = ["off", "shadow", "advisor", "green-delegated", "yellow-delegated"] as const
  const commonsModeOrder = ["off", "ingest-only", "reading", "belief-loop"] as const
  const founderIndex = founderModes.indexOf(input.founderTwinMode as (typeof founderModes)[number])
  const commonsIndex = commonsModes.indexOf(input.companyCommonsMode as (typeof commonsModes)[number])
  if (
    founderIndex < 0
    || commonsIndex < 0
    || founderIndex > Math.min(founderModeOrder.indexOf(current.globalMaximum.founderTwinMode), founderModes.length - 1)
    || commonsIndex > Math.min(commonsModeOrder.indexOf(current.globalMaximum.companyCommonsMode), commonsModes.length - 1)
  )
    throw createError({ statusCode: 400, statusMessage: "请求模式超出当前全局上限或需要 Delegation Readiness" })
  return client.update(input)
})
