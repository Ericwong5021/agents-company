import { expect, test } from "bun:test"
import { createOpencodeClient, type CompanyState } from "@agents-company/sdk/v2/client"
import { createSdkCompanyWorkspaceDataSource } from "./company-data-source"

const needsBootstrap: CompanyState = {
  state: "needs_bootstrap",
  data_directory: "/company/data",
  defaults: {
    company_name: "Agent Company",
    approval_preset: "balanced",
    board: [
      { id: "board-ceo", role: "ceo", name: "CEO", lifecycle: "employee", responsibilities: ["公司目标与最终取舍"] },
      { id: "board-cto", role: "cto", name: "CTO", lifecycle: "employee", responsibilities: ["技术方向与工程质量"] },
      {
        id: "board-product-lead",
        role: "product_lead",
        name: "Product Lead",
        lifecycle: "employee",
        responsibilities: ["用户价值与验收"],
      },
    ],
  },
  capabilities: { board_messages: false },
}

const ready: CompanyState = {
  state: "ready",
  data_directory: "/company/data",
  company: {
    id: "cmp_local",
    name: "Agent Company",
    data_version: 1,
    provider: { provider_id: "openai", model_id: "gpt-5" },
    approval_policy: { preset: "balanced" },
    repository: {
      project_id: "project-1",
      root_path: "/repo",
      default_branch: "main",
      bootstrap_head_commit: "abc",
      dirty: false,
    },
    board: needsBootstrap.defaults.board,
    created_at: 1,
    updated_at: 1,
  },
  start_suggestion: { kind: "bootstrap_complete", action: "open_board" },
  capabilities: { board_messages: false },
}

test("publishes needs_bootstrap then ready from SDK responses", async () => {
  const responses: CompanyState[] = [needsBootstrap, ready]
  const fetcher = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const request = new Request(args[0], args[1])
      if (new URL(request.url).pathname === "/local-auth/session") {
        return Response.json({ authenticated: true, kind: "basic" })
      }
      const data = responses.shift()
      if (!data) return Response.json({ name: "UnexpectedRequest" }, { status: 500 })
      return Response.json(data)
    },
    { preconnect: fetch.preconnect },
  )
  const source = createSdkCompanyWorkspaceDataSource(
    createOpencodeClient({
      baseUrl: "http://company.test",
      fetch: fetcher,
    }),
  )

  await source.refresh()
  const bootstrap = source.getSnapshot()
  expect(bootstrap.status).toBe("needs_bootstrap")
  if (bootstrap.status !== "needs_bootstrap") throw new Error("Expected bootstrap snapshot")
  expect(bootstrap.access.can_manage_credentials).toBe(true)

  await source.refresh()
  expect(source.getSnapshot().status).toBe("ready")
})
