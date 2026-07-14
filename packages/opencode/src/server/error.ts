import { resolver } from "hono-openapi"
import type { Hook } from "@hono/standard-validator"
import type { Env } from "hono"
import z from "zod"
import { NotFoundError } from "../storage"
import { LocalAuthForbidden, LocalAuthUnauthorized } from "@/local-auth/schema"

export const ProductValidationError = z
  .object({
    name: z.literal("ProductValidationError"),
    data: z
      .object({
        issues: z.array(
          z
            .object({
              path: z.array(z.string()),
              message: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict()
  .meta({ ref: "ProductValidationError" })

export const UnknownErrorResponse = z
  .object({
    name: z.literal("UnknownError"),
    data: z.object({ message: z.string() }).strict(),
  })
  .strict()
  .meta({ ref: "UnknownError" })

export const productValidationHook: Hook<unknown, Env, string> = (result, c) => {
  if (result.success) return
  return c.json(
    {
      name: "ProductValidationError",
      data: {
        issues: result.error.map((issue) => ({
          path:
            issue.path?.map((part) =>
              typeof part === "object" && part !== null && "key" in part ? String(part.key) : String(part),
            ) ?? [],
          message: issue.message,
        })),
      },
    },
    400,
  )
}

export function namedErrorResponse(description: string, schemas: readonly [z.ZodType, ...z.ZodType[]]) {
  return {
    description,
    content: {
      "application/json": {
        schema: resolver(z.union(schemas)),
      },
    },
  }
}

export const localAuthUnauthorizedResponse = namedErrorResponse("Authentication required", [LocalAuthUnauthorized.Schema] as const)
export const localAuthForbiddenResponse = namedErrorResponse("Basic authentication required", [LocalAuthForbidden.Schema] as const)

export const ERRORS = {
  400: {
    description: "Bad request",
    content: {
      "application/json": {
        schema: resolver(
          z
            .object({
              data: z.any(),
              errors: z.array(z.record(z.string(), z.any())),
              success: z.literal(false),
            })
            .meta({
              ref: "BadRequestError",
            }),
        ),
      },
    },
  },
  404: {
    description: "Not found",
    content: {
      "application/json": {
        schema: resolver(NotFoundError.Schema),
      },
    },
  },
  409: {
    description: "Conflict — session resource is busy",
    content: {
      "application/json": {
        schema: resolver(
          z
            .object({
              name: z.literal("UnknownError"),
              data: z.object({ message: z.string() }),
            })
            .meta({
              ref: "ConflictError",
            }),
        ),
      },
    },
  },
} as const

export function errors(...codes: number[]) {
  return Object.fromEntries(codes.map((code) => [code, ERRORS[code as keyof typeof ERRORS]]))
}
