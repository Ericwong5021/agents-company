import { createError, getRequestHeader, getRequestIP, getRequestURL, type H3Event } from "h3"

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])
const loopbackIPs = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

export function resolveClientIP(input: { directIP?: string; forwardedIP?: string; trustedDevProxy: boolean }) {
  if (!input.trustedDevProxy) return input.forwardedIP ? undefined : input.directIP
  if (!input.directIP) return input.forwardedIP
  if (!input.forwardedIP || !loopbackIPs.has(input.directIP)) return input.directIP
  return input.forwardedIP
}

export function isTrustedLoopbackRequest(input: {
  host?: string
  hostname: string
  ip?: string
  origin?: string
  requestOrigin: string
}) {
  return Boolean(
    input.host?.trim() &&
      loopbackHosts.has(input.hostname) &&
      input.ip &&
      loopbackIPs.has(input.ip) &&
      input.origin &&
      input.origin === input.requestOrigin,
  )
}

export function requireTrustedLoopbackRequest(event: H3Event) {
  const requestURL = getRequestURL(event)
  const forwardedIP = getRequestHeader(event, "x-forwarded-for")?.split(",")[0]?.trim()
  if (
    isTrustedLoopbackRequest({
      host: getRequestHeader(event, "host"),
      hostname: requestURL.hostname,
      ip: resolveClientIP({
        directIP: getRequestIP(event),
        forwardedIP,
        trustedDevProxy: Boolean(process.env.NITRO_DEV_WORKER_ID),
      }),
      origin: getRequestHeader(event, "origin"),
      requestOrigin: requestURL.origin,
    })
  )
    return

  throw createError({
    statusCode: 403,
    statusMessage: "Local account is only available on loopback.",
  })
}
