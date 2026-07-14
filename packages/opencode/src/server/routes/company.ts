import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Effect } from "effect"
import z from "zod"
import { Auth } from "@/auth"
import { Company, CompanySetupInstance } from "@/company"
import {
  BootstrapInput,
  CompanyAlreadyInitialized,
  CompanyCorruptState,
  CustomProviderModels,
  CustomProviderModelsFailed,
  CustomProviderModelsInput,
  CompanyModelNotAvailable,
  CompanyProviderList,
  CompanyProviderNotConnected,
  CompanyProviderUnsupported,
  CompanyReadyState,
  CompanyRepositoryNotGit,
  CompanyState,
  ProviderConnection,
  RepositoryCandidate,
} from "@/company/schema"
import { Config } from "@/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Provider, ProviderAuth, ModelsDev } from "@/provider"
import { ProviderID } from "@/provider/schema"
import { lazy } from "@/util/lazy"
import {
  localAuthUnauthorizedResponse,
  namedErrorResponse,
  ProductValidationError,
  productValidationHook,
  UnknownErrorResponse,
} from "../error"
import { CompanyChannelRoutes, CompanyThreadRoutes } from "./company-conversation"

const unsupportedProviders = new Set(["opencode"])
const RepositoryInspectInput = z
  .object({ repository_path: z.string().min(1) })
  .strict()
  .meta({ ref: "RepositoryInspectInput" })

function isUnsupported(providerID: string) {
  return unsupportedProviders.has(providerID)
}

function ensureSupported(providerID: ProviderID) {
  if (!isUnsupported(providerID)) return
  throw new CompanyProviderUnsupported({ provider_id: providerID })
}

