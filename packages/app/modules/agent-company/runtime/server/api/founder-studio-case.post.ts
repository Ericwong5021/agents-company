import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import {
  createFounderShadowClient,
  type GovernanceAsset,
  type GovernanceAssetScope,
} from "@agents-company/sdk/v2/founder-os"
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
  }).importCase(await readBody<{
    companyId: string
    kind: "decision_case" | "taste_reference" | "taste_anti_reference" | "rubric"
    scope: GovernanceAssetScope
    content: string
    rationale: string
    dimensions: string[]
    sourceRefs: GovernanceAsset["sourceRefs"]
    authority: "ai_proposed" | "external_source"
    createdBy: string
  }>(event))
})
