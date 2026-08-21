import { getQuery } from "h3"
import { requireSessionUserId } from "~~/server/utils/session"

export default defineEventHandler(async (event) => {
  await requireSessionUserId(event)
  const rawCode = getQuery(event).code
  const code = typeof rawCode === "string" ? rawCode : ""
  if (!code) throw createError({ statusCode: 400, statusMessage: "Authorization code is required." })
  const config = useRuntimeConfig(event)
  const response = await fetch(
    new URL(
      `/api/v1/remote/device-authorizations/${encodeURIComponent(getRouterParam(event, "id") ?? "")}?code=${encodeURIComponent(code)}`,
      config.agentCompanyRelayInternalUrl,
    ),
    { signal: AbortSignal.timeout(5_000) },
  )
  if (!response.ok)
    throw createError({ statusCode: response.status, statusMessage: "Remote authorization is unavailable." })
  return response.json()
})
