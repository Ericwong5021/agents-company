import { generateSpecs } from "hono-openapi"
import { Hono } from "hono"
import { randomBytes } from "node:crypto"
import { Effect } from "effect"
import { adapter } from "#hono"
import { lazy } from "@/util/lazy"
import { Log } from "@/util"
import { Flag } from "@/flag/flag"
import { WorkspaceID } from "@/control-plane/schema"
import { MDNS } from "./mdns"
import {
  AuthMiddleware,
  CompressionMiddleware,
  CorsMiddleware,
  errorMiddleware,
  LoggerMiddleware,
  type ServerEnv,
} from "./middleware"
import { type AuthMode, type BasicCredentials } from "./auth"
import { FenceMiddleware } from "./fence"
import { initProjectors } from "./projectors"
import { InstanceRoutes } from "./routes/instance"
import { ControlPlaneRoutes } from "./routes/control"
import { UIRoutes } from "./routes/ui"
import { GlobalHealthRoutes, GlobalRoutes } from "./routes/global"
import { CompanyRoutes } from "./routes/company"
import { CompanyRecruitmentRoutes } from "./routes/company-recruitment"
import { LocalAuthPublicRoutes, LocalAuthRoutes } from "./routes/local-auth"
import { WorkspaceRouterMiddleware } from "./workspace"
import { InstanceMiddleware } from "./routes/instance/middleware"
import { WorkspaceRoutes } from "./routes/control/workspace"
import { ExperienceRoutes } from "./routes/instance/experience"
import { AgentRunSupervisor } from "@/agent-run/supervisor"
import { ConversationRuntime } from "@/conversation/runtime"
import { AppRuntime } from "@/effect/app-runtime"
import { CompanyOutcomeSignal, CompanyProjectRecovery } from "@/company-project"
import { CompanyCommons } from "@/company-commons"
import { CompanyReading } from "@/company-reading"
import { ProjectOrchestrator } from "@/project-orchestrator/project-orchestrator"
import { FounderOSAdvisor, FounderYellowDelegation } from "@/founder-os"
import { ProjectActionExecutor } from "@/project-orchestrator/project-action-executor"
import { DecisionLedger } from "@/founder-os"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

initProjectors()

const log = Log.create({ service: "server" })

export type Listener = {
  hostname: string
  port: number
  url: URL
  credentials?: BasicCredentials
  stop: (close?: boolean) => Promise<void>
}

export type CreateOptions = {
  cors?: string[]
  auth?: AuthMode
}

export type ListenOptions = {
  port: number
  hostname: string
  mdns?: boolean
  mdnsDomain?: string
  cors?: string[]
  noAuth?: boolean
  auth?: AuthMode | BasicCredentials
}

export { authorization } from "./auth"
export type { AuthMode, BasicCredentials } from "./auth"

export const Default = lazy(() => create({ auth: { mode: "trusted" } }))

export function create(opts: CreateOptions = {}) {
  const auth = opts.auth ?? { mode: "trusted" }
  const app = new Hono<ServerEnv>()
    .onError(errorMiddleware(auth))
    .use(CorsMiddleware(opts))
    .use(LoggerMiddleware)
    .use(CompressionMiddleware)
    .route("/global", GlobalHealthRoutes())
    .route("/local-auth", LocalAuthPublicRoutes())

  const runtime = adapter.create(app as never)
  const protectedApp = new Hono<ServerEnv>()
    .use(AuthMiddleware(auth))
    .route("/company/recruitment", CompanyRecruitmentRoutes())
    .route("/company", CompanyRoutes())
    .route("/experience", ExperienceRoutes())
    .route("/global", GlobalRoutes())
    .route("/local-auth", LocalAuthRoutes())

  if (Flag.AGENTCOMPANY_WORKSPACE_ID) {
    protectedApp
      .use(
        InstanceMiddleware(
          Flag.AGENTCOMPANY_WORKSPACE_ID ? WorkspaceID.make(Flag.AGENTCOMPANY_WORKSPACE_ID) : undefined,
        ),
      )
      .use(FenceMiddleware)
      .route("/", InstanceRoutes(runtime.upgradeWebSocket))
  } else {
    protectedApp
      .route("/", ControlPlaneRoutes())
      .route(
        "/",
        new Hono()
          .use(InstanceMiddleware())
          .route("/experimental/workspace", WorkspaceRoutes())
          .use(WorkspaceRouterMiddleware(runtime.upgradeWebSocket))
          .route("/", InstanceRoutes(runtime.upgradeWebSocket)),
      )
  }

  return { app: app.route("/", UIRoutes()).route("/", protectedApp), runtime }
}

