import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { AppRuntime } from "@/effect/app-runtime"
import { LocalAuth } from "@/local-auth"
import {
  IssuedCredential,
  LocalAuthForbidden,
  LocalAuthSession,
  LocalCredential,
  LocalExchangeInput,
  LocalPairing,
  LocalPairingInput,
  LocalPairingInvalidOrExpired,
} from "@/local-auth/schema"
import { lazy } from "@/util/lazy"
import {
  localAuthForbiddenResponse,
  localAuthUnauthorizedResponse,
  namedErrorResponse,
  ProductValidationError,
  productValidationHook,
  UnknownErrorResponse,
} from "../error"
import type { ServerEnv } from "../middleware"

const invalidPairing = namedErrorResponse("Invalid pairing request", [
  ProductValidationError,
  LocalPairingInvalidOrExpired.Schema,
] as const)
const invalidCredential = namedErrorResponse("Invalid credential request", [ProductValidationError] as const)
const internalError = namedErrorResponse("Unable to complete local authentication operation", [UnknownErrorResponse] as const)

function requiresBasic(c: Context<ServerEnv>) {
  if (c.get("localAuth").kind === "basic") return
  return c.json(new LocalAuthForbidden({}).toObject(), 403)
}

export const LocalAuthPublicRoutes = lazy(() =>
  new Hono<ServerEnv>().post(
    "/exchange",
    describeRoute({
      operationId: "localAuth.exchange",
      summary: "Exchange a one-time browser pairing code for a bearer credential",
      responses: {
        200: {
          description: "Issued credential",
          content: { "application/json": { schema: resolver(IssuedCredential) } },
        },
        400: invalidPairing,
        500: internalError,
      },
    }),
    validator("json", LocalExchangeInput, productValidationHook),
    async (c) =>
      c.json(
        await AppRuntime.runPromise(LocalAuth.Service.use((service) => service.exchange(c.req.valid("json")))),
      ),
  ),
)

export const LocalAuthRoutes = lazy(() =>
  new Hono<ServerEnv>()
    .get(
      "/session",
      describeRoute({
        operationId: "localAuth.session",
        summary: "Get the current local authentication session",
        responses: {
          200: {
            description: "Authenticated session",
            content: { "application/json": { schema: resolver(LocalAuthSession) } },
          },
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      (c) => c.json(c.get("localAuth")),
    )
    .post(
      "/pairings",
      describeRoute({
        operationId: "localAuth.pair",
        summary: "Create a short-lived browser pairing code",
        responses: {
          200: {
            description: "Pairing code and URL",
            content: { "application/json": { schema: resolver(LocalPairing) } },
          },
          400: invalidCredential,
          401: localAuthUnauthorizedResponse,
          403: localAuthForbiddenResponse,
          500: internalError,
        },
      }),
      validator("json", LocalPairingInput, productValidationHook),
      async (c) => {
        const denied = requiresBasic(c)
        if (denied) return denied
        const pairing = await AppRuntime.runPromise(
          LocalAuth.Service.use((service) => service.createPairing(c.req.valid("json"))),
        )
        const url = new URL(c.req.url)
        url.pathname = "/"
        url.search = new URLSearchParams({ pair: pairing.code }).toString()
        url.hash = ""
        return c.json(LocalPairing.parse({ ...pairing, pairing_url: url.toString() }))
      },
    )
    .get(
      "/credentials",
      describeRoute({
        operationId: "localAuth.credentials",
        summary: "List browser credentials",
        responses: {
          200: {
            description: "Credential audit records",
            content: { "application/json": { schema: resolver(LocalCredential.array()) } },
          },
          401: localAuthUnauthorizedResponse,
          403: localAuthForbiddenResponse,
          500: internalError,
        },
      }),
      async (c) => {
        const denied = requiresBasic(c)
        if (denied) return denied
        return c.json(await AppRuntime.runPromise(LocalAuth.Service.use((service) => service.list())))
      },
    )
    .delete(
      "/credentials/:id",
      describeRoute({
        operationId: "localAuth.revoke",
        summary: "Revoke a browser credential",
        responses: {
          200: {
            description: "Credential revoked",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
          400: invalidCredential,
          401: localAuthUnauthorizedResponse,
          403: localAuthForbiddenResponse,
          500: internalError,
        },
      }),
      validator("param", z.object({ id: z.string().startsWith("lcr_") }).strict(), productValidationHook),
      async (c) => {
        const denied = requiresBasic(c)
        if (denied) return denied
        await AppRuntime.runPromise(LocalAuth.Service.use((service) => service.revoke(c.req.valid("param").id)))
        return c.json(true)
      },
    ),
)
