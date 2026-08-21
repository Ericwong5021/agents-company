import { getRequestHeader, readValidatedBody } from "h3"
import { z } from "zod"
import { getRequestOrigin } from "~~/server/utils/h3-node"
import { requireSessionUserId } from "~~/server/utils/session"

const Body = z.object({ user_code: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  await requireSessionUserId(event)
  if (getRequestHeader(event, "origin") !== getRequestOrigin(event))
    throw createError({ statusCode: 403, statusMessage: "Device approval requires a same-origin request." })
  const body = await readValidatedBody(event, (value) => Body.parse(value))
  const config = useRuntimeConfig(event)
  const response = await fetch(
    new URL(
      `/api/v1/remote/internal/device-authorizations/${encodeURIComponent(getRouterParam(event, "id") ?? "")}/approve`,
      config.agentCompanyRelayInternalUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.agentCompanyRelayServiceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    },
  )
  if (!response.ok) throw createError({ statusCode: response.status, statusMessage: "Device approval failed." })
  return response.json()
})
