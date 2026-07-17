import { describe, expect, test } from "bun:test"
import { LocalAuthSession, LocalExchangeInput, LocalPairing } from "../../src/local-auth/schema"
import { ProductValidationError } from "../../src/server/error"
import { authorization, Server } from "../../src/server/server"

const credentials = { username: "agentcompany", password: "route-secret" }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function jsonSchema(operation: unknown, status: string) {
  if (!record(operation) || !record(operation.responses)) throw new Error("Missing operation responses")
  const responses = operation.responses
  if (!(status in responses)) throw new Error(`Missing ${status} response`)
  const response = responses[status]
  if (!record(response) || !record(response.content)) throw new Error(`Missing JSON response for ${status}`)
  const content = response.content
  if (!("application/json" in content)) throw new Error(`Missing JSON content for ${status}`)
  const json = content["application/json"]
  if (!record(json) || !("schema" in json)) throw new Error(`Missing JSON schema for ${status}`)
  return json.schema
}

describe.serial("/local-auth", () => {
  test.serial("uses Basic for credential management and Bearer for data access", async () => {
    const built = Server.create({ auth: { mode: "network", basic: credentials } })
    const basic = authorization(credentials)

    const missing = await built.app.request("/local-auth/session")
    expect(missing.status).toBe(401)
    expect(missing.headers.get("www-authenticate")).toContain("Basic")
    expect(LocalAuthSession.parse(await (await built.app.request("/local-auth/session", { headers: { authorization: basic } })).json())).toMatchObject({
      kind: "basic",
    })

    const pairing = LocalPairing.parse(
      await (
        await built.app.request("/local-auth/pairings", {
          method: "POST",
          headers: { authorization: basic, "content-type": "application/json", origin: "https://untrusted.example" },
          body: JSON.stringify({ label: "Chrome test browser" }),
        })
      ).json(),
    )
    expect(pairing.pairing_url).toStartWith("http://localhost/?pair=")
    expect(pairing.pairing_url).not.toContain("untrusted.example")

    const issued = LocalExchangeInput.parse({ code: pairing.code, label: pairing.label })
    const exchange = await built.app.request("/local-auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(issued),
    })
    expect(exchange.status).toBe(200)
    const issuedCredential = (await exchange.json()) as { token: string; credential_id: string }
    const token = issuedCredential.token
    const credentialID = (await built.app.request("/local-auth/session", { headers: { authorization: "Bearer " + token } }))
    expect(credentialID.status).toBe(200)
    expect(await credentialID.json()).toMatchObject({ kind: "bearer" })

    expect((await built.app.request("/local-auth/credentials", { headers: { authorization: "Bearer " + token } })).status).toBe(403)
    const records = await built.app.request("/local-auth/credentials", { headers: { authorization: basic } })
    expect(records.status).toBe(200)
    const listed = ((await records.json()) as { id: string }[]).find((item) => item.id === issuedCredential.credential_id)
    expect(listed).toBeDefined()
    if (!listed) throw new Error("Issued credential was not listed")

    expect(
      (
        await built.app.request("/local-auth/credentials/" + listed.id, {
          method: "DELETE",
          headers: { authorization: basic },
        })
      ).status,
    ).toBe(200)
    expect((await built.app.request("/company", { headers: { authorization: "Bearer " + token } })).status).toBe(401)
  })

  test.serial("returns strict validation errors and documents every M1 auth response", async () => {
    const built = Server.create({ auth: { mode: "network", basic: credentials } })
    const malformed = await built.app.request("/local-auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: 123 }),
    })
    expect(malformed.status).toBe(400)
    expect(ProductValidationError.parse(await malformed.json()).name).toBe("ProductValidationError")

    const spec = await Server.openapi()
    const operations = [
      { method: "get", path: "/local-auth/session", statuses: ["200", "401", "500"] },
      { method: "post", path: "/local-auth/pairings", statuses: ["200", "400", "401", "403", "500"] },
      { method: "get", path: "/local-auth/credentials", statuses: ["200", "401", "403", "500"] },
      { method: "delete", path: "/local-auth/credentials/{id}", statuses: ["200", "400", "401", "403", "500"] },
      { method: "post", path: "/local-auth/exchange", statuses: ["200", "400", "500"] },
      { method: "get", path: "/company", statuses: ["200", "401", "500"] },
      { method: "get", path: "/company/providers", statuses: ["200", "401", "500"] },
      { method: "get", path: "/company/providers/auth", statuses: ["200", "401", "500"] },
      { method: "put", path: "/company/providers/{providerID}/credentials", statuses: ["200", "400", "401", "500"] },
      { method: "delete", path: "/company/providers/{providerID}/credentials", statuses: ["200", "400", "401", "500"] },
      { method: "post", path: "/company/providers/{providerID}/oauth/authorize", statuses: ["200", "400", "401", "500"] },
      { method: "post", path: "/company/providers/{providerID}/oauth/callback", statuses: ["200", "400", "401", "500"] },
      { method: "post", path: "/company/repository/inspect", statuses: ["200", "400", "401", "500"] },
      { method: "post", path: "/company/bootstrap", statuses: ["200", "400", "401", "409", "500"] },
    ] as const

    for (const item of operations) {
      const operation = spec.paths?.[item.path]?.[item.method]
      for (const status of item.statuses) expect(jsonSchema(operation, status)).toBeDefined()
    }
  })
})
