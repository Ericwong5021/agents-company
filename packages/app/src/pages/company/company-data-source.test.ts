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

const companyChannel = [
  {
    id: "chn_company",
    kind: "company" as const,
    title: "公司群",
    scopeID: undefined,
    retentionDays: 30,
    time: { created: 1, updated: 1 },
  },
  {
    id: "chn_board",
    kind: "board" as const,
    title: "董事会",
    scopeID: undefined,
    retentionDays: 30,
    time: { created: 2, updated: 2 },
  },
]

const readyCompany = {
  id: "cmp_local",
  name: "Agent Company",
  data_version: 1 as const,
  provider: { provider_id: "openai", model_id: "gpt-5" },
  approval_policy: { preset: "balanced" as const },
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
}

const ready: CompanyState = {
  state: "ready",
  data_directory: "/company/data",
  company: readyCompany,
  start_suggestion: { kind: "bootstrap_complete", action: "open_board" },
  capabilities: { board_messages: false },
}

test("publishes needs_bootstrap snapshot from SDK responses", async () => {
  const responses: CompanyState[] = [needsBootstrap]
  const fetcher = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const request = new Request(args[0], args[1])
      const path = new URL(request.url).pathname
      if (path === "/local-auth/session") {
        return Response.json({ authenticated: true, kind: "basic" })
      }
      if (path === "/company/channels") {
        return Response.json(companyChannel)
      }
      if (path === "/company") {
        const data = responses.shift()
        if (!data) return Response.json({ name: "UnexpectedRequest" }, { status: 500 })
        return Response.json(data)
      }
      return Response.json({ name: "UnexpectedRequest" }, { status: 500 })
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
})

test("publishes ready snapshot with conversation state from SDK responses", async () => {
  const responses: CompanyState[] = [ready]
  const fetcher = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const request = new Request(args[0], args[1])
      const path = new URL(request.url).pathname
      if (path === "/local-auth/session") {
        return Response.json({ authenticated: true, kind: "basic" })
      }
      if (path === "/company/channels") {
        return Response.json(companyChannel)
      }
      if (path === "/company") {
        const data = responses.shift()
        if (!data) return Response.json({ name: "UnexpectedRequest" }, { status: 500 })
        return Response.json(data)
      }
      return Response.json({ name: "UnexpectedRequest" }, { status: 500 })
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
  // Wait for conversation store to initialize
  await new Promise((resolve) => setTimeout(resolve, 150))
  const snapshot = source.getSnapshot()
  expect(snapshot.status).toBe("ready")
  if (snapshot.status !== "ready") throw new Error("Expected ready snapshot")

  expect(snapshot.access.can_manage_credentials).toBe(true)
  expect(snapshot.company.name).toBe("Agent Company")
  // Should have conversation state
  expect(snapshot.conversation).toBeDefined()
  expect(snapshot.conversation.channels).toHaveLength(2)
  expect(snapshot.conversation.channels[0].kind).toBe("company")
  expect(snapshot.conversation.loadingChannels).toBe(false)
})

test("refreshing after bootstrap creates conversation store", async () => {
  const responses: CompanyState[] = [needsBootstrap, ready]
  let companyCallCount = 0
  const fetcher = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const request = new Request(args[0], args[1])
      const path = new URL(request.url).pathname
      if (path === "/local-auth/session") {
        return Response.json({ authenticated: true, kind: "basic" })
      }
      if (path === "/company/channels") {
        return Response.json(companyChannel)
      }
      if (path === "/company") {
        companyCallCount++
        const data = responses.shift()
        if (!data) return Response.json({ name: "UnexpectedRequest" }, { status: 500 })
        return Response.json(data)
      }
      return Response.json({ name: "UnexpectedRequest" }, { status: 500 })
    },
    { preconnect: fetch.preconnect },
  )
  const source = createSdkCompanyWorkspaceDataSource(
    createOpencodeClient({
      baseUrl: "http://company.test",
      fetch: fetcher,
    }),
  )

  // First refresh gets needs_bootstrap
  await source.refresh()
  let snapshot = source.getSnapshot()
  expect(snapshot.status).toBe("needs_bootstrap")

  // Second refresh gets ready
  await source.refresh()
  await new Promise((resolve) => setTimeout(resolve, 150))
  snapshot = source.getSnapshot()
  expect(snapshot.status).toBe("ready")
  if (snapshot.status !== "ready") throw new Error("Expected ready")
  // Conversation store should be available
  expect(source.conversation).toBeDefined()
  expect(snapshot.conversation.channels).toHaveLength(2)
})

test("error snapshot on failed company fetch", async () => {
  const fetcher = Object.assign(
    async () => {
      return Response.json({ name: "CompanyCorruptState", data: {} }, { status: 500 })
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
  const snapshot = source.getSnapshot()
  expect(snapshot.status).toBe("error")
  if (snapshot.status !== "error") throw new Error("Expected error")
  expect(snapshot.retryable).toBe(false)
})

test("disconnected source has no conversation store", () => {
  const { createDisconnectedCompanyWorkspaceDataSource } = require("./company-data-source")
  const source = createDisconnectedCompanyWorkspaceDataSource()
  expect(source.conversation).toBeUndefined()
  expect(source.getSnapshot().status).toBe("disconnected")
})
