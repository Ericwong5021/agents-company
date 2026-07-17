import { Flag } from "@/flag/flag"

export type BasicCredentials = {
  username: string
  password: string
}

export type AuthMode = { mode: "trusted" } | { mode: "network"; basic: BasicCredentials }

export function authorization(credentials: BasicCredentials) {
  return "Basic " + Buffer.from(credentials.username + ":" + credentials.password).toString("base64")
}

export function serverAuthHeader(credentials?: { password?: string; username?: string }): string | undefined {
  const password = credentials?.password ?? Flag.AGENTCOMPANY_SERVER_PASSWORD
  if (!password) return undefined
  const username = credentials?.username ?? Flag.AGENTCOMPANY_SERVER_USERNAME ?? "agentcompany"
  return authorization({ username, password })
}

export function serverAuthHeaders(credentials?: { password?: string; username?: string }):
  | { Authorization: string }
  | undefined {
  const header = serverAuthHeader(credentials)
  if (!header) return undefined
  return { Authorization: header }
}
