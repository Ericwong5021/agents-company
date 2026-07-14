export * from "./client.js"
export * from "./server.js"

import { createOpencodeClient } from "./client.js"
import { createOpencodeServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createOpencode(options?: ServerOptions) {
  const server = await createOpencodeServer({
    ...options,
  })

  const client = createOpencodeClient({
    baseUrl: server.url,
    headers: {
      Authorization: "Basic " + Buffer.from(server.username + ":" + server.password).toString("base64"),
    },
  })

  return {
    client,
    server,
  }
}
