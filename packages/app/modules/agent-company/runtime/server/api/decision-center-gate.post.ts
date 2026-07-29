import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import {
  createFounderOSGovernanceClient,
  type FounderApprovalActorKind,
} from "@agents-company/sdk/v2/founder-os"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event) => {
  const input = await readBody<{
    gateId: string
    decision: "approve" | "reject"
    note: string
    actor: { kind: FounderApprovalActorKind; id: string }
  }>(event)
  if (!input.gateId) throw createError({ statusCode: 400, statusMessage: "Gate ID is required" })
  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  return createFounderOSGovernanceClient({
    baseUrl: baseURL.origin,
    headers: config.agentCompanyControlPlaneAuthorization
      ? { authorization: config.agentCompanyControlPlaneAuthorization }
      : undefined,
  }).resolveGate(input.gateId, {
    decision: input.decision,
    note: input.note,
    actor: input.actor,
  })
})
