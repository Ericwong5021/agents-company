import type { H3Event } from "h3"
import { createError } from "h3"
import type { ControlPlaneClient } from "@agents-company/sdk/v2"
import { requireSessionUserId } from "~~/server/utils/session"
import { requestControlPlaneSDK } from "./control-plane-client"

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export async function commonsAccess(event: H3Event, client: ControlPlaneClient) {
  const [stateResult, projectsResult, userID] = await Promise.all([
    requestControlPlaneSDK<unknown>(client.company.current()),
    requestControlPlaneSDK<unknown>(client.companyProject.list()),
    requireSessionUserId(event),
  ])
  if (!stateResult.ok || !record(stateResult.value) || !record(stateResult.value.company))
    throw createError({ statusCode: 503, statusMessage: "Company is not ready" })
  if (typeof stateResult.value.company.id !== "string")
    throw createError({ statusCode: 503, statusMessage: "Company identity is unavailable" })
  return {
    company_id: stateResult.value.company.id,
    project_ids: projectsResult.ok && Array.isArray(projectsResult.value)
      ? projectsResult.value.flatMap((project) =>
          record(project) && typeof project.id === "string" ? [project.id] : [],
        )
      : [],
    private_owner_id: userID,
  }
}
