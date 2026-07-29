import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Cause, Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import z from "zod"
import {
  FounderOSModeState,
  FounderSnapshotCompileInput,
  FounderSnapshotSelectInput,
  FounderStudioProjection,
  FounderTwinSnapshot,
  GovernanceAsset,
  GovernanceAssetDraftInput,
  GovernanceAssetRevisionInput,
  GovernanceAssetScope,
} from "@agents-company/shared/founder-os"
import { Auth } from "@/auth"
import { Company, CompanyReset, CompanySetupInstance } from "@/company"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { CompanyProject } from "@/company-project"
import { CompanyRecruitment } from "@/company-recruitment"
import * as CompanyActivity from "@/company/activity"
import {
  ApprovalPolicyUpdateInput,
  BootstrapInput,
  CompanyAlreadyInitialized,
  CompanyCorruptState,
  CompanyID,
  CompanyProviderConfigureInput,
  type CompanyProviderConfigureInput as CompanyProviderConfigureInputType,
  CustomProviderModels,
  CustomProviderModelsFailed,
  CustomProviderModelsInput,
  CompanyModelNotAvailable,
  CompanyProviderList,
  CompanyProviderNotConnected,
  CompanyProviderUnsupported,
  CompanyReadyState,
  CompanyResetInput,
  CompanyRepositoryNotGit,
  CompanySetupGoalInput,
  CompanyState,
  FounderOSModeUpdateInput,
  ProviderConnection,
  RepositoryCandidate,
} from "@/company/schema"
import { Config } from "@/config"
import { AppRuntime } from "@/effect/app-runtime"
import { FounderOSAsset } from "@/founder-os"
import { FounderOSRoutes } from "@/founder-os/routes"
import { Provider, ProviderAuth, ModelsDev } from "@/provider"
import { ProviderID } from "@/provider/schema"
import { Database } from "@/storage"
import { lazy } from "@/util/lazy"
import {
  localAuthUnauthorizedResponse,
  namedErrorResponse,
  ProductValidationError,
  productValidationHook,
  UnknownErrorResponse,
} from "../error"
import { CompanyChannelRoutes, CompanyThreadRoutes } from "./company-conversation"

const unsupportedProviders = new Set(["control-plane"])
const RepositoryInspectInput = z
  .object({ repository_path: z.string().min(1) })
  .strict()
  .meta({ ref: "RepositoryInspectInput" })
