import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import {
  createFounderOSGovernanceClient,
  type FounderYellowRollbackInput,
} from "@agents-company/sdk/v2/founder-os"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event) => {
  const input = await readBody<{ runId: string; rollback: FounderYellowRollbackInput }>(event)
  if (!input.runId) throw createError({ statusCode: 400, statusMessage: "Yellow run ID is required" })
  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  return createFounderOSGovernanceClient({
    baseUrl: baseURL.origin,
    headers: config.agentCompanyControlPlaneAuthorization
      ? { authorization: config.agentCompanyControlPlaneAuthorization }
      : undefined,
  }).rollbackYellow(input.runId, input.rollback)
})
