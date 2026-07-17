import { Effect, Layer, Redacted, Schema } from "effect"
import { HttpApiBuilder, HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Observability } from "@/effect"
import { Flag } from "@/flag/flag"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Instance } from "@/project/instance"
import { lazy } from "@/util/lazy"
import { Filesystem } from "@/util"
import { isInstanceDirectoryAllowed } from "@/server/directory-access"
import { ConfigApi, configHandlers } from "./config"
import { PermissionApi, permissionHandlers } from "./permission"
import { ProjectApi, projectHandlers } from "./project"
import { ProviderApi, providerHandlers } from "./provider"
import { QuestionApi, questionHandlers } from "./question"
import { memoMap } from "@/effect/memo-map"

const Query = Schema.Struct({
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
})

const Headers = Schema.Struct({
  authorization: Schema.optional(Schema.String),
  "x-agentcompany-directory": Schema.optional(Schema.String),
})

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

class Authorization extends HttpApiMiddleware.Service<Authorization>()("@control-plane/ExperimentalHttpApiAuthorization", {
  error: Unauthorized,
  security: {
    basic: HttpApiSecurity.basic,
  },
}) {}

const auth = Layer.succeed(
  Authorization,
  Authorization.of({
    basic: (effect, { credential }) =>
      Effect.gen(function* () {
        if (!Flag.AGENTCOMPANY_SERVER_PASSWORD) return yield* effect

        const user = Flag.AGENTCOMPANY_SERVER_USERNAME ?? "agentcompany"
        if (credential.username !== user) {
          return yield* new Unauthorized({ message: "Unauthorized" })
        }
        if (Redacted.value(credential.password) !== Flag.AGENTCOMPANY_SERVER_PASSWORD) {
          return yield* new Unauthorized({ message: "Unauthorized" })
        }
        return yield* effect
      }),
  }),
)

class DirectoryAccessDenied extends Schema.TaggedErrorClass<DirectoryAccessDenied>()(
  "DirectoryAccessDenied",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

const instance = HttpRouter.middleware()(
  Effect.gen(function* () {
    return (effect) =>
      Effect.gen(function* () {
        const query = yield* HttpServerRequest.schemaSearchParams(Query)
        const headers = yield* HttpServerRequest.schemaHeaders(Headers)
        const raw = query.directory || headers["x-agentcompany-directory"] || process.cwd()
        const workspace = query.workspace || undefined
        const directory = Filesystem.resolve(decode(raw))

        if (!Flag.AGENTCOMPANY_SERVER_PASSWORD) {
          if (!isInstanceDirectoryAllowed(directory)) {
            return yield* new DirectoryAccessDenied({
              message:
                "Access denied: directory must be within the server working directory or a bound company repository",
            })
          }
        }

        const ctx = yield* Effect.promise(() =>
          Instance.provide({
            directory,
            init: () => AppRuntime.runPromise(InstanceBootstrap),
            fn: () => Instance.current,
          }),
        )

        const next = workspace ? effect.pipe(Effect.provideService(WorkspaceRef, workspace)) : effect
        return yield* next.pipe(Effect.provideService(InstanceRef, ctx))
      })
  }),
).layer

const QuestionSecured = QuestionApi.middleware(Authorization)
const PermissionSecured = PermissionApi.middleware(Authorization)
const ProjectSecured = ProjectApi.middleware(Authorization)
const ProviderSecured = ProviderApi.middleware(Authorization)
const ConfigSecured = ConfigApi.middleware(Authorization)

export const routes = Layer.mergeAll(
  HttpApiBuilder.layer(ConfigSecured).pipe(Layer.provide(configHandlers)),
  HttpApiBuilder.layer(ProjectSecured).pipe(Layer.provide(projectHandlers)),
  HttpApiBuilder.layer(QuestionSecured).pipe(Layer.provide(questionHandlers)),
  HttpApiBuilder.layer(PermissionSecured).pipe(Layer.provide(permissionHandlers)),
  HttpApiBuilder.layer(ProviderSecured).pipe(Layer.provide(providerHandlers)),
).pipe(
  Layer.provide(auth),
  Layer.provide(instance),
  Layer.provide(HttpServer.layerServices),
  Layer.provideMerge(Observability.layer),
)

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    memoMap,
  }),
)

export * as ExperimentalHttpApiServer from "./server"
