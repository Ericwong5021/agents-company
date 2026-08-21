import { timingSafeEqual } from "node:crypto"
import { getRequestHeader, getRequestIP, readValidatedBody, sendWebResponse } from "h3"
import { z } from "zod"
import { auth } from "~~/auth"
import { getNodeRequest, getRequestOrigin } from "~~/server/utils/h3-node"

const Body = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(256),
})
const attempts = new Map<string, { count: number; reset_at: number }>()

function equal(left: string, right: string) {
  const first = Buffer.from(left)
  const second = Buffer.from(right)
  return first.length === second.length && timingSafeEqual(first, second)
}

export default defineEventHandler(async (event) => {
  if (getRequestHeader(event, "origin") !== getRequestOrigin(event))
    throw createError({ statusCode: 403, statusMessage: "Remote login requires a same-origin request." })
  const configuredEmail = process.env.AGENT_COMPANY_REMOTE_EMAIL?.trim().toLowerCase() ?? ""
  const configuredPassword = process.env.AGENT_COMPANY_REMOTE_PASSWORD ?? ""
  if (!configuredEmail || configuredPassword.length < 12)
    throw createError({ statusCode: 503, statusMessage: "Remote login is not configured." })
  const client = getRequestIP(event, { xForwardedFor: true }) ?? "unknown"
  const attempt = attempts.get(client)
  if (attempt && attempt.reset_at > Date.now() && attempt.count >= 5)
    throw createError({ statusCode: 429, statusMessage: "Too many login attempts." })
  const body = await readValidatedBody(event, (value) => Body.parse(value))
  if (!equal(body.email.trim().toLowerCase(), configuredEmail) || !equal(body.password, configuredPassword)) {
    attempts.set(
      client,
      attempt && attempt.reset_at > Date.now()
        ? { count: attempt.count + 1, reset_at: attempt.reset_at }
        : { count: 1, reset_at: Date.now() + 15 * 60 * 1000 },
    )
    throw createError({ statusCode: 401, statusMessage: "Email or password is incorrect." })
  }
  attempts.delete(client)
  const headers = new Headers(
    Object.entries(getNodeRequest(event).headers).flatMap(([name, value]) =>
      typeof value === "string"
        ? [[name, value] as [string, string]]
        : (value?.map((item) => [name, item] as [string, string]) ?? []),
    ),
  )
  const account = { email: configuredEmail, password: configuredPassword, name: "负责人", rememberMe: true }
  const existing = await auth.api.signInEmail({ body: account, headers, asResponse: true })
  if (existing.ok) return sendWebResponse(event, existing)
  const created = await auth.api.signUpEmail({ body: account, headers, asResponse: true })
  if (created.ok) return sendWebResponse(event, created)
  return sendWebResponse(event, await auth.api.signInEmail({ body: account, headers, asResponse: true }))
})
