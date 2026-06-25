import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Effect } from "effect"
import { GroupSession } from "@/group-session"
import { GroupSessionID } from "@/group-session/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest, runRequest } from "./trace"

export const GroupSessionRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List group sessions",
        description: "Get all group sessions for the current project.",
        operationId: "groupSession.list",
        responses: {
          200: {
            description: "List of group sessions",
            content: { "application/json": { schema: resolver(GroupSession.Info.array()) } },
          },
        },
      }),
      async (c) =>
        jsonRequest("GroupSessionRoutes.list", c, function* () {
          const svc = yield* GroupSession.Service
          return yield* svc.list()
        }),
    )
    .post(
      "/",
      describeRoute({
        summary: "Create group session",
        description: "Create a new group session. One member session is created per agentID.",
        operationId: "groupSession.create",
        responses: {
          200: {
            description: "Created group session",
            content: { "application/json": { schema: resolver(GroupSession.Info) } },
          },
          ...errors(400),
        },
      }),
      validator("json", GroupSession.CreateInput),
      async (c) =>
        jsonRequest("GroupSessionRoutes.create", c, function* () {
          const svc = yield* GroupSession.Service
          return yield* svc.create(c.req.valid("json"))
        }),
    )
    .get(
      "/:id",
      describeRoute({
        summary: "Get group session",
        description: "Get a group session by ID, including its member sessions.",
        operationId: "groupSession.get",
        responses: {
          200: {
            description: "Group session",
            content: { "application/json": { schema: resolver(GroupSession.Info) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: GroupSessionID.zod })),
      async (c) => {
        const id = c.req.valid("param").id
        try {
          return await jsonRequest("GroupSessionRoutes.get", c, function* () {
            const svc = yield* GroupSession.Service
            return yield* svc.get(id)
          })
        } catch {
          return c.json({ error: "not found" }, 404)
        }
      },
    )
    .delete(
      "/:id",
      describeRoute({
        summary: "Delete group session",
        description: "Delete a group session and all its member sessions.",
        operationId: "groupSession.delete",
        responses: {
          200: {
            description: "Deleted",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: GroupSessionID.zod })),
      async (c) =>
        jsonRequest("GroupSessionRoutes.delete", c, function* () {
          const svc = yield* GroupSession.Service
          yield* svc.remove(c.req.valid("param").id)
          return true
        }),
    )
    .get(
      "/:id/messages",
      describeRoute({
        summary: "Get group messages",
        description:
          "Get the group-level visible conversation history (user messages + agent visible responses).",
        operationId: "groupSession.messages",
        responses: {
          200: {
            description: "Group messages",
            content: { "application/json": { schema: resolver(GroupSession.GroupMessage.array()) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: GroupSessionID.zod })),
      async (c) =>
        jsonRequest("GroupSessionRoutes.messages", c, function* () {
          const svc = yield* GroupSession.Service
          return yield* svc.messages(c.req.valid("param").id)
        }),
    )
    .get(
      "/:id/status",
      describeRoute({
        summary: "Get group session busy status",
        description: "Returns whether the group session is busy (any member session is processing).",
        operationId: "groupSession.status",
        responses: {
          200: {
            description: "Status",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({ busy: z.boolean() }).meta({ ref: "GroupSessionStatus" }),
                ),
              },
            },
          },
        },
      }),
      validator("param", z.object({ id: GroupSessionID.zod })),
      async (c) =>
        jsonRequest("GroupSessionRoutes.status", c, function* () {
          const svc = yield* GroupSession.Service
          const busy = yield* svc.isBusy(c.req.valid("param").id)
          return { busy }
        }),
    )
    .post(
      "/:id/chat",
      describeRoute({
        summary: "Send message to group session",
        description:
          "Persist a user message and fan-out to all member sessions in the background. " +
          "Returns immediately with the roundNum (200) or 409 if busy. " +
          "Agent responses arrive via group_session.agent_started / agent_completed events.",
        operationId: "groupSession.chat",
        responses: {
          200: {
            description: "Message accepted — roundNum of the newly created round",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({ roundNum: z.number() }).meta({ ref: "GroupSessionChatResult" }),
                ),
              },
            },
          },
          ...errors(400, 409),
        },
      }),
      validator("param", z.object({ id: GroupSessionID.zod })),
      validator("json", z.object({ text: z.string().min(1) })),
      async (c) => {
        const id = c.req.valid("param").id
        const { text } = c.req.valid("json")
        try {
          return await jsonRequest("GroupSessionRoutes.chat", c, function* () {
            const svc = yield* GroupSession.Service
            yield* svc.chat({ groupSessionID: id, text })
            const msgs = yield* svc.messages(id)
            const lastUserMsg = [...msgs].reverse().find((m) => m.role === "user")
            return { roundNum: lastUserMsg?.roundNum ?? 0 }
          })
        } catch (err) {
          if (err instanceof GroupSession.BusyError) {
            return c.json({ error: "group session is busy" }, 409)
          }
          throw err
        }
      },
    )
    .post(
      "/:id/interrupt",
      describeRoute({
        summary: "Interrupt all agents",
        description: "Gracefully cancel all running member sessions in the group.",
        operationId: "groupSession.interrupt",
        responses: {
          200: {
            description: "Interrupted",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
        },
      }),
      validator("param", z.object({ id: GroupSessionID.zod })),
      async (c) =>
        jsonRequest("GroupSessionRoutes.interrupt", c, function* () {
          const svc = yield* GroupSession.Service
          yield* svc.interrupt(c.req.valid("param").id)
          return true
        }),
    ),
)
