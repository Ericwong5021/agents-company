const allowedAuthRequests = new Set([
  "GET /api/auth/get-session",
  "GET /api/auth/get-session/",
  "POST /api/auth/sign-out",
  "POST /api/auth/sign-out/",
])

export function isAllowedAuthHTTPRequest(input: {
  method?: string
  requestTarget?: string
}) {
  return allowedAuthRequests.has(
    `${input.method} ${input.requestTarget?.split("?", 1)[0]}`,
  )
}
