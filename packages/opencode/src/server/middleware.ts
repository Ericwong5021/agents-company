import { Provider } from "../provider"
import { NamedError } from "@agents-company/shared/util/error"
import { NotFoundError } from "../storage"
import { Session } from "../session"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { Context, ErrorHandler, MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { Log } from "../util"
import { cors } from "hono/cors"
import { compress } from "hono/compress"
import { isPtyConnectPath, PTY_CONNECT_TICKET_QUERY } from "./pty-ticket"
import { createHash, timingSafeEqual } from "node:crypto"
import { AppRuntime } from "@/effect/app-runtime"
import { LocalAuth } from "@/local-auth"
import { LocalAuthUnauthorized, type LocalAuthSession } from "@/local-auth/schema"
import type { AuthMode } from "./auth"

const log = Log.create({ service: "server" })

export type ServerEnv = {
  Variables: {
    localAuth: LocalAuthSession
  }
}

export function errorMiddleware(auth: AuthMode): ErrorHandler {
  return (err, c) => {
  log.error("failed", {
    error: err,
  })
  if (err instanceof NamedError) {
    let status: ContentfulStatusCode
    if (err instanceof NotFoundError) status = 404
    else if (err instanceof Provider.ModelNotFoundError) status = 400
    else if (err.name === "ProviderAuthValidationFailed") status = 400
    else if (err.name === "CompanyAlreadyInitialized") status = 409
    else if (err.name === "LocalAuthUnauthorized") status = 401
    else if (err.name === "LocalAuthForbidden") status = 403
    else if (err.name === "LocalPairingInvalidOrExpired") status = 400
    else if (
      [
        "CompanyRepositoryNotGit",
        "CompanyProviderUnsupported",
        "CompanyProviderNotConnected",
        "CompanyModelNotAvailable",
      ].includes(err.name)
    )
      status = 400
    else if (err.name.startsWith("Worktree")) status = 400
    else if (err.name === "ConversationMessageInvalidInput" || err.name === "ConversationInvalidCursor") status = 400
    else if (
      [
        "ConversationChannelNotVisible",
        "ConversationThreadNotVisible",
        "ConversationChannelNotWritable",
        "ConversationThreadNotWritable",
        "ConversationReplyNotVisible",
        "ConversationMentionNotVisible",
      ].includes(err.name)
    )
      status = 403
    else if (err.name === "ConversationCompanyNotFound" || err.name === "ConversationSourceNotFound") status = 404
    else if (err.name === "ConversationRequestConflict") status = 409
    else status = 500
    return c.json(err.toObject(), { status })
  }
  if (err instanceof Session.BusyError) {
    return c.json(new NamedError.Unknown({ message: err.message }).toObject(), { status: 409 })
  }
  if (err instanceof HTTPException) return err.getResponse()
  const message = auth.mode === "network" ? "Internal server error" : err instanceof Error && err.stack ? err.stack : err.toString()
  return c.json(new NamedError.Unknown({ message }).toObject(), {
    status: 500,
  })
  }
}

export const ErrorMiddleware = errorMiddleware({ mode: "trusted" })

function credentialsMatch(expected: string, provided: string) {
  return timingSafeEqual(
    createHash("sha256").update(expected).digest(),
    createHash("sha256").update(provided).digest(),
  )
}

function unauthorized(c: Context<ServerEnv>) {
  c.header("WWW-Authenticate", 'Basic realm="agentcompany", Bearer')
  return c.json(new LocalAuthUnauthorized({}).toObject(), 401)
}

function authenticated(c: Context<ServerEnv>, session: LocalAuthSession) {
  c.set("localAuth", session)
}

export function AuthMiddleware(auth: AuthMode): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
  if (c.req.method === "OPTIONS") return next()

  if (auth.mode === "trusted") {
    authenticated(c, { authenticated: true, kind: "trusted" })
    return next()
  }

  // PTY websocket connect with a ticket skips basic auth; the handler validates the ticket.
  const path = new URL(c.req.url).pathname
  if (isPtyConnectPath(path) && c.req.query(PTY_CONNECT_TICKET_QUERY)) {
    authenticated(c, { authenticated: true, kind: "trusted" })
    return next()
  }

  const value = c.req.header("authorization")
  if (!value) return unauthorized(c)
  const separator = value.indexOf(" ")
  const scheme = separator === -1 ? value : value.slice(0, separator)
  const token = separator === -1 ? "" : value.slice(separator + 1).trim()

  if (scheme.toLowerCase() === "basic") {
    const supplied = Buffer.from(token, "base64").toString("utf8")
    if (!credentialsMatch(auth.basic.username + ":" + auth.basic.password, supplied)) return unauthorized(c)
    authenticated(c, { authenticated: true, kind: "basic" })
    return next()
  }

  if (scheme.toLowerCase() !== "bearer") return unauthorized(c)
  const session = await AppRuntime.runPromise(LocalAuth.Service.use((service) => service.verify(token)))
  if (!session) return unauthorized(c)
  authenticated(c, session)
  return next()
  }
}

export const LoggerMiddleware: MiddlewareHandler = async (c, next) => {
  const skip = c.req.path === "/log"
  if (!skip) {
    log.info("request", {
      method: c.req.method,
      path: c.req.path,
    })
  }
  const timer = log.time("request", {
    method: c.req.method,
    path: c.req.path,
  })
  await next()
  if (!skip) timer.stop()
}

export function CorsMiddleware(opts?: { cors?: string[] }): MiddlewareHandler {
  return cors({
    maxAge: 86_400,
    origin(input) {
      if (!input) return

      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(input)) return input
      if (opts?.cors?.includes(input)) return input
    },
  })
}

const zipped = compress()
export const CompressionMiddleware: MiddlewareHandler = (c, next) => {
  const path = c.req.path
  const method = c.req.method
  if (path === "/event" || path === "/global/event") return next()
  if (method === "POST" && /\/session\/[^/]+\/(message|prompt_async)$/.test(path)) return next()
  return zipped(c, next)
}
