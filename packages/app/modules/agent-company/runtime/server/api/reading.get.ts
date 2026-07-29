import { createError, getQuery } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type {
  CompanyCommonsSourcesResponses,
  CompanyReadingAssignmentsResponses,
  CompanyReadingInterpretationsResponses,
  CompanyReadingProfilesResponses,
} from "@agents-company/sdk/v2"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { commonsAccess } from "../utils/commons-context"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event): Promise<{
  interpretations: CompanyReadingInterpretationsResponses[200]
  assignments: CompanyReadingAssignmentsResponses[200]
  profiles: CompanyReadingProfilesResponses[200]
  sources: CompanyCommonsSourcesResponses[200]
}> => {
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const access = await commonsAccess(event, client)
  const requestedProjectID = getQuery(event).project_id
  const projectID = typeof requestedProjectID === "string" ? requestedProjectID : undefined
  const [interpretations, assignments, profiles, sources] = await Promise.all([
    requestControlPlaneSDK<CompanyReadingInterpretationsResponses[200]>(
      client.companyReading.interpretations({
        company_id: access.company_id,
        project_ids: access.project_ids.join(","),
        private_owner_id: access.private_owner_id,
        project_id: projectID,
      }),
    ),
    requestControlPlaneSDK<CompanyReadingAssignmentsResponses[200]>(
      client.companyReading.assignments({
        company_id: access.company_id,
        project_ids: access.project_ids.join(","),
        private_owner_id: access.private_owner_id,
      }),
    ),
    requestControlPlaneSDK<CompanyReadingProfilesResponses[200]>(
      client.companyReading.profiles({ company_id: access.company_id }),
    ),
    requestControlPlaneSDK<CompanyCommonsSourcesResponses[200]>(
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
