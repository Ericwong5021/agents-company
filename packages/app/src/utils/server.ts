import { createControlPlaneClient } from "@agents-company/sdk/v2/client"
import type { ServerConnection } from "@/context/server"

export function authorizationHeaders(server: ServerConnection.HttpBase) {
  if (server.token) return { Authorization: `Bearer ${server.token}` }
  if (!server.password) return {}
  return {
    Authorization: `Basic ${btoa(`${server.username ?? "agentcompany"}:${server.password}`)}`,
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createControlPlaneClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  return createControlPlaneClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...authorizationHeaders(server),
    },
    baseUrl: server.url,
  })
}
