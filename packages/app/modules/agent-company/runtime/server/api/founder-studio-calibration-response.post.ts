import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { createFounderShadowClient } from "@agents-company/sdk/v2/founder-os"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  return createFounderShadowClient({
    baseUrl: baseURL.origin,
    headers: config.agentCompanyControlPlaneAuthorization
      ? { authorization: config.agentCompanyControlPlaneAuthorization }
      : undefined,
  }).respondCalibration(await readBody<{
    companyId: string
    requestId: string
    response: "accept" | "reject" | "prefer_first" | "prefer_second"
    reason: string
    actorKind: "human"
    confirmationEventId: string
    confirmedBy: string
  }>(event))
})
