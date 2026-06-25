import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Thread } from "@/thread/thread"
import { ThreadID, ThreadKind, ThreadStatus } from "@/thread/schema"
import z from "zod"
import { Effect } from "effect"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { runRequest } from "./trace"

const ThreadInfoSchema = Thread.Info

export const ThreadRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List threads",
        description: "Get a list of all active threads, optionally filtered by agent ID.",
        operationId: "thread.list",
        responses: {
          200: {
            description: "List of threads",
            content: { "application/json": { schema: resolver(ThreadInfoSchema.array()) } },
          },
        },
      }),
      validator("query", z.object({ agentID: z.string().optional() })),
      async (c) => {
        const { agentID } = c.req.valid("query")
        const result = await runRequest(
          "ThreadRoutes.list",
          c,
          Effect.gen(function* () {
            const svc = yield* Thread.Service
            if (agentID) return yield* svc.listByAgent(agentID)
            return yield* svc.listActive()
          }),
        )
        return c.json(result)
      },
    )
    .get(
      "/:id",
      describeRoute({
        summary: "Get thread",
        description: "Get a thread by ID.",
        operationId: "thread.get",
        responses: {
          200: {
            description: "Thread details",
            content: { "application/json": { schema: resolver(ThreadInfoSchema) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const id = c.req.valid("param").id
        const thread = await runRequest(
          "ThreadRoutes.get",
          c,
          Effect.gen(function* () {
            const svc = yield* Thread.Service
            return yield* svc.get(id as ThreadID)
          }),
        )
        if (!thread) return c.json({ error: "not found" }, 404)
        return c.json(thread)
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create thread",
        description: "Create a new thread for an agent.",
        operationId: "thread.create",
        responses: {
          200: {
            description: "Created thread",
            content: { "application/json": { schema: resolver(ThreadInfoSchema) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          agentID: z.string().min(1),
          kind: ThreadKind,
          sessionID: z.string().optional(),
          description: z.string().optional(),
          budgetTokens: z.number().optional(),
        }),
      ),
      async (c) => {
        const input = c.req.valid("json")
        const thread = await runRequest(
          "ThreadRoutes.create",
          c,
          Effect.gen(function* () {
            const svc = yield* Thread.Service
            return yield* svc.create(input)
          }),
        )
        return c.json(thread)
      },
    )
    .patch(
      "/:id",
      describeRoute({
        summary: "Update thread",
        description: "Update a thread's status, description, or token tracking.",
        operationId: "thread.update",
        responses: {
          200: {
            description: "Updated thread",
            content: { "application/json": { schema: resolver(ThreadInfoSchema) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator(
        "json",
        z.object({
          status: ThreadStatus.optional(),
          sessionID: z.string().optional(),
          description: z.string().optional(),
          spentTokens: z.number().optional(),
          budgetTokens: z.number().optional(),
        }),
      ),
      async (c) => {
        const id = c.req.valid("param").id
        const patch = c.req.valid("json")
        const thread = await runRequest(
          "ThreadRoutes.update",
          c,
          Effect.gen(function* () {
            const svc = yield* Thread.Service
            return yield* svc.update({ id: id as ThreadID, ...patch })
          }),
        )
        return c.json(thread)
      },
    )
    .post(
      "/:id/complete",
      describeRoute({
        summary: "Complete thread",
        description: "Mark a thread as completed.",
        operationId: "thread.complete",
        responses: {
          200: {
            description: "Completed thread",
            content: { "application/json": { schema: resolver(ThreadInfoSchema) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const id = c.req.valid("param").id
        const thread = await runRequest(
          "ThreadRoutes.complete",
          c,
          Effect.gen(function* () {
            const svc = yield* Thread.Service
            return yield* svc.complete(id as ThreadID)
          }),
        )
        return c.json(thread)
      },
    )
    .get(
      "/agent/:agentID/status",
      describeRoute({
        summary: "Get agent status",
        description: "Get the aggregated status of an agent based on its active threads.",
        operationId: "thread.agentStatus",
        responses: {
          200: {
            description: "Agent status",
            content: {
              "application/json": { schema: resolver(z.object({ status: z.enum(["idle", "busy", "focused"]) })) },
            },
          },
        },
      }),
      validator("param", z.object({ agentID: z.string() })),
      async (c) => {
        const agentID = c.req.valid("param").agentID
        const status = await runRequest(
          "ThreadRoutes.agentStatus",
          c,
          Effect.gen(function* () {
            const svc = yield* Thread.Service
            return yield* svc.agentStatus(agentID)
          }),
        )
        return c.json({ status })
      },
    )
)
