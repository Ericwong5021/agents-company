import { createError } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { createFounderModesClient } from "@agents-company/sdk/v2/founder-os"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

export default defineAgentCompanyHandler((event) => {
  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  return createFounderModesClient({
    baseUrl: baseURL.origin,
    headers: config.agentCompanyControlPlaneAuthorization
      ? { authorization: config.agentCompanyControlPlaneAuthorization }
      : undefined,
  }).get()
})
