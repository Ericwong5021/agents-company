import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { CompanyOperation } from "@/company-operation"
import { CompanyID } from "@/company/schema"
import { localAuthUnauthorizedResponse, productValidationHook } from "../error"

const CompanyOperationParam = z.object({ operationID: z.string().min(1) }).strict()
const CompanyOperationDetailQuery = z.object({ company_id: CompanyID }).strict()

export function CompanyOperationRoutes() {
  return new Hono()
    .get(
      "/",
      describeRoute({
        operationId: "company.operations.list",
        summary: "List the company's persisted operational history",
        parameters: [
          { in: "query", name: "company_id", required: true, schema: { type: "string", minLength: 4, pattern: "^cmp_" } },
          { in: "query", name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
          { in: "query", name: "cursor", required: false, schema: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" } },
          { in: "query", name: "category", required: false, schema: { type: "string", enum: CompanyOperation.Category.options } },
          { in: "query", name: "severity", required: false, schema: { type: "string", enum: CompanyOperation.Severity.options } },
          { in: "query", name: "importance", required: false, schema: { type: "string", enum: CompanyOperation.Importance.options } },
          { in: "query", name: "project_id", required: false, schema: { type: "string", minLength: 1 } },
          { in: "query", name: "agent_id", required: false, schema: { type: "string", minLength: 1 } },
          { in: "query", name: "from", required: false, schema: { type: "integer", minimum: 0 } },
          { in: "query", name: "to", required: false, schema: { type: "integer", minimum: 0 } },
        ],
        responses: {
          200: {
            description: "Company operations ordered by occurrence time",
            content: { "application/json": { schema: resolver(CompanyOperation.Page) } },
          },
          401: localAuthUnauthorizedResponse,
        },
      }),
      validator("query", CompanyOperation.Query, productValidationHook),
      (c) => c.json(CompanyOperation.list(c.req.valid("query"))),
    )
    .get(
      "/summary",
      describeRoute({
        operationId: "company.operations.summary",
        summary: "Get the company's operational summary for the last 24 hours",
        responses: {
          200: {
            description: "Company operation summary",
            content: { "application/json": { schema: resolver(CompanyOperation.Summary) } },
          },
          401: localAuthUnauthorizedResponse,
        },
      }),
      validator("query", CompanyOperation.SummaryQuery, productValidationHook),
      (c) => c.json(CompanyOperation.summary(c.req.valid("query"))),
    )
    .get(
      "/:operationID",
      describeRoute({
        operationId: "company.operations.get",
        summary: "Get a safe company operation detail projection",
        responses: {
          200: {
            description: "Safe company operation detail",
            content: { "application/json": { schema: resolver(CompanyOperation.Item) } },
          },
          401: localAuthUnauthorizedResponse,
          404: { description: "Company operation not found" },
        },
      }),
      validator("param", CompanyOperationParam, productValidationHook),
      validator("query", CompanyOperationDetailQuery, productValidationHook),
      (c) => {
        const item = CompanyOperation.get(c.req.valid("query").company_id, c.req.valid("param").operationID)
        return item ? c.json(item) : c.json({ message: "Company operation not found" }, 404)
      },
    )
}
