import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CompanyProviderList } from "../../src/company/schema"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"

const boardMessagesOverride = process.env.AGENTCOMPANY_DISABLE_BOARD_MESSAGES

beforeEach(() => {
  delete process.env.AGENTCOMPANY_DISABLE_BOARD_MESSAGES
})

afterEach(async () => {
  if (boardMessagesOverride === undefined) delete process.env.AGENTCOMPANY_DISABLE_BOARD_MESSAGES
  else process.env.AGENTCOMPANY_DISABLE_BOARD_MESSAGES = boardMessagesOverride
  await Server.Default().app.request("/company/providers/openai/credentials", { method: "DELETE" })
  await resetDatabase()
})

async function nonGitDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-company-route-"))
  return {
    path: await fs.realpath(directory),
    [Symbol.asyncDispose]: () => fs.rm(directory, { recursive: true, force: true }),
  }
}

describe.serial("/company", () => {
  test.serial("creates a ready empty company on first access", async () => {
    const response = await Server.Default().app.request("/company")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      state: "ready",
      company: {
        name: "Agent Company",
        provider: null,
        repository: null,
      },
      capabilities: { board_messages: true },
    })
  })

  test.serial("exposes the emergency read-only capability switch", async () => {
    process.env.AGENTCOMPANY_DISABLE_BOARD_MESSAGES = "true"
    const response = await Server.Default().app.request("/company")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ capabilities: { board_messages: false } })
  })

  test.serial("updates the company approval preset", async () => {
    const app = Server.Default().app
    const response = await app.request("/company/approval-policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "autonomous" }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      state: "ready",
      company: { approval_policy: { preset: "autonomous" } },
    })
    expect(await (await app.request("/company")).json()).toMatchObject({
      company: { approval_policy: { preset: "autonomous" } },
    })
  })

  test.serial("resets local company data only after explicit confirmation", async () => {
    const app = Server.Default().app
    await app.request("/company/setup-goal", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "为新产品准备发布计划" }),
    })

    const rejected = await app.request("/company/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clear_provider_config: false }),
    })
    expect(rejected.status).toBe(400)

    const response = await app.request("/company/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "RESET", clear_provider_config: false }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      state: "ready",
      company: {
        provider: null,
        repository: null,
        setup_goal: null,
      },
    })
  })

  test.serial("rejects non-git repository inspection with a product error", async () => {
    await using directory = await nonGitDirectory()
    const response = await Server.Default().app.request("/company/repository/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository_path: directory.path }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ name: "CompanyRepositoryNotGit" })
  })

  test.serial("returns a strict provider projection without secrets or upstream Zen", async () => {
    const app = Server.Default().app
    const before = CompanyProviderList.parse(await (await app.request("/company/providers")).json())
    expect(before.providers.some((provider) => provider.provider_id === "openai" && !provider.connected)).toBe(true)
    expect(
      (
        await app.request("/company/providers/openai/credentials", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "api", key: "super-secret-provider-key" }),
        })
      ).status,
    ).toBe(200)
    const response = await app.request("/company/providers")
    const providers = CompanyProviderList.parse(await response.json())
    expect(JSON.stringify(providers)).not.toContain("super-secret-provider-key")
    expect(providers.providers.some((provider) => provider.provider_id === "openai" && provider.connected)).toBe(true)
    expect(providers.providers.some((provider) => provider.provider_id === "control-plane")).toBe(false)
    expect(providers.providers.some((provider) => provider.provider_id === "control-plane-go")).toBe(true)
  })

  test.serial("discovers models from OpenAI- and Anthropic-compatible custom endpoints", async () => {
    const requests: Record<string, string>[] = []
    const endpoint = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(Object.fromEntries(request.headers))
        return Response.json({
          data: [
            { id: "zeta", name: "Zeta" },
            { id: "claude-custom", display_name: "Claude Custom" },
          ],
        })
      },
    })
    try {
      const app = Server.Default().app
      const response = await app.request("/company/providers/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          format: "anthropic",
          base_url: endpoint.url,
          api_key: "custom-provider-secret",
          headers: { "x-client": "company-test" },
        }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([
        { model_id: "claude-custom", name: "Claude Custom" },
        { model_id: "zeta", name: "Zeta" },
      ])
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        authorization: "Bearer custom-provider-secret",
        "anthropic-version": "2023-06-01",
        "x-client": "company-test",
      })
    } finally {
      endpoint.stop(true)
    }
  })

  test.serial("declares non-empty schemas for every M1 company operation", async () => {
    const spec = await Server.openapi()
    const operations = [
      { method: "get", path: "/company", statuses: ["200", "500"] },
      { method: "put", path: "/company/approval-policy", statuses: ["200", "400", "500"] },
      { method: "post", path: "/company/reset", statuses: ["200", "400", "500"] },
      { method: "get", path: "/company/providers", statuses: ["200", "500"] },
      { method: "get", path: "/company/providers/auth", statuses: ["200", "500"] },
      { method: "post", path: "/company/providers/models", statuses: ["200", "400"] },
      { method: "put", path: "/company/providers/{providerID}/credentials", statuses: ["200", "400", "500"] },
      { method: "delete", path: "/company/providers/{providerID}/credentials", statuses: ["200", "400", "500"] },
      { method: "post", path: "/company/providers/{providerID}/oauth/authorize", statuses: ["200", "400", "500"] },
      { method: "post", path: "/company/providers/{providerID}/oauth/callback", statuses: ["200", "400", "500"] },
      { method: "post", path: "/company/repository/inspect", statuses: ["200", "400", "500"] },
      { method: "post", path: "/company/bootstrap", statuses: ["200", "400", "409", "500"] },
    ] as const
    for (const item of operations) {
      const operation = spec.paths?.[item.path]?.[item.method]
      expect(operation).toBeDefined()
      item.statuses.map((status) => {
        const response = operation?.responses?.[status]
        expect(response).toBeDefined()
        if (!response || !("content" in response))
          throw new Error(`Missing JSON response schema for ${item.method} ${item.path}`)
        expect(response.content?.["application/json"]?.schema).toBeDefined()
      })
    }
  })
})
