import { NamedError } from "@agents-company/shared/util/error"
import { ModelID, ProviderID } from "@/provider/schema"
import z from "zod"

export const CompanyID = z.string().startsWith("cmp_").brand<"CompanyID">().meta({ ref: "CompanyID" })
export type CompanyID = z.infer<typeof CompanyID>

export const ApprovalPreset = z.enum(["autonomous", "balanced", "strict"]).meta({ ref: "ApprovalPreset" })
export type ApprovalPreset = z.infer<typeof ApprovalPreset>

export const AgentLifecycle = z.enum(["candidate", "assigned", "employee", "archived"])
export type AgentLifecycle = z.infer<typeof AgentLifecycle>

export const BoardRole = z.enum(["ceo", "cto", "product_lead"])
export type BoardRole = z.infer<typeof BoardRole>

export const BoardMember = z
  .object({
    id: z.string(),
    role: BoardRole,
    name: z.string(),
    lifecycle: z.literal("employee"),
    responsibilities: z.array(z.string()),
  })
  .strict()
  .meta({ ref: "BoardMember" })
export type BoardMember = z.infer<typeof BoardMember>

export const BootstrapInput = z
  .object({
    request_id: z.string().uuid(),
    company_name: z.string().trim().min(1).max(80),
    provider_id: ProviderID.zod,
    model_id: ModelID.zod,
    repository_path: z.string().min(1),
    approval_preset: ApprovalPreset.default("balanced"),
  })
  .strict()
  .meta({ ref: "BootstrapInput" })
export type BootstrapInput = z.infer<typeof BootstrapInput>

export const CompanyModelOption = z
  .object({
    model_id: ModelID.zod,
    name: z.string(),
    status: z.enum(["alpha", "beta", "deprecated", "active"]),
    context_window: z.number().int().positive(),
  })
  .strict()
  .meta({ ref: "CompanyModelOption" })
export type CompanyModelOption = z.infer<typeof CompanyModelOption>

export const CompanyProviderOption = z
  .object({
    provider_id: ProviderID.zod,
    name: z.string(),
    connected: z.boolean(),
    models: z.array(CompanyModelOption),
  })
  .strict()
  .meta({ ref: "CompanyProviderOption" })
export type CompanyProviderOption = z.infer<typeof CompanyProviderOption>

export const CompanyProviderList = z
  .object({
    providers: z.array(CompanyProviderOption),
    defaults: z.record(z.string(), ModelID.zod),
  })
  .strict()
  .meta({ ref: "CompanyProviderList" })
export type CompanyProviderList = z.infer<typeof CompanyProviderList>

export const ProviderConnection = z
  .object({
    provider_id: ProviderID.zod,
    connected: z.literal(true),
    models: z.array(ModelID.zod).min(1),
  })
  .strict()
  .meta({ ref: "ProviderConnection" })
export type ProviderConnection = z.infer<typeof ProviderConnection>

export const CustomProviderModelsInput = z
  .object({
    format: z.enum(["openai", "anthropic"]),
    base_url: z.string().url(),
    api_key: z.string().optional(),
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .meta({ ref: "CustomProviderModelsInput" })
export type CustomProviderModelsInput = z.infer<typeof CustomProviderModelsInput>

export const CustomProviderModels = z
  .array(z.object({ model_id: ModelID.zod, name: z.string() }).strict())
  .meta({ ref: "CustomProviderModels" })
export type CustomProviderModels = z.infer<typeof CustomProviderModels>

export const CustomProviderModelsFailed = NamedError.create(
  "CustomProviderModelsFailed",
  z.object({ message: z.string() }).strict(),
)

export const RepositoryCandidate = z
  .object({
    project_id: z.string(),
    root_path: z.string(),
    default_branch: z.string(),
    bootstrap_head_commit: z.string().nullable(),
    dirty: z.boolean(),
  })
  .strict()
  .meta({ ref: "RepositoryCandidate" })
export type RepositoryCandidate = z.infer<typeof RepositoryCandidate>

export const StartSuggestion = z
  .object({
    kind: z.literal("bootstrap_complete"),
    action: z.literal("open_board"),
  })
  .strict()
  .meta({ ref: "StartSuggestion" })
export type StartSuggestion = z.infer<typeof StartSuggestion>

export const CompanySetupGoal = z
  .object({
    body: z.string(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict()
  .meta({ ref: "CompanySetupGoal" })
export type CompanySetupGoal = z.infer<typeof CompanySetupGoal>

export const CompanySetupGoalInput = z
  .object({ body: z.string().trim().min(1).max(20_000) })
  .strict()
  .meta({ ref: "CompanySetupGoalInput" })
export type CompanySetupGoalInput = z.infer<typeof CompanySetupGoalInput>

export const CompanyReadyState = z
  .object({
    state: z.literal("ready"),
    data_directory: z.string(),
    company: z
      .object({
        id: CompanyID,
        name: z.string(),
        data_version: z.literal(1),
        provider: z
          .object({
            provider_id: ProviderID.zod,
            model_id: ModelID.zod,
          })
          .strict()
          .nullable(),
        setup_goal: CompanySetupGoal.nullable(),
        approval_policy: z.object({ preset: ApprovalPreset }).strict(),
        repository: RepositoryCandidate.nullable(),
        board: z.array(BoardMember).length(3),
        created_at: z.number().int(),
        updated_at: z.number().int(),
      })
      .strict(),
    start_suggestion: StartSuggestion,
    capabilities: z.object({ board_messages: z.boolean() }).strict(),
  })
  .strict()
  .meta({ ref: "CompanyReadyState" })
export type CompanyReadyState = z.infer<typeof CompanyReadyState>

export const CompanyState = CompanyReadyState.meta({ ref: "CompanyState" })
export type CompanyState = z.infer<typeof CompanyState>

export const CompanyAlreadyInitialized = NamedError.create("CompanyAlreadyInitialized", z.object({}).strict())
export const CompanyRepositoryNotGit = NamedError.create(
  "CompanyRepositoryNotGit",
  z.object({ path: z.string() }).strict(),
)
export const CompanyProviderUnsupported = NamedError.create(
  "CompanyProviderUnsupported",
  z.object({ provider_id: ProviderID.zod }).strict(),
)
export const CompanyProviderNotConnected = NamedError.create(
  "CompanyProviderNotConnected",
  z.object({ provider_id: ProviderID.zod }).strict(),
)
export const CompanyModelNotAvailable = NamedError.create(
  "CompanyModelNotAvailable",
  z.object({ provider_id: ProviderID.zod, model_id: ModelID.zod }).strict(),
)
export const CompanyCorruptState = NamedError.create("CompanyCorruptState", z.object({}).strict())

export const State = CompanyState
