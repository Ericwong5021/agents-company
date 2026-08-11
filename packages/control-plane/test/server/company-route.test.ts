import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { count } from "drizzle-orm"
import { CompanyProjectTable } from "../../src/company-project/company-project.sql"
import { CompanyProviderList } from "../../src/company/schema"
import { Config } from "../../src/config"
import { AppRuntime } from "../../src/effect/app-runtime"
import {
  GoalBriefGenerationRequestTable,
  GoalBriefTable,
  GoalBriefVersionTable,
} from "../../src/goal-brief/goal-brief.sql"
import { Server } from "../../src/server/server"
import { Database } from "../../src/storage"
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
    Database.use((db) => {
      db.insert(CompanyProjectTable)
        .values({
          id: "project-reset",
          goal: "验证公司重置",
          title: "公司重置",
          status: "intake",
          output_dir: "/tmp/project-reset",
          created_at: 100,
          updated_at: 100,
        })
        .run()
      db.insert(GoalBriefTable)
        .values({
          id: "brief-reset",
          project_id: "project-reset",
          created_at: 100,
          updated_at: 100,
        })
        .run()
      db.insert(GoalBriefVersionTable)
        .values({
          brief_id: "brief-reset",
          version: 1,
          goal: "验证公司重置",
          deliverables_json: "[]",
          acceptance_criteria_json: "[]",
          constraints_json: "[]",
          non_goals_json: "[]",
          assumptions_json: "[]",
          open_questions_json: "[]",
          risk_level: "low",
          recommended_plan_json: '{"summary":"重置","steps":[]}',
          approval_mode: "balanced",
          source: "user_input",
          source_refs_json: "[]",
          created_at: 100,
        })
        .run()
      db.insert(GoalBriefGenerationRequestTable)
        .values({
          request_id: "request-reset",
          payload_hash: "hash-reset",
          owner_token: "owner-reset",
          lease_expires_at: 200,
          brief_id: "brief-reset",
          created_at: 100,
          updated_at: 100,
        })
        .run()
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
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefGenerationRequestTable).get())?.value).toBe(
      0,
    )
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefVersionTable).get())?.value).toBe(0)
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefTable).get())?.value).toBe(0)
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
        {
          model_id: "claude-custom",
          name: "Claude Custom",
          capabilities: {
            tool_call: "unknown",
            structured_output: "unknown",
            interrupt_resume: "supported",
          },
        },
        {
          model_id: "zeta",
          name: "Zeta",
          capabilities: {
            tool_call: "unknown",
            structured_output: "unknown",
            interrupt_resume: "supported",
          },
        },
      ])
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        authorization: "Bearer custom-provider-secret",
        "anthropic-version": "2023-06-01",
        "x-client": "company-test",
      })
    } finally {
      await endpoint.stop(true)
    }
  })

  test.serial("atomically configures a custom provider and binds it to the company without returning secrets", async () => {
    const requests: { url: string; headers: Record<string, string> }[] = []
    const endpoint = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push({ url: request.url, headers: Object.fromEntries(request.headers) })
        return Response.json({
          data: [
            { id: "model-secondary", name: "Secondary" },
            { id: "model-primary", name: "Primary" },
          ],
        })
      },
    })
    const app = Server.Default().app
    try {
      const response = await app.request("/company/provider", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          format: "openai",
          base_url: endpoint.url,
          api_key: "atomic-provider-secret",
          headers: { "x-company-route": "configured" },
          provider_id: "route-custom-provider",
          model_id: "model-primary",
        }),
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({
        state: "ready",
        company: {
          provider: {
            provider_id: "route-custom-provider",
            model_id: "model-primary",
          },
        },
      })
      expect(JSON.stringify(body)).not.toContain("atomic-provider-secret")
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        url: `${endpoint.url}models`,
        headers: {
          authorization: "Bearer atomic-provider-secret",
          "x-company-route": "configured",
        },
      })

      const providers = CompanyProviderList.parse(await (await app.request("/company/providers")).json())
      expect(
        providers.providers.find((provider) => provider.provider_id === "route-custom-provider"),
      ).toMatchObject({
        connected: true,
        models: expect.arrayContaining([
          expect.objectContaining({ model_id: "model-primary", name: "Primary" }),
          expect.objectContaining({ model_id: "model-secondary", name: "Secondary" }),
        ]),
      })
      expect(await AppRuntime.runPromise(Config.Service.use((config) => config.getGlobal()))).toMatchObject({
        model: "route-custom-provider/model-primary",
        small_model: "route-custom-provider/model-primary",
        model_groups: {
          ultra: "route-custom-provider/model-primary",
          standard: "route-custom-provider/model-primary",
          lite: "route-custom-provider/model-primary",
        },
      })
    } finally {
      await endpoint.stop(true)
      await app.request("/company/providers/route-custom-provider/credentials", { method: "DELETE" })
      await AppRuntime.runPromise(Config.Service.use((config) => config.resetProviderSettings()))
    }
  })

  test.serial("rejects invalid custom provider configuration before contacting the endpoint", async () => {
    let requests = 0
    const endpoint = Bun.serve({
      port: 0,
      fetch() {
        requests++
        return Response.json({ data: [{ id: "model-primary" }] })
      },
    })
    try {
      const response = await Server.Default().app.request("/company/provider", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          format: "openai",
          base_url: endpoint.url,
          api_key: "provider-secret",
          headers: {},
          provider_id: "Invalid Provider ID",
          model_id: "model-primary",
          unexpected: true,
        }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ name: "ProductValidationError" })
      expect(requests).toBe(0)
    } finally {
      await endpoint.stop(true)
    }
  })

  test.serial("declares non-empty schemas for every M1 company operation", async () => {
    const spec = await Server.openapi()
    const operations = [
      { method: "get", path: "/company", request: false, statuses: ["200", "401", "500"] },
      { method: "put", path: "/company/approval-policy", request: true, statuses: ["200", "400", "401", "500"] },
      { method: "post", path: "/company/reset", request: true, statuses: ["200", "400", "401", "500"] },
      { method: "get", path: "/company/providers", request: false, statuses: ["200", "401", "500"] },
      { method: "put", path: "/company/provider", request: true, statuses: ["200", "400", "401", "500"] },
      { method: "get", path: "/company/providers/auth", request: false, statuses: ["200", "401", "500"] },
      { method: "post", path: "/company/providers/models", request: true, statuses: ["200", "400", "401"] },
      {
        method: "put",
        path: "/company/providers/{providerID}/credentials",
        request: true,
        statuses: ["200", "400", "401", "500"],
      },
      {
        method: "delete",
        path: "/company/providers/{providerID}/credentials",
        request: false,
        statuses: ["200", "400", "401", "500"],
      },
      {
        method: "post",
        path: "/company/providers/{providerID}/oauth/authorize",
        request: true,
        statuses: ["200", "400", "401", "500"],
      },
      {
        method: "post",
        path: "/company/providers/{providerID}/oauth/callback",
        request: true,
        statuses: ["200", "400", "401", "500"],
      },
      { method: "post", path: "/company/repository/inspect", request: true, statuses: ["200", "400", "401", "500"] },
      { method: "post", path: "/company/bootstrap", request: true, statuses: ["200", "400", "401", "409", "500"] },
    ] as const
    for (const item of operations) {
      const operation = spec.paths?.[item.path]?.[item.method]
      expect(operation).toBeDefined()
      if (item.request) {
        if (!operation?.requestBody || !("content" in operation.requestBody))
          throw new Error(`Missing JSON request schema for ${item.method} ${item.path}`)
        expect(operation.requestBody.content?.["application/json"]?.schema).toBeDefined()
      }
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