const CompanyAgentsQuery = z.object({ company_id: CompanyID }).strict()
const FounderStudioQuery = z
  .object({
    company_id: CompanyID,
    scope_kind: z.enum(["company", "domain", "project", "brand"]).default("company"),
    scope_ref: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((query) => query.scope_kind === "company" ? query.scope_ref === undefined : query.scope_ref !== undefined)
const ReassignWorkItemInput = z
  .object({
    owner_agent_id: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(4_000),
  })
  .strict()
const ReassignWorkItemConflict = z
  .object({
    name: z.literal("CompanyProjectWorkItemReassignmentConflict"),
    data: z
      .object({
        project_id: z.string(),
        work_item_id: z.string(),
        reason: z.enum([
          "project_not_found",
          "project_not_blocked",
          "worker_not_rejected",
          "reviewer_not_blocked",
          "owner_unchanged",
          "owner_not_company_member",
          "owner_is_reviewer",
          "owner_not_selected",
        ]),
        message: z.string(),
      })
      .strict(),
  })
  .strict()

function isUnsupported(providerID: string) {
  return unsupportedProviders.has(providerID)
}

function ensureSupported(providerID: ProviderID) {
  if (!isUnsupported(providerID)) return
  throw new CompanyProviderUnsupported({ provider_id: providerID })
}

async function customProviderModels(input: CustomProviderModelsInput) {
  const url = new URL(`${input.base_url.replace(/\/+$/, "")}/models`)
  const headers = new Headers(input.headers)
  if (input.api_key && !headers.has("authorization")) headers.set("authorization", `Bearer ${input.api_key}`)
  if (input.format === "anthropic") {
    if (input.api_key && !headers.has("x-api-key")) headers.set("x-api-key", input.api_key)
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
  }

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

async function configureProvider(input: CompanyProviderConfigureInputType) {
  ensureSupported(input.provider_id)
  const models = await customProviderModels(input)
  if (!models.some((model) => model.model_id === input.model_id))
    throw new CompanyModelNotAvailable({ provider_id: input.provider_id, model_id: input.model_id })

  const baseURL = input.base_url.replace(/\/+$/, "")
  const selectedModel = `${input.provider_id}/${input.model_id}`
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const config = yield* Config.Service
      const current = yield* config.getGlobal()
      yield* config.updateGlobal({
        model: selectedModel,
        small_model: selectedModel,
        model_groups: {
          ...current.model_groups,
          ultra: selectedModel,
          standard: selectedModel,
          lite: selectedModel,
        },
        ...(current.enabled_providers
          ? { enabled_providers: [...new Set([...current.enabled_providers, input.provider_id])] }
          : {}),
        ...(current.disabled_providers
          ? { disabled_providers: current.disabled_providers.filter((providerID) => providerID !== input.provider_id) }
          : {}),
        provider: {
          [input.provider_id]: {
            name: input.provider_id,
            npm: input.format === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
            api: baseURL,
            options: {
              baseURL,
              ...(Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
            },
            models: Object.fromEntries(
              models.map((model) => [
                model.model_id,
                {
                  name: model.name,
                  tool_call: true,
                },
              ]),
            ),
          },
        },
      })
      const auth = yield* Auth.Service
      yield* auth.set(input.provider_id, { type: "api", key: input.api_key })
    }),
  )
  await AppRuntime.runPromise(CompanySetupInstance.dispose)
  return AppRuntime.runPromise(
    Company.Service.use((service) =>
      service.bindProvider({ provider_id: input.provider_id, model_id: input.model_id }),
    ),
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
const reassignmentConflict = namedErrorResponse("Work item cannot be reassigned", [
  ReassignWorkItemConflict,
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
      "/agents",
      describeRoute({
        operationId: "company.agents",
        summary: "List public employee facts with evidence-backed activity projections",
        responses: {
          200: {
            description: "Visible employees and their current public activity",
            content: { "application/json": { schema: resolver(z.array(CompanyActivity.AgentActivityProjection)) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("query", CompanyAgentsQuery, productValidationHook),
      async (c) => c.json(CompanyActivity.list(c.req.valid("query").company_id)),
    )
    .put(
      "/approval-policy",
      describeRoute({
        operationId: "company.approvalPolicyUpdate",
        summary: "Update the company default approval policy",
        responses: {
          200: {
            description: "Company state with the updated approval policy",
            content: { "application/json": { schema: resolver(CompanyReadyState) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", ApprovalPolicyUpdateInput, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            Company.Service.use((service) => service.updateApprovalPolicy(c.req.valid("json"))),
          ),
        ),
    )
    .get(
      "/founder-os-modes",
      describeRoute({
        operationId: "company.founderOSModes",
        summary: "Get Founder OS global maximum, company modes, and effective modes",
        responses: {
          200: {
            description: "Current Founder OS modes",
            content: { "application/json": { schema: resolver(FounderOSModeState) } },
          },
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      async (c) => c.json(await AppRuntime.runPromise(Company.Service.use((service) => service.founderOSModes()))),
    )
    .put(
      "/founder-os-modes",
      describeRoute({
        operationId: "company.founderOSModesUpdate",
        summary: "Persist Founder OS company modes",
        responses: {
          200: {
            description: "Updated Founder OS modes",
            content: { "application/json": { schema: resolver(FounderOSModeState) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", FounderOSModeUpdateInput, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            Company.Service.use((service) => service.updateFounderOSModes(c.req.valid("json"))),
          ),
        ),
    )
    .get(
      "/founder-studio",
      describeRoute({
        operationId: "company.founderStudio",
        summary: "Read Founder Studio assets and immutable snapshots",
        responses: {
          200: {
            description: "Founder Studio persisted projection",
            content: { "application/json": { schema: resolver(FounderStudioProjection) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("query", FounderStudioQuery, productValidationHook),
      (c) => {
        const query = c.req.valid("query")
        return c.json(
          FounderOSAsset.projection(
            query.company_id,
            GovernanceAssetScope.parse({
              kind: query.scope_kind,
              ...(query.scope_ref ? { ref: query.scope_ref } : {}),
            }),
          ),
        )
      },
    )
    .post(
      "/founder-studio/assets",
      describeRoute({
        operationId: "company.founderStudioAssetCreate",
        summary: "Create an AI or external Founder Studio draft",
        responses: {
          200: {
            description: "Persisted immutable Governance Asset draft",
            content: { "application/json": { schema: resolver(GovernanceAsset) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", GovernanceAssetDraftInput, productValidationHook),
      (c) => c.json(FounderOSAsset.createDraft(c.req.valid("json"))),
    )
    .post(
      "/founder-studio/assets/:assetID/versions",
      describeRoute({
        operationId: "company.founderStudioAssetRevise",
        summary: "Append a Governance Asset version under deterministic authority rules",
        responses: {
          200: {
            description: "Founder Studio projection after version append",
            content: { "application/json": { schema: resolver(FounderStudioProjection) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", GovernanceAssetRevisionInput, productValidationHook),
      (c) => c.json(FounderOSAsset.revise(c.req.param("assetID"), c.req.valid("json"))),
    )
    .post(
      "/founder-studio/snapshots",
      describeRoute({
        operationId: "company.founderStudioSnapshotCompile",
        summary: "Compile and persist a deterministic Founder Twin Snapshot",
        responses: {
          200: {
            description: "Immutable Founder Twin Snapshot without compiled prompt plaintext",
            content: { "application/json": { schema: resolver(FounderTwinSnapshot) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", FounderSnapshotCompileInput, productValidationHook),
      (c) => c.json(FounderOSAsset.compileSnapshot(c.req.valid("json"))),
    )
    .post(
      "/founder-studio/snapshot-selection",
      describeRoute({
        operationId: "company.founderStudioSnapshotSelect",
        summary: "Append a Founder Twin Snapshot selection or rollback",
        responses: {
          200: {
            description: "Founder Studio projection with selected immutable Snapshot",
            content: { "application/json": { schema: resolver(FounderStudioProjection) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", FounderSnapshotSelectInput, productValidationHook),
      (c) => c.json(FounderOSAsset.selectSnapshot(c.req.valid("json"))),
    )
    .put(
      "/setup-goal",
      describeRoute({
        operationId: "company.deferSetupGoal",
        summary: "Persist a board goal until a model provider is configured",
        responses: {
          200: {
            description: "Current company state with the deferred goal",
            content: { "application/json": { schema: resolver(CompanyReadyState) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", CompanySetupGoalInput, productValidationHook),
      async (c) =>
        c.json(await AppRuntime.runPromise(Company.Service.use((service) => service.deferSetupGoal(c.req.valid("json"))))),
    )
    .post(
      "/reset",
      describeRoute({
        operationId: "company.reset",
        summary: "Clear all local company data, optionally including provider configuration",
        responses: {
          200: {
            description: "Fresh local company state",
            content: { "application/json": { schema: resolver(CompanyReadyState) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", CompanyResetInput, productValidationHook),
      async (c) => {
        await AppRuntime.runPromise(CompanyReset.reset(c.req.valid("json")))
        return c.json(await AppRuntime.runPromise(Company.Service.use((service) => service.current())))
      },
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
    .put(
      "/provider",
      describeRoute({
        operationId: "company.providerConfigure",
        summary: "Configure a custom provider and bind it to the local company",
        responses: {
          200: {
            description: "Company state bound to the configured provider",
            content: { "application/json": { schema: resolver(CompanyReadyState) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", CompanyProviderConfigureInput, productValidationHook),
      async (c) => c.json(await configureProvider(c.req.valid("json"))),
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
    .post(
      "/projects/:projectID/work-items/:workItemID/reassign",
      describeRoute({
        operationId: "company.project.workItem.reassign",
        summary: "Reassign a rejected worker before explicitly retrying a blocked project",
        responses: {
          200: { description: "Reassigned work item" },
          400: badRequest,
          409: reassignmentConflict,
        },
      }),
      validator(
        "param",
        z.object({ projectID: z.string().min(1), workItemID: z.string().min(1) }).strict(),
        productValidationHook,
      ),
      validator("json", ReassignWorkItemInput, productValidationHook),
      async (c) => {
        const param = c.req.valid("param")
        const input = c.req.valid("json")
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const service = yield* CompanyProject.Service
            const recruitment = yield* CompanyRecruitment.Service
            const project = yield* service.get(param.projectID)
            if (!project)
              return {
                error: {
                  reason: "project_not_found" as const,
                  message: `Company project not found: ${param.projectID}`,
                },
              }
            if (project.status !== "blocked")
              return {
                error: {
                  reason: "project_not_blocked" as const,
                  message: `Company project ${project.id} is not blocked`,
                },
              }
            const items = yield* service.listWorkItems(project.id)
            const worker = items.find((item) => item.id === param.workItemID)
            if (
              !worker ||
              worker.kind !== "worker" ||
              worker.status !== "completed" ||
              worker.review_status !== "rejected"
            )
              return {
                error: {
                  reason: "worker_not_rejected" as const,
                  message: `Work item ${param.workItemID} is not a completed worker with a rejected review`,
                },
              }
            const reviewer = items.find((item) => item.kind === "reviewer" && item.parent_id === worker.id)
            if (!reviewer || !["blocked", "failed"].includes(reviewer.status))
              return {
                error: {
                  reason: "reviewer_not_blocked" as const,
                  message: `Worker ${worker.id} does not have a blocked or failed reviewer`,
                },
              }
            if (worker.owner_agent_id === input.owner_agent_id)
              return {
                error: {
                  reason: "owner_unchanged" as const,
                  message: `Work item ${worker.id} is already assigned to ${input.owner_agent_id}`,
                },
              }
            const agent = yield* Effect.sync(() =>
              Database.use((db) =>
                db.select().from(CompanyAgentTable).where(eq(CompanyAgentTable.id, input.owner_agent_id)).get(),
              ),
            )
            if (!project.company_id || agent?.company_id !== project.company_id)
              return {
                error: {
                  reason: "owner_not_company_member" as const,
                  message: `Agent ${input.owner_agent_id} does not belong to project company ${project.company_id ?? ""}`,
                },
              }
            if (reviewer.owner_agent_id === input.owner_agent_id)
              return {
                error: {
                  reason: "owner_is_reviewer" as const,
                  message: `Agent ${input.owner_agent_id} is the reviewer for work item ${worker.id}`,
                },
              }
            const reassigned = yield* recruitment
              .reassign({
                work_item_id: worker.id,
                owner_agent_id: input.owner_agent_id,
                reason: input.reason,
              })
              .pipe(Effect.exit)
            if (Exit.isFailure(reassigned)) {
              const error = Cause.squash(reassigned.cause)
              const message = error instanceof Error ? error.message : String(error)
              if (message.includes("is already assigned to"))
                return {
                  error: {
                    reason: "owner_unchanged" as const,
                    message,
                  },
                }
              if (
                message.includes("has no current assignment") ||
                message.includes("does not satisfy capability need") ||
                message.includes("was not selected for work item")
              )
                return {
                  error: {
                    reason: "owner_not_selected" as const,
                    message,
                  },
                }
              throw error
            }
            const workItem = (yield* service.listWorkItems(project.id)).find((item) => item.id === worker.id)
            if (!workItem) throw new Error(`Work item ${worker.id} was not found after reassignment`)
            return { work_item: workItem }
          }),
        )
        if ("error" in result)
          return c.json(
            {
              name: "CompanyProjectWorkItemReassignmentConflict" as const,
              data: {
                project_id: param.projectID,
                work_item_id: param.workItemID,
                ...result.error,
              },
            },
            409,
          )
        return c.json(result.work_item)
      },
    )
    .route("/founder-os", FounderOSRoutes())
    .route("/channels", CompanyChannelRoutes())
    .route("/threads", CompanyThreadRoutes()),
)
