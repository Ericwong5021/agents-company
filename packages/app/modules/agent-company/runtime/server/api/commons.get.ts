import { createError } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type {
  CommonsCapabilityRecord,
  CommonsSourceRecord,
} from "@agents-company/sdk/v2"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { commonsAccess } from "../utils/commons-context"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event): Promise<{
  sources: CommonsSourceRecord[]
  capabilities: CommonsCapabilityRecord[]
}> => {
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const access = await commonsAccess(event, client)
  const [sources, capabilities] = await Promise.all([
    requestControlPlaneSDK<CommonsSourceRecord[]>(
      client.companyCommons.sources({
        company_id: access.company_id,
        project_ids: access.project_ids.join(","),
        private_owner_id: access.private_owner_id,
      }),
    ),
    requestControlPlaneSDK<CommonsCapabilityRecord[]>(client.companyCommons.capabilities()),
  ])
  if (!sources.ok || !capabilities.ok)
    throw createError({ statusCode: 503, statusMessage: "Commons 暂时不可用" })
  return { sources: sources.value, capabilities: capabilities.value }
})
