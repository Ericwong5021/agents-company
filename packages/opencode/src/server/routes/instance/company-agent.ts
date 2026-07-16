import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { CompanyAgent } from "@/company-agent/company-agent"
import { CompanyAgentID } from "@/company-agent/schema"
import { TemplateService } from "@/company-agent/template"
import type { AgentTemplate, AgentTemplateDivision } from "@/company-agent/template"
import z from "zod"
import { Effect } from "effect"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest, runRequest } from "./trace"

// ---------------------------------------------------------------------------
// Zod schemas for OpenAPI docs
// ---------------------------------------------------------------------------

const TemplateDivisionSchema = z
  .object({
    slug: z.string(),
    label: z.string(),
    icon: z.string(),
    color: z.string(),
    count: z.number(),
  })
  .meta({ ref: "AgentTemplateDivision" })

const TemplateSchema = z
  .object({
    slug: z.string(),
    division: z.string(),
    name: z.string(),
    description: z.string(),
    color: z.string(),
    emoji: z.string(),
    vibe: z.string(),
    system_prompt: z.string(),
  })
  .meta({ ref: "AgentTemplate" })

export const CompanyAgentRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List company agents",
        description: "Get a list of all company agents in the system.",
        operationId: "companyAgent.list",
        responses: {
          200: {
            description: "List of company agents",
            content: {
              "application/json": {
                schema: resolver(CompanyAgent.PublicInfo.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("CompanyAgentRoutes.list", c, function* () {
          const svc = yield* CompanyAgent.Service
          return (yield* svc.list()).map(CompanyAgent.toPublicInfo)
        }),
    )
    .get(
      "/:id",
      describeRoute({
        summary: "Get company agent",
        description: "Get a company agent by ID.",
        operationId: "companyAgent.get",
        responses: {
          200: {
            description: "Company agent",
            content: {
              "application/json": {
                schema: resolver(CompanyAgent.PublicInfo),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: CompanyAgentID.zod })),
      async (c) => {
        const id = c.req.valid("param").id
        const agent = await runRequest(
          "CompanyAgentRoutes.get",
          c,
          Effect.gen(function* () {
            const svc = yield* CompanyAgent.Service
            return yield* svc.get(id)
          }),
        )
        if (!agent) return c.json({ error: "not found" }, 404)
        return c.json(CompanyAgent.toPublicInfo(agent))
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create company agent",
        description: "Create a new company agent.",
        operationId: "companyAgent.create",
        responses: {
          200: {
            description: "Created company agent",
            content: {
              "application/json": {
                schema: resolver(CompanyAgent.PublicInfo),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", CompanyAgent.CreateInput),
      async (c) =>
        jsonRequest("CompanyAgentRoutes.create", c, function* () {
          const svc = yield* CompanyAgent.Service
          return CompanyAgent.toPublicInfo(yield* svc.create(c.req.valid("json")))
        }),
    )
    .patch(
      "/:id",
      describeRoute({
        summary: "Update company agent",
        description: "Update properties of an existing company agent.",
        operationId: "companyAgent.update",
        responses: {
          200: {
            description: "Updated company agent",
            content: {
              "application/json": {
                schema: resolver(CompanyAgent.PublicInfo),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: CompanyAgentID.zod })),
      validator("json", CompanyAgent.UpdateInput.omit({ id: true })),
      async (c) =>
        jsonRequest("CompanyAgentRoutes.update", c, function* () {
          const svc = yield* CompanyAgent.Service
          return CompanyAgent.toPublicInfo(
            yield* svc.update({ ...c.req.valid("json"), id: c.req.valid("param").id }),
          )
        }),
    )
    .post(
      "/:id/promote",
      describeRoute({
        summary: "Promote a candidate agent",
        description: "Promote a candidate after its private identity and public profile have been prepared.",
        operationId: "companyAgent.promote",
        responses: {
          200: {
            description: "Promoted company agent",
            content: { "application/json": { schema: resolver(CompanyAgent.PublicInfo) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: CompanyAgentID.zod })),
      async (c) =>
        jsonRequest("CompanyAgentRoutes.promote", c, function* () {
          const svc = yield* CompanyAgent.Service
          return CompanyAgent.toPublicInfo(yield* svc.promote(c.req.valid("param").id))
        }),
    )
    .delete(
      "/:id",
      describeRoute({
        summary: "Delete company agent",
        description: "Delete a company agent. The default 'assistant' agent cannot be deleted.",
        operationId: "companyAgent.delete",
        responses: {
          200: {
            description: "Deleted",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: CompanyAgentID.zod })),
      async (c) =>
        jsonRequest("CompanyAgentRoutes.delete", c, function* () {
          const svc = yield* CompanyAgent.Service
          yield* svc.remove(c.req.valid("param").id)
          return true
        }),
    )
    // -----------------------------------------------------------------------
    // Template library — sourced from bundled agency-agents repo
    // -----------------------------------------------------------------------
    .get(
      "/templates",
      describeRoute({
        summary: "List template divisions",
        description: "Get all agent template divisions with agent counts.",
        operationId: "companyAgent.templates.divisions",
        responses: {
          200: {
            description: "List of divisions",
            content: { "application/json": { schema: resolver(TemplateDivisionSchema.array()) } },
          },
        },
      }),
      (c) => c.json(TemplateService.divisions()),
    )
    .get(
      "/templates/search",
      describeRoute({
        summary: "Search agent templates",
        description: "Full-text search across all agent templates by name, description, vibe, and division.",
        operationId: "companyAgent.templates.search",
        responses: {
          200: {
            description: "Matching agent templates",
            content: { "application/json": { schema: resolver(TemplateSchema.array()) } },
          },
        },
      }),
      validator(
        "query",
        z.object({
          q: z.string().default(""),
          division: z.string().optional(),
          limit: z.coerce.number().int().positive().max(200).default(50),
        }),
      ),
      (c) => {
        const { q, division, limit } = c.req.valid("query")
        return c.json(TemplateService.search(q, { division, limit }))
      },
    )
    .get(
      "/templates/:division",
      describeRoute({
        summary: "List agents in a division",
        description: "Get all agent templates within a specific division.",
        operationId: "companyAgent.templates.byDivision",
        responses: {
          200: {
            description: "Agent templates in division",
            content: { "application/json": { schema: resolver(TemplateSchema.array()) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ division: z.string() })),
      (c) => {
        const agents = TemplateService.byDivision(c.req.valid("param").division)
        if (!agents) return c.json({ error: "division not found" }, 404)
        return c.json(agents)
      },
    )
    .get(
      "/templates/:division/:slug",
      describeRoute({
        summary: "Get agent template",
        description: "Get a single agent template including its full system prompt.",
        operationId: "companyAgent.templates.get",
        responses: {
          200: {
            description: "Agent template",
            content: { "application/json": { schema: resolver(TemplateSchema) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ division: z.string(), slug: z.string() })),
      (c) => {
        const { division, slug } = c.req.valid("param")
        const agent = TemplateService.get(division, slug)
        if (!agent) return c.json({ error: "template not found" }, 404)
        return c.json(agent)
      },
    ),
)
