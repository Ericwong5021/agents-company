export * from "./client.js"
export * from "./server.js"

import { createControlPlaneClient } from "./client.js"
import { createControlPlaneServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createControlPlane(options?: ServerOptions) {
  const server = await createControlPlaneServer({
    ...options,
  })

  const client = createControlPlaneClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
