import { createError, getRouterParam, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import {
  createFounderStudioClient,
  type GovernanceAsset,
  type GovernanceAssetAuthority,
  type GovernanceAssetStatus,
} from "@agents-company/sdk/v2/founder-os"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event) => {
  const assetID = getRouterParam(event, "assetID")
  if (!assetID) throw createError({ statusCode: 400, statusMessage: "Asset ID is required" })
  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  return createFounderStudioClient({
    baseUrl: baseURL.origin,
    headers: config.agentCompanyControlPlaneAuthorization
      ? { authorization: config.agentCompanyControlPlaneAuthorization }
      : undefined,
  }).revise(assetID, await readBody<{
    baseVersion: number
    content: string
    rationale: string
    tags: string[]
    authority: GovernanceAssetAuthority
    status: GovernanceAssetStatus
    sourceRefs: GovernanceAsset["sourceRefs"]
    actorKind: "ai" | "external" | "human"
    createdBy: string
    confirmation?: { eventId: string; confirmedBy: string }
  }>(event))
})
