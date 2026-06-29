import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import z from "zod"
import { CompanyAgent } from "../../src/company-agent/company-agent"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const WorkstationBody = z.object({
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      org_layer: z.enum(["board", "department", "project", "execution", "tool"]),
      status: z.enum(["idle", "busy", "paused"]),
      threads: z.array(
        z.object({
          id: z.string(),
          kind: z.enum(["primary", "reactive", "ambient"]),
          status: z.enum(["active", "paused", "completed"]),
          task_summary: z.string().optional(),
          budget_tokens: z.number().optional(),
          spent_tokens: z.number(),
        }),
      ),
    }),
  ),
  summary: z.object({
    total_agents: z.number(),
    active_agents: z.number(),
    total_threads: z.number(),
    open_tasks: z.number(),
  }),
})

afterEach(async () => {
  await Instance.disposeAll()
})

describe("workstation routes", () => {
  test("projects configured org layer and active thread status", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.runPromise(
          CompanyAgent.Service.use((svc) =>
            svc.create({
              id: "department-lead",
              name: "Department Lead",
              org_layer: "department",
              department: "engineering",
              responsibilities: ["Translate strategy into project plans"],
            }),
          ).pipe(Effect.provide(CompanyAgent.defaultLayer)),
        )

        const app = Server.Default().app
        expect((await app.request("/agents/department-lead/start", { method: "POST" })).status).toBe(200)

        const res = await app.request("/workstation/status")
        expect(res.status).toBe(200)
        const body = WorkstationBody.parse(await res.json())
        const agent = body.agents.find((item) => item.id === "department-lead")

        expect(agent).toBeDefined()
        expect(agent?.org_layer).toBe("department")
        expect(agent?.status).toBe("busy")
        expect(agent?.threads).toHaveLength(1)
        expect(agent?.threads[0].kind).toBe("primary")
        expect(agent?.threads[0].status).toBe("active")
        expect(body.summary.active_agents).toBeGreaterThanOrEqual(1)
        expect(body.summary.total_threads).toBeGreaterThanOrEqual(1)
      },
    })
  })
})
