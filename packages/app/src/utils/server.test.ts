import { describe, expect, test } from "bun:test"
import { authorizationHeaders, createSdkForServer } from "./server"

describe("connection authorization", () => {
  test("prefers a paired bearer token over Basic fields", () => {
    expect(
      authorizationHeaders({
        url: "http://127.0.0.1:4096",
        username: "agentcompany",
        password: "ephemeral",
        token: "ac1_credential_secret",
      }),
    ).toEqual({ Authorization: "Bearer ac1_credential_secret" })
  })

  test("uses the same bearer credential for operations and the event stream", async () => {
    const requests: Request[] = []
    const fetcher = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const request = new Request(args[0], args[1])
        requests.push(request)
        if (new URL(request.url).pathname === "/global/event") {
          return new Response('data: {"type":"server.connected","properties":{}}\n\n', {
            headers: { "content-type": "text/event-stream" },
          })
        }
        return Response.json({ healthy: true })
      },
      { preconnect: fetch.preconnect },
    )
    const client = createSdkForServer({
      server: { url: "http://company.test", token: "ac1_credential_secret" },
      fetch: fetcher,
    })

    await client.global.health()
    const events = await client.global.event()
    await events.stream[Symbol.asyncIterator]().next()

    expect(requests.map((request) => request.headers.get("Authorization"))).toEqual([
      "Bearer ac1_credential_secret",
      "Bearer ac1_credential_secret",
    ])
  })
})
