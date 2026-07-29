import { createError } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type {
  CompanyCommonsCapabilitiesResponses,
  CompanyCommonsSourcesResponses,
} from "@agents-company/sdk/v2"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { commonsAccess } from "../utils/commons-context"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event): Promise<{
  sources: CompanyCommonsSourcesResponses[200]
  capabilities: CompanyCommonsCapabilitiesResponses[200]
}> => {
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const access = await commonsAccess(event, client)
  const [sources, capabilities] = await Promise.all([
    requestControlPlaneSDK<CompanyCommonsSourcesResponses[200]>(
      client.companyCommons.sources({
        company_id: access.company_id,
        project_ids: access.project_ids.join(","),
        private_owner_id: access.private_owner_id,
      }),
    ),
    requestControlPlaneSDK<CompanyCommonsCapabilitiesResponses[200]>(client.companyCommons.capabilities()),
  ])
  if (!sources.ok || !capabilities.ok)
    throw createError({ statusCode: 503, statusMessage: "Commons 暂时不可用" })
  return { sources: sources.value, capabilities: capabilities.value }
})
