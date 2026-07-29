import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { createFounderStudioClient, type GovernanceAssetScope } from "@agents-company/sdk/v2/founder-os"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  return createFounderStudioClient({
    baseUrl: baseURL.origin,
    headers: config.agentCompanyControlPlaneAuthorization
      ? { authorization: config.agentCompanyControlPlaneAuthorization }
      : undefined,
  }).compileSnapshot(await readBody<{
    companyId: string
    profileSummary: string
    promptTemplateVersion: string
    modelConfigRef: string
    retrievalConfigRef: string
    permissionConfigRef: string
    compiledPromptHash: string
    scope: GovernanceAssetScope
    createdBy: string
  }>(event))
})
