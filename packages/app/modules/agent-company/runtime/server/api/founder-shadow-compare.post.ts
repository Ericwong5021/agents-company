import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import {
  createFounderShadowClient,
  type FounderShadowEvidenceRef,
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
  }).compare(await readBody<{
    companyId: string
    shadowDecisionId: string
    actualDecision: string
    actualDecisionRef: FounderShadowEvidenceRef
    alignment: "match" | "partial" | "mismatch"
    rationale: string
    comparedBy: string
    confirmation?: { eventId: string; confirmedBy: string }
  }>(event))
})
