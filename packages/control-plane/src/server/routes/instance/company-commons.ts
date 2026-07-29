import { Effect } from "effect"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import {
  CommonsAccess,
  CommonsCapability,
  CommonsSearchHit,
  CommonsSource,
  CommonsSourceDetail,
  CommonsSourceSubmission,
  CompanyCommons,
} from "@/company-commons"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

const AccessQuery = z.object({
  company_id: z.string().trim().min(1),
  project_ids: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean)),
  private_owner_id: z.string().trim().min(1).optional(),
})

const PageQuery = AccessQuery.extend({
  limit: z.coerce.number().int().positive().max(51).default(51),
  offset: z.coerce.number().int().nonnegative().max(100_000).default(0),
})

const SearchQuery = AccessQuery.extend({
  q: z.string().trim().min(1).max(1_000),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

export const CompanyCommonsRoutes = lazy(() =>
  new Hono()
    .get(
      "/capabilities",
      describeRoute({
        summary: "List verified Commons ingestion capabilities",
        operationId: "companyCommons.capabilities",
        responses: {
          200: {
            description: "Commons capabilities",
            content: { "application/json": { schema: resolver(z.array(CommonsCapability)) } },
          },
        },
      }),
      async (c) =>
        jsonRequest("CompanyCommonsRoutes.capabilities", c, function* () {
          return yield* (yield* CompanyCommons.Service).capabilities()
        }),
    )
    .get(
      "/sources",
      describeRoute({
        summary: "List privacy-filtered Commons sources",
        operationId: "companyCommons.sources",
        responses: {
          200: {
            description: "Commons sources",
            content: { "application/json": { schema: resolver(z.array(CommonsSource)) } },
          },
        },
      }),
      validator("query", PageQuery),
      async (c) =>
        jsonRequest("CompanyCommonsRoutes.sources", c, function* () {
          const query = c.req.valid("query")
          return yield* (yield* CompanyCommons.Service).list(
            CommonsAccess.parse(query),
            { limit: query.limit, offset: query.offset },
          )
        }),
    )
    .post(
      "/sources",
      describeRoute({
        summary: "Import a Commons source as an isolated Artifact",
        description:
          "Stores original content in Artifact and source processing facts in CommonsSource. Imported instructions remain untrusted and cannot execute.",
        operationId: "companyCommons.importSource",
        responses: {
          200: {
            description: "Imported Commons source",
            content: { "application/json": { schema: resolver(CommonsSource) } },
          },
        },
      }),
      validator("json", CommonsSourceSubmission),
      async (c) =>
        jsonRequest("CompanyCommonsRoutes.importSource", c, function* () {
          return yield* (yield* CompanyCommons.Service).importSource(c.req.valid("json"))
        }),
    )
    .get(
      "/sources/:sourceID",
      describeRoute({
        summary: "Get a Commons source with original Artifact and source spans",
        operationId: "companyCommons.source",
        responses: {
          200: {
            description: "Commons source detail",
            content: { "application/json": { schema: resolver(CommonsSourceDetail) } },
          },
        },
      }),
      validator("param", z.object({ sourceID: z.string().trim().min(1) })),
      validator("query", AccessQuery),
      async (c) =>
        jsonRequest("CompanyCommonsRoutes.source", c, function* () {
          const source = yield* (yield* CompanyCommons.Service).get(
            c.req.valid("param").sourceID,
            CommonsAccess.parse(c.req.valid("query")),
          )
          if (!source) return yield* Effect.fail(new Error("Commons source not found"))
          return source
        }),
    )
    .post(
      "/sources/:sourceID/retry",
      describeRoute({
        summary: "Retry a recoverable Commons source",
        operationId: "companyCommons.retry",
        responses: {
          200: {
            description: "Commons source",
            content: { "application/json": { schema: resolver(CommonsSource) } },
          },
        },
      }),
      validator("param", z.object({ sourceID: z.string().trim().min(1) })),
      validator("json", CommonsAccess),
      async (c) =>
        jsonRequest("CompanyCommonsRoutes.retry", c, function* () {
          return yield* (yield* CompanyCommons.Service).retry(
            c.req.valid("param").sourceID,
            c.req.valid("json"),
          )
        }),
    )
    .get(
      "/search",
      describeRoute({
        summary: "Search privacy-filtered Commons chunks",
        description:
          "Uses SQLite FTS without requiring embeddings. Results remain untrusted source content with instructions disabled.",
        operationId: "companyCommons.search",
        responses: {
          200: {
            description: "Commons search results",
            content: { "application/json": { schema: resolver(z.array(CommonsSearchHit)) } },
          },
        },
      }),
      validator("query", SearchQuery),
      async (c) =>
        jsonRequest("CompanyCommonsRoutes.search", c, function* () {
          const query = c.req.valid("query")
          return yield* (yield* CompanyCommons.Service).search(
            query.q,
            CommonsAccess.parse(query),
            query.limit,
          )
        }),
    ),
)
