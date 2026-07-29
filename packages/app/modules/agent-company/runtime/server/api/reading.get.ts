import { createError, getQuery } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type {
  AgentInterestProfileRecord,
  CommonsSourceRecord,
  InterpretationRecord,
  ReadingAssignmentRecord,
} from "@agents-company/sdk/v2"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { commonsAccess } from "../utils/commons-context"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event): Promise<{
  interpretations: InterpretationRecord[]
  assignments: ReadingAssignmentRecord[]
  profiles: AgentInterestProfileRecord[]
  sources: CommonsSourceRecord[]
}> => {
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const access = await commonsAccess(event, client)
  const projectID = typeof getQuery(event).project_id === "string" ? getQuery(event).project_id : undefined
  const [interpretations, assignments, profiles, sources] = await Promise.all([
    requestControlPlaneSDK<InterpretationRecord[]>(
      client.companyReading.interpretations({
        company_id: access.company_id,
        project_ids: access.project_ids.join(","),
        private_owner_id: access.private_owner_id,
        project_id: projectID,
      }),
    ),
    requestControlPlaneSDK<ReadingAssignmentRecord[]>(
      client.companyReading.assignments({
        company_id: access.company_id,
        project_ids: access.project_ids.join(","),
        private_owner_id: access.private_owner_id,
      }),
    ),
    requestControlPlaneSDK<AgentInterestProfileRecord[]>(
      client.companyReading.profiles({ company_id: access.company_id }),
    ),
    requestControlPlaneSDK<CommonsSourceRecord[]>(
      client.companyCommons.sources({
        company_id: access.company_id,
        project_ids: access.project_ids.join(","),
        private_owner_id: access.private_owner_id,
      }),
    ),
  ])
  if (!interpretations.ok || !assignments.ok || !profiles.ok || !sources.ok)
    throw createError({ statusCode: 503, statusMessage: "Reading workspace 暂时不可用" })
  return {
    interpretations: interpretations.value,
    assignments: assignments.value,
    profiles: profiles.value,
    sources: sources.value,
  }
})
