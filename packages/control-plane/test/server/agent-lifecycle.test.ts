import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { CompanyAgent } from "../../src/company-agent/company-agent"
import { Thread } from "../../src/thread/thread"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("agent lifecycle routes", () => {
  // ---------------------------------------------------------------------------
  // POST /agents/:id/start
  // ---------------------------------------------------------------------------
  describe("POST /agents/:id/start", () => {
    test("starts an agent by creating a primary thread", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Create an agent first
          const agent = await Effect.runPromise(
            CompanyAgent.Service.use((svc) =>
              svc.create({
                id: "test-agent-1",
                name: "Test Agent 1",
                description: "A test agent",
              }),
            ).pipe(Effect.provide(CompanyAgent.defaultLayer)),
          )

          const app = Server.Default().app
          const res = await app.request(`/agents/${agent.id}/start`, { method: "POST" })

          expect(res.status).toBe(200)
          const body = await res.json()
          expect(body.agent.id).toBe("test-agent-1")
          expect(body.thread.agentID).toBe("test-agent-1")
          expect(body.thread.kind).toBe("primary")
          expect(body.thread.status).toBe("active")
        },
      })
    })

    test("returns 404 for non-existent agent", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.Default().app
          const res = await app.request("/agents/nonexistent-agent/start", { method: "POST" })

          expect(res.status).toBe(404)
          const body = await res.json()
          expect(body.error).toBe("agent not found")
        },
      })
    })

    test("returns 409 if agent already has active primary thread", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Create agent
          const agent = await Effect.runPromise(
            CompanyAgent.Service.use((svc) =>
              svc.create({
                id: "test-agent-conflict",
                name: "Test Agent Conflict",
              }),
            ).pipe(Effect.provide(CompanyAgent.defaultLayer)),
          )

          const app = Server.Default().app

          // Start agent first time — should succeed
          const res1 = await app.request(`/agents/${agent.id}/start`, { method: "POST" })
          expect(res1.status).toBe(200)

          // Start agent second time — should conflict
          const res2 = await app.request(`/agents/${agent.id}/start`, { method: "POST" })
          expect(res2.status).toBe(409)
          const body = await res2.json()
          expect(body.error).toBe("agent already has an active primary thread")
        },
      })
    })
  })

  // ---------------------------------------------------------------------------
  // POST /agents/:id/stop
  // ---------------------------------------------------------------------------
  describe("POST /agents/:id/stop", () => {
    test("stops an agent by completing all active threads", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Create agent
          const agent = await Effect.runPromise(
            CompanyAgent.Service.use((svc) =>
              svc.create({
                id: "test-agent-stop",
                name: "Test Agent Stop",
              }),
            ).pipe(Effect.provide(CompanyAgent.defaultLayer)),
          )

          const app = Server.Default().app

          // Start the agent (creates primary thread)
          const startRes = await app.request(`/agents/${agent.id}/start`, { method: "POST" })
          expect(startRes.status).toBe(200)

          // Stop the agent
          const stopRes = await app.request(`/agents/${agent.id}/stop`, { method: "POST" })
          expect(stopRes.status).toBe(200)
          const body = await stopRes.json()
          expect(body.completedCount).toBe(1)
          expect(body.threads).toHaveLength(1)
          expect(body.threads[0].status).toBe("completed")
        },
      })
    })

    test("returns completedCount 0 when agent has no active threads", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Create agent but don't start it
          await Effect.runPromise(
            CompanyAgent.Service.use((svc) =>
              svc.create({
                id: "test-agent-idle",
                name: "Test Agent Idle",
              }),
            ).pipe(Effect.provide(CompanyAgent.defaultLayer)),
          )

          const app = Server.Default().app
          const stopRes = await app.request("/agents/test-agent-idle/stop", { method: "POST" })
          expect(stopRes.status).toBe(200)
          const body = await stopRes.json()
          expect(body.completedCount).toBe(0)
          expect(body.threads).toHaveLength(0)
        },
      })
    })

    test("returns 404 for non-existent agent", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.Default().app
          const res = await app.request("/agents/nonexistent-agent/stop", { method: "POST" })

          expect(res.status).toBe(404)
          const body = await res.json()
          expect(body.error).toBe("agent not found")
        },
      })
    })
  })

  // ---------------------------------------------------------------------------
  // GET /agents/:id/status
  // ---------------------------------------------------------------------------
  describe("GET /agents/:id/status", () => {
    test("returns idle status for agent with no threads", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Create agent but don't start it
          await Effect.runPromise(
            CompanyAgent.Service.use((svc) =>
              svc.create({
                id: "test-agent-status-idle",
                name: "Test Agent Status Idle",
              }),
            ).pipe(Effect.provide(CompanyAgent.defaultLayer)),
          )

          const app = Server.Default().app
          const res = await app.request("/agents/test-agent-status-idle/status", { method: "GET" })
          expect(res.status).toBe(200)
          const body = await res.json()
          expect(body.agent.id).toBe("test-agent-status-idle")
          expect(body.status).toBe("idle")
          expect(body.activity.isBusy).toBe(false)
          expect(body.activity.activeThreads).toHaveLength(0)
        },
      })
    })

    test("returns busy status for agent with active thread", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Create and start agent
          const agent = await Effect.runPromise(
            CompanyAgent.Service.use((svc) =>
              svc.create({
                id: "test-agent-status-busy",
                name: "Test Agent Status Busy",
              }),
            ).pipe(Effect.provide(CompanyAgent.defaultLayer)),
          )

          const app = Server.Default().app

          // Start agent
          await app.request(`/agents/${agent.id}/start`, { method: "POST" })

          // Check status
          const res = await app.request(`/agents/${agent.id}/status`, { method: "GET" })
          expect(res.status).toBe(200)
          const body = await res.json()
          expect(body.status).toBe("busy")
          expect(body.activity.isBusy).toBe(true)
          expect(body.activity.primaryCount).toBe(1)
          expect(body.activity.activeThreads).toHaveLength(1)
        },
      })
    })

    test("returns 404 for non-existent agent", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.Default().app
          const res = await app.request("/agents/nonexistent/status", { method: "GET" })

          expect(res.status).toBe(404)
          const body = await res.json()
          expect(body.error).toBe("agent not found")
        },
      })
    })
  })

  // ---------------------------------------------------------------------------
  // GET /agents/status
  // ---------------------------------------------------------------------------
  describe("GET /agents/status", () => {
    test("returns agents array with status information", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.Default().app
          const res = await app.request("/agents/status", { method: "GET" })
          expect(res.status).toBe(200)
          const body = await res.json()
          // The in-memory DB is shared; at minimum the default assistant agent exists.
          // Verify structure of returned items.
          expect(Array.isArray(body.agents)).toBe(true)
          if (body.agents.length > 0) {
            const first = body.agents[0]
            expect(first).toHaveProperty("agent")
            expect(first).toHaveProperty("activity")
            expect(first).toHaveProperty("status")
            expect(["idle", "busy", "paused"]).toContain(first.status)
          }
        },
      })
    })

    test("returns status for a specific agent in the list", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Create agent with unique name
          const agent = await Effect.runPromise(
            CompanyAgent.Service.use((svc) =>
              svc.create({
                id: "test-agent-multi-status",
                name: "Test Agent Multi Status",
              }),
            ).pipe(Effect.provide(CompanyAgent.defaultLayer)),
          )

          const app = Server.Default().app

          // Start agent
          await app.request(`/agents/${agent.id}/start`, { method: "POST" })

          // Get all statuses
          const res = await app.request("/agents/status", { method: "GET" })
          expect(res.status).toBe(200)
          const body = await res.json()
          expect(body.agents.length).toBeGreaterThanOrEqual(1)

          const found = body.agents.find((a: any) => a.agent.id === agent.id)
          expect(found).toBeDefined()
          expect(found.status).toBe("busy")
          expect(found.activity.primaryCount).toBe(1)
        },
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Full lifecycle: start -> check busy -> stop -> check idle
  // ---------------------------------------------------------------------------
  describe("full lifecycle", () => {
    test("start -> busy status -> stop -> idle status", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Create agent
          await Effect.runPromise(
            CompanyAgent.Service.use((svc) =>
              svc.create({
                id: "lifecycle-agent",
                name: "Lifecycle Agent",
              }),
            ).pipe(Effect.provide(CompanyAgent.defaultLayer)),
          )

          const app = Server.Default().app

          // 1. Start agent
          const startRes = await app.request("/agents/lifecycle-agent/start", { method: "POST" })
          expect(startRes.status).toBe(200)
          const startBody = await startRes.json()
          expect(startBody.thread.status).toBe("active")

          // 2. Verify busy status
          const busyRes = await app.request("/agents/lifecycle-agent/status", { method: "GET" })
          expect(busyRes.status).toBe(200)
          const busyBody = await busyRes.json()
          expect(busyBody.status).toBe("busy")
          expect(busyBody.activity.isBusy).toBe(true)

          // 3. Stop agent
          const stopRes = await app.request("/agents/lifecycle-agent/stop", { method: "POST" })
          expect(stopRes.status).toBe(200)
          const stopBody = await stopRes.json()
          expect(stopBody.completedCount).toBe(1)

          // 4. Verify idle status after stop
          const idleRes = await app.request("/agents/lifecycle-agent/status", { method: "GET" })
          expect(idleRes.status).toBe(200)
          const idleBody = await idleRes.json()
          expect(idleBody.status).toBe("idle")
          expect(idleBody.activity.isBusy).toBe(false)
          expect(idleBody.activity.activeThreads).toHaveLength(0)
        },
      })
    })
  })
})
