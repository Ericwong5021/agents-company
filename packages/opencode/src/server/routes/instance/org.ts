import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Org } from "@/org/org"
import z from "zod"
import { Effect } from "effect"
import { lazy } from "@/util/lazy"
import { runRequest } from "./trace"

const OrgInfoSchema = Org.Info

export const OrgRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get organization",
        description: "Get the current organization overview: structure and data counts.",
        operationId: "org.get",
        responses: {
          200: {
            description: "Organization overview",
            content: { "application/json": { schema: resolver(OrgInfoSchema) } },
          },
        },
      }),
      async (c) => {
        const result = await runRequest(
          "OrgRoutes.get",
          c,
          Effect.gen(function* () {
            const svc = yield* Org.Service
            return yield* svc.get()
          }),
        )
        return c.json(result)
      },
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update organization structure",
        description: "Update the organization structure (departments, roles, agent assignments).",
        operationId: "org.update",
        responses: {
          200: {
            description: "Updated organization overview",
            content: { "application/json": { schema: resolver(OrgInfoSchema) } },
          },
        },
      }),
      validator("json", z.object({ org: z.any() })),
      async (c) => {
        const input = c.req.valid("json")
        const result = await runRequest(
          "OrgRoutes.update",
          c,
          Effect.gen(function* () {
            const svc = yield* Org.Service
            return yield* svc.update({ org: input.org })
          }),
        )
        return c.json(result)
      },
    )
    .post(
      "/disband",
      describeRoute({
        summary: "Disband organization",
        description:
          "Permanently delete all company/org data: agents, threads, sessions, group sessions, tasks, inbox, workflow runs, and the workspace files. Login and app configuration are preserved. This is irreversible.",
        operationId: "org.disband",
        responses: {
          200: {
            description: "Organization disbanded",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
        },
      }),
      async (c) => {
        await runRequest(
          "OrgRoutes.disband",
          c,
          Effect.gen(function* () {
            const svc = yield* Org.Service
            return yield* svc.disband()
          }),
        )
        return c.json(true)
      },
    )
)
