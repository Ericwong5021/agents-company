import { expect, test } from "bun:test"
import { createControlPlaneClient, type CompanyState } from "@agents-company/sdk/v2/client"
import { createDisconnectedCompanyWorkspaceDataSource, createSdkCompanyWorkspaceDataSource, installCompanyRefreshTriggers } from "./company-data-source"

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

const ready: CompanyState = {
  state: "ready",
  data_directory: "/company/data",
  company: {
    id: "cmp_local",
    name: "Agent Company",
    data_version: 1,
    provider: null,
    setup_goal: null,
    approval_policy: { preset: "balanced" },
    repository: null,
    board: [
      { id: "board-ceo", role: "ceo", name: "CEO", lifecycle: "employee", responsibilities: ["公司目标与最终取舍"] },
      { id: "board-cto", role: "cto", name: "CTO", lifecycle: "employee", responsibilities: ["公司技术方向与工程质量"] },
      {
        id: "board-product-lead",
        role: "product_lead",
        name: "Product Lead",
        lifecycle: "employee",
        responsibilities: ["用户价值与验收"],
      },
    ],
    created_at: 1,
    updated_at: 1,
  },
  start_suggestion: { kind: "bootstrap_complete", action: "open_board" },
  capabilities: { board_messages: false },
}

function source(responses: CompanyState[] = [ready]) {
  const fetcher = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const path = new URL(new Request(args[0], args[1]).url).pathname
      if (path === "/local-auth/session") return Response.json({ authenticated: true, kind: "basic" })
      if (path === "/company/channels") return Response.json(companyChannel)
      if (path === "/company/agents") return Response.json([])
      if (path === "/company") {
        const data = responses.shift()
        if (!data) return Response.json({ name: "UnexpectedRequest" }, { status: 500 })
        return Response.json(data)
      }
      return Response.json({ name: "UnexpectedRequest" }, { status: 500 })
    },
    { preconnect: fetch.preconnect },
  )
  return createSdkCompanyWorkspaceDataSource(
    createControlPlaneClient({
      baseUrl: "http://company.test",
      fetch: fetcher,
    }),
  )
}

test("opens the ready workspace with an empty default company", async () => {
  const dataSource = source()
  await dataSource.refresh()
  await new Promise((resolve) => setTimeout(resolve, 150))

  const snapshot = dataSource.getSnapshot()
  expect(snapshot.status).toBe("ready")
  if (snapshot.status !== "ready") throw new Error("Expected ready snapshot")
  expect(snapshot.company.provider).toBeNull()
  expect(snapshot.company.repository).toBeNull()
  expect(snapshot.agents).toEqual([])
  expect(snapshot.conversation.channels).toHaveLength(2)
})

test("keeps the ready workspace mounted during a background refresh", async () => {
  const gate = Promise.withResolvers<void>()
  let companyCalls = 0
  const fetcher = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const path = new URL(new Request(args[0], args[1]).url).pathname
      if (path === "/local-auth/session") return Response.json({ authenticated: true, kind: "trusted" })
      if (path === "/company/channels") return Response.json(companyChannel)
      if (path === "/company/agents") return Response.json([])
      if (path === "/company") {
        companyCalls += 1
        if (companyCalls > 1) await gate.promise
        return Response.json(ready)
      }
      return Response.json({ name: "UnexpectedRequest" }, { status: 500 })
    },
    { preconnect: fetch.preconnect },
  )
  const dataSource = createSdkCompanyWorkspaceDataSource(
    createControlPlaneClient({ baseUrl: "http://company.test", fetch: fetcher }),
  )

  await dataSource.refresh()
  const published: string[] = []
  const unsubscribe = dataSource.subscribe((snapshot) => published.push(snapshot.status))
  const refresh = dataSource.refresh()
  await Promise.resolve()

  expect(dataSource.getSnapshot().status).toBe("ready")
  expect(published).not.toContain("loading")

  gate.resolve()
  await refresh
  unsubscribe()
  expect(dataSource.getSnapshot().status).toBe("ready")
})

test("error snapshot on failed company fetch", async () => {
  const fetcher = Object.assign(
    async () => Response.json({ name: "CompanyCorruptState", data: {} }, { status: 500 }),
    { preconnect: fetch.preconnect },
  )
  const dataSource = createSdkCompanyWorkspaceDataSource(
    createControlPlaneClient({ baseUrl: "http://company.test", fetch: fetcher }),
  )

  await dataSource.refresh()
  const snapshot = dataSource.getSnapshot()
  expect(snapshot.status).toBe("error")
  if (snapshot.status !== "error") throw new Error("Expected error")
  expect(snapshot.retryable).toBe(false)
})

test("disconnected source has no conversation store", () => {
  const dataSource = createDisconnectedCompanyWorkspaceDataSource()
  expect(dataSource.conversation).toBeUndefined()
  expect(dataSource.getSnapshot().status).toBe("disconnected")
})

test("server.connected re-reads company, auth session, and conversation snapshot", async () => {
  let companyCalls = 0
  let sessionCalls = 0
  const fetcher = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const path = new URL(new Request(args[0], args[1]).url).pathname
      if (path === "/company") {
        companyCalls += 1
        return Response.json(ready)
      }
      if (path === "/local-auth/session") {
        sessionCalls += 1
        return Response.json({ authenticated: true, kind: "basic" })
      }
      if (path === "/company/channels") return Response.json(companyChannel)
      if (path === "/company/agents") return Response.json([])
      return Response.json({ name: "UnexpectedRequest" }, { status: 500 })
    },
    { preconnect: fetch.preconnect },
  )
  const dataSource = createSdkCompanyWorkspaceDataSource(
    createControlPlaneClient({ baseUrl: "http://company.test", fetch: fetcher }),
  )

  await dataSource.refresh()
  dataSource.handleEvent?.({ type: "server.connected", properties: {} })
  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(companyCalls).toBe(2)
  expect(sessionCalls).toBe(2)
  expect(dataSource.getSnapshot().status).toBe("ready")
})

test("visible-page trigger performs a full refresh and unregisters cleanly", () => {
  const target = Object.assign(new EventTarget(), { visibilityState: "hidden" })
  let refreshes = 0
  const cleanup = installCompanyRefreshTriggers(
    { refresh: async () => void (refreshes += 1) },
    target,
  )

  target.dispatchEvent(new Event("visibilitychange"))
  expect(refreshes).toBe(0)
  target.visibilityState = "visible"
  target.dispatchEvent(new Event("visibilitychange"))
  expect(refreshes).toBe(1)
  cleanup()
  target.dispatchEvent(new Event("visibilitychange"))
  expect(refreshes).toBe(1)
})