export async function openapi() {
  // Build a fresh app with all routes registered directly so
  // hono-openapi can see describeRoute metadata (`.route()` wraps
  // handlers when the sub-app has a custom errorHandler, which
  // strips the metadata symbol).
  const { app } = create({ auth: { mode: "trusted" } })
  const result = await generateSpecs(app, {
    documentation: {
      info: {
        title: "Agent Company Local API",
        version: "1.0.0",
        description: "Local Control Plane API for Agent Company",
      },
      openapi: "3.1.1",
    },
  })
  return result
}

export let url: URL

function listenAuth(opts: ListenOptions): AuthMode {
  if (opts.noAuth) return { mode: "trusted" }
  if (opts.auth) {
    if ("mode" in opts.auth) return opts.auth
    return { mode: "network", basic: opts.auth }
  }
  if (Flag.AGENTCOMPANY_SERVER_PASSWORD) {
    return {
      mode: "network",
      basic: {
        username: Flag.AGENTCOMPANY_SERVER_USERNAME ?? "agentcompany",
        password: Flag.AGENTCOMPANY_SERVER_PASSWORD,
      },
    }
  }
  if (["127.0.0.1", "localhost", "::1"].includes(opts.hostname)) return { mode: "trusted" }
  return {
    mode: "network",
    basic: {
      username: Flag.AGENTCOMPANY_SERVER_USERNAME ?? "agentcompany",
      password: randomBytes(32).toString("base64url"),
    },
  }
}

export async function listen(opts: ListenOptions): Promise<Listener> {
  const auth = listenAuth(opts)
  const built = create({ cors: opts.cors, auth })
  await AppRuntime.runPromise(DecisionLedger.Service.use((ledger) => ledger.recover()))
  await AppRuntime.runPromise(ConversationRuntime.Service.use((runtime) => runtime.recover()).pipe(Effect.ignore))
  await AppRuntime.runPromise(AgentRunSupervisor.Service.use((supervisor) => supervisor.recover()).pipe(Effect.ignore))
  await AppRuntime.runPromise(CompanyProjectRecovery.Service.use((recovery) => recovery.recover()))
  await AppRuntime.runPromise(CompanyOutcomeSignal.Service.use((outcomes) => outcomes.recover()))
  await AppRuntime.runPromise(CompanyCommons.Service.use((commons) => commons.recover()))
  await AppRuntime.runPromise(CompanyReading.Service.use((reading) => reading.recover()))
  await AppRuntime.runPromise(ProjectActionExecutor.Service.use((executor) => executor.recover()))
  await AppRuntime.runPromise(ProjectOrchestrator.Service.use((orchestrator) => orchestrator.recover()))
  await AppRuntime.runPromise(FounderYellowDelegation.Service.use((yellow) => yellow.recover()))
  FounderOSAdvisor.recover()
  const server = await built.runtime.listen({ port: opts.port, hostname: opts.hostname })

  const next = new URL("http://localhost")
  next.hostname = opts.hostname
  next.port = String(server.port)
  url = next

  const mdns =
    opts.mdns &&
    server.port &&
    opts.hostname !== "127.0.0.1" &&
    opts.hostname !== "localhost" &&
    opts.hostname !== "::1"
  if (mdns) {
    MDNS.publish(server.port, opts.mdnsDomain)
  } else if (opts.mdns) {
    log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
  }

  let closing: Promise<void> | undefined
  return {
    hostname: opts.hostname,
    port: server.port,
    url: next,
    ...(auth.mode === "network" ? { credentials: auth.basic } : {}),
    stop(close?: boolean) {
      closing ??= (async () => {
        if (mdns) MDNS.unpublish()
        await server.stop(close)
      })()
      return closing
    },
  }
}

export * as Server from "./server"
