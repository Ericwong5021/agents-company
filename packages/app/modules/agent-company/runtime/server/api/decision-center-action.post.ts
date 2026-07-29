import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import {
  createFounderOSGovernanceClient,
  type DecisionCenterActionInput,
} from "@agents-company/sdk/v2/founder-os"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event) => {
  const input = await readBody<{ decisionId: string; action: DecisionCenterActionInput }>(event)
  if (!input.decisionId) throw createError({ statusCode: 400, statusMessage: "Decision ID is required" })
  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  return createFounderOSGovernanceClient({
    baseUrl: baseURL.origin,
    headers: config.agentCompanyControlPlaneAuthorization
      ? { authorization: config.agentCompanyControlPlaneAuthorization }
      : undefined,
  }).action(input.decisionId, input.action)
})
