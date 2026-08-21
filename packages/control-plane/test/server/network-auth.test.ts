import { describe, expect, test } from "bun:test"
import { authorization, Server } from "../../src/server/server"

const credentials = { username: "agentcompany", password: "secret" }

describe("network authentication", () => {
  test("trusts a loopback listener without pairing by default", async () => {
    const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      expect(server.credentials).toBeUndefined()
      const response = await fetch(new URL("/local-auth/session", server.url))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ authenticated: true, kind: "trusted" })
    } finally {
      await server.stop(true)
    }
  })

  test("protects data while keeping health and WebUI public", async () => {
    const built = Server.create({ auth: { mode: "network", basic: credentials } })
    expect((await built.app.request("/global/health")).status).toBe(200)
    expect((await built.app.request("/")).status).not.toBe(401)
    expect((await built.app.request("/company")).status).toBe(401)
    expect((await built.app.request("/global/event")).status).toBe(401)
    expect((await built.app.request("/global/log")).status).toBe(401)
    expect((await built.app.request("/company?auth_token=" + btoa("agentcompany:secret"))).status).toBe(401)

    const response = await built.app.request("/company", {
      headers: { authorization: authorization(credentials) },
    })
    expect(response.status).toBe(200)
  })

  test("uses the configured CORS allowlist and does not trust legacy origins", async () => {
    const built = Server.create({ auth: { mode: "network", basic: credentials }, cors: ["http://127.0.0.1:3210"] })
    const legacy = await built.app.request("/global/health", {
      headers: { origin: "https://app.controlPlane.ai" },
    })
    const webui = await built.app.request("/global/health", {
      headers: { origin: "http://127.0.0.1:3210" },
    })

    expect(legacy.headers.get("access-control-allow-origin")).toBeNull()
    expect(webui.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:3210")
  })
})