async function customProviderModels(input: CustomProviderModelsInput) {
  const base = new URL(input.base_url)
  const url = new URL("models", base.pathname.endsWith("/") ? base : new URL(`${base.pathname}/`, base))
  const headers = new Headers(input.headers)
  if (input.api_key && !headers.has("authorization")) headers.set("authorization", `Bearer ${input.api_key}`)
  if (input.format === "anthropic" && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
  if (!response) throw new CustomProviderModelsFailed({ message: "无法连接到提供商端点" })
  if (!response.ok) throw new CustomProviderModelsFailed({ message: `提供商返回 HTTP ${response.status}` })

  const body = await response.json().catch(() => undefined)
  const result = z
    .object({
      data: z.array(
        z
          .object({ id: z.string().min(1), name: z.string().optional(), display_name: z.string().optional() })
          .passthrough(),
      ),
    })
    .passthrough()
    .safeParse(body)
  if (!result.success) throw new CustomProviderModelsFailed({ message: "提供商返回的模型列表格式无效" })
  return CustomProviderModels.parse(
    result.data.data
      .map((model) => ({ model_id: model.id, name: model.display_name ?? model.name ?? model.id }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  )
}

function defaults(providers: Record<string, Provider.Info>) {
  return Object.fromEntries(
    Object.entries(providers).flatMap(([providerID, provider]) => {
      const model = Object.values(provider.models).sort((left, right) => left.id.localeCompare(right.id))[0]
      return model ? [[providerID, model.id]] : []
    }),
  )
}

async function listProviders() {
  return AppRuntime.runPromise(
    CompanySetupInstance.provide(
      Effect.gen(function* () {
        const config = yield* Config.Service
        const provider = yield* Provider.Service
        const current = yield* config.get()
        const enabled = current.enabled_providers ? new Set(current.enabled_providers) : undefined
        const disabled = new Set(current.disabled_providers ?? [])
        const available = Object.fromEntries(
          Object.entries(yield* Effect.promise(() => ModelsDev.get()))
            .filter(([providerID]) => (enabled ? enabled.has(providerID) : true) && !disabled.has(providerID))
            .map(([providerID, info]) => [providerID, Provider.fromModelsDevProvider(info)]),
        ) as Record<string, Provider.Info>
        const connected = yield* provider.list()
        const allProviders: Record<string, Provider.Info> = { ...available, ...connected }
        const providers = Object.fromEntries(
          Object.keys(allProviders).flatMap((providerID) => {
            if (isUnsupported(providerID)) return []
            const info = allProviders[providerID]
            if (!info) return []
            const models = Object.fromEntries(
              Object.values(info.models)
                .filter((model) => model.limit.context > 0)
                .map((model) => [model.id, model]),
            )
            if (Object.keys(models).length === 0) return []
            return [[providerID, { ...info, models }]]
          }),
        ) as Record<string, Provider.Info>
        const connectedProviders = new Set(Object.keys(connected))
        return CompanyProviderList.parse({
          providers: Object.values(providers).map((item) => ({
            provider_id: item.id,
            name: item.name,
            connected: connectedProviders.has(item.id),
            models: Object.values(item.models).map((model) => ({
              model_id: model.id,
              name: model.name,
              status: model.status,
              context_window: model.limit.context,
            })),
          })),
          defaults: defaults(providers),
        })
      }),
    ),
  )
}

async function providerConnection(providerID: ProviderID) {
  ensureSupported(providerID)
  return AppRuntime.runPromise(
    CompanySetupInstance.provide(
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const item = (yield* provider.list())[providerID]
        if (!item || Object.keys(item.models).length === 0)
          return yield* Effect.fail(new CompanyProviderNotConnected({ provider_id: providerID }))
        return ProviderConnection.parse({
          provider_id: providerID,
          connected: true,
          models: Object.keys(item.models),
        })
      }),
    ),
  )
}

async function providerMethods() {
  return AppRuntime.runPromise(
    CompanySetupInstance.provide(
      ProviderAuth.Service.use((service) =>
        service
          .methods()
          .pipe(
            Effect.map((methods) =>
              Object.fromEntries(Object.entries(methods).filter(([providerID]) => !isUnsupported(providerID))),
            ),
          ),
      ),
    ),
  )
}

const badRequest = namedErrorResponse("Invalid company bootstrap request", [
  ProductValidationError,
  CompanyRepositoryNotGit.Schema,
  CompanyProviderUnsupported.Schema,
  CompanyProviderNotConnected.Schema,
  CompanyModelNotAvailable.Schema,
  ProviderAuth.ValidationFailed.Schema,
  CustomProviderModelsFailed.Schema,
] as const)

const conflict = namedErrorResponse("Company bootstrap already initialized", [
  CompanyAlreadyInitialized.Schema,
] as const)
const internalError = namedErrorResponse("Unable to complete company operation", [
  CompanyCorruptState.Schema,
  UnknownErrorResponse,
] as const)

export const CompanyRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        operationId: "company.current",
        summary: "Get the local company bootstrap state",
        responses: {
          200: {
            description: "Current company state",
            content: { "application/json": { schema: resolver(CompanyState) } },
          },
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      async (c) => c.json(await AppRuntime.runPromise(Company.Service.use((service) => service.current()))),
    )
    .get(
      "/providers",
      describeRoute({
        operationId: "company.providers",
        summary: "List providers available for company bootstrap",
        responses: {
          200: {
            description: "Provider choices",
            content: { "application/json": { schema: resolver(CompanyProviderList) } },
          },
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      async (c) => c.json(await listProviders()),
    )
    .get(
      "/providers/auth",
      describeRoute({
        operationId: "company.providerAuth",
        summary: "List provider authentication methods",
        responses: {
          200: {
            description: "Provider authentication methods",
            content: { "application/json": { schema: resolver(ProviderAuth.Methods.zod) } },
          },
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      async (c) => c.json(await providerMethods()),
    )
    .post(
      "/providers/models",
      describeRoute({
        operationId: "company.providerModels",
        summary: "Fetch models from a custom provider endpoint",
        responses: {
          200: {
            description: "Discovered custom provider models",
            content: { "application/json": { schema: resolver(CustomProviderModels) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
        },
      }),
      validator("json", CustomProviderModelsInput, productValidationHook),
      async (c) => c.json(await customProviderModels(c.req.valid("json"))),
    )
    .put(
      "/providers/:providerID/credentials",
      describeRoute({
        operationId: "company.providerSet",
        summary: "Store a provider credential",
        responses: {
          200: {
            description: "Connected provider",
            content: { "application/json": { schema: resolver(ProviderConnection) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("param", z.object({ providerID: ProviderID.zod }).strict(), productValidationHook),
      validator("json", Auth.Info.zod, productValidationHook),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        ensureSupported(providerID)
        await AppRuntime.runPromise(Auth.Service.use((service) => service.set(providerID, c.req.valid("json"))))
        await AppRuntime.runPromise(CompanySetupInstance.dispose)
        return c.json(await providerConnection(providerID))
      },
    )
    .delete(
      "/providers/:providerID/credentials",
      describeRoute({
        operationId: "company.providerRemove",
        summary: "Remove a provider credential",
        responses: {
          200: {
            description: "Credential removed",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("param", z.object({ providerID: ProviderID.zod }).strict(), productValidationHook),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        ensureSupported(providerID)
        await AppRuntime.runPromise(Auth.Service.use((service) => service.remove(providerID)))
        await AppRuntime.runPromise(CompanySetupInstance.dispose)
        return c.json(true)
      },
    )
    .post(
      "/providers/:providerID/oauth/authorize",
      describeRoute({
        operationId: "company.providerOauthAuthorize",
        summary: "Begin provider OAuth authorization",
        responses: {
          200: {
            description: "OAuth authorization",
            content: { "application/json": { schema: resolver(ProviderAuth.Authorization.zod) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("param", z.object({ providerID: ProviderID.zod }).strict(), productValidationHook),
      validator("json", ProviderAuth.AuthorizeInput.zod, productValidationHook),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const input = c.req.valid("json")
        ensureSupported(providerID)
        const result = await AppRuntime.runPromise(
          CompanySetupInstance.provide(
            Effect.gen(function* () {
              const provider = yield* ProviderAuth.Service
              const method = (yield* provider.methods())[providerID]?.[input.method]
              if (!method || method.type !== "oauth")
                return yield* Effect.fail(
                  new ProviderAuth.ValidationFailed({ field: "method", message: "OAuth method is not available" }),
                )
              const authorization = yield* provider.authorize({ providerID, ...input })
              if (!authorization)
                return yield* Effect.fail(
                  new ProviderAuth.ValidationFailed({ field: "method", message: "OAuth method is not available" }),
                )
              return authorization
            }),
          ),
        )
        return c.json(result)
      },
    )
    .post(
      "/providers/:providerID/oauth/callback",
      describeRoute({
        operationId: "company.providerOauthCallback",
        summary: "Complete provider OAuth authorization",
        responses: {
          200: {
            description: "OAuth callback completed",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("param", z.object({ providerID: ProviderID.zod }).strict(), productValidationHook),
      validator("json", ProviderAuth.CallbackInput.zod, productValidationHook),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const input = c.req.valid("json")
        ensureSupported(providerID)
        await AppRuntime.runPromise(
          CompanySetupInstance.provide(
            Effect.gen(function* () {
              const provider = yield* ProviderAuth.Service
              const method = (yield* provider.methods())[providerID]?.[input.method]
              if (!method || method.type !== "oauth")
                return yield* Effect.fail(
                  new ProviderAuth.ValidationFailed({ field: "method", message: "OAuth method is not available" }),
                )
              yield* provider.callback({ providerID, ...input })
            }),
          ),
        )
        await AppRuntime.runPromise(CompanySetupInstance.dispose)
        return c.json(true)
      },
    )
    .post(
      "/repository/inspect",
      describeRoute({
        operationId: "company.repositoryInspect",
        summary: "Inspect a repository for company bootstrap",
        responses: {
          200: {
            description: "Repository candidate",
            content: { "application/json": { schema: resolver(RepositoryCandidate) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", RepositoryInspectInput, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            Company.Service.use((service) => service.inspectRepository(c.req.valid("json").repository_path)),
          ),
        ),
    )
    .post(
      "/bootstrap",
      describeRoute({
        operationId: "company.bootstrap",
        summary: "Atomically create the local company",
        responses: {
          200: {
            description: "Initialized company",
            content: { "application/json": { schema: resolver(CompanyReadyState) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          409: conflict,
          500: internalError,
        },
      }),
      validator("json", BootstrapInput, productValidationHook),
      async (c) =>
        c.json(await AppRuntime.runPromise(Company.Service.use((service) => service.bootstrap(c.req.valid("json"))))),
    )
    .route("/channels", CompanyChannelRoutes())
    .route("/threads", CompanyThreadRoutes()),
)
