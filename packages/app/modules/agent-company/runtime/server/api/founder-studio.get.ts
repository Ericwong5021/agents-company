import { createError, getQuery } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { createFounderStudioClient, type GovernanceAssetScope } from "@agents-company/sdk/v2/founder-os"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event) => {
  const query = getQuery(event)
  if (typeof query.companyId !== "string") throw createError({ statusCode: 400, statusMessage: "Company ID is required" })
  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const scope = {
    kind: typeof query.scopeKind === "string" ? query.scopeKind : "company",
    ...(typeof query.scopeRef === "string" ? { ref: query.scopeRef } : {}),
  } as GovernanceAssetScope
  return createFounderStudioClient({
    baseUrl: baseURL.origin,
    headers: config.agentCompanyControlPlaneAuthorization
      ? { authorization: config.agentCompanyControlPlaneAuthorization }
      : undefined,
  }).projection(query.companyId, scope)
})
