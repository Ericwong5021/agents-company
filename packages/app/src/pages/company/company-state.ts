import type { ApprovalPreset, RepositoryCandidate } from "@agents-company/sdk/v2/client"

export type CompanyBootstrapDraft = {
  request_id: string
  company_name: string
  provider_id?: string
  model_id?: string
  repository_path?: string
  repository?: RepositoryCandidate
  approval_preset: ApprovalPreset
  api_key?: string
  oauth_code?: string
}

export type CompanyDraftAction =
  | { type: "company.named"; company_name: string }
  | { type: "provider.selected"; provider_id: string; model_id: string }
  | { type: "repository.path"; repository_path: string }
  | { type: "repository.inspected"; repository: RepositoryCandidate }
  | { type: "policy.selected"; approval_preset: ApprovalPreset }

export function createDraft(request_id: string, company_name = "Agent Company"): CompanyBootstrapDraft {
  return { request_id, company_name, approval_preset: "balanced" }
}

export function reduceDraft(draft: CompanyBootstrapDraft, action: CompanyDraftAction): CompanyBootstrapDraft {
  if (action.type === "company.named") return { ...draft, company_name: action.company_name }
  if (action.type === "provider.selected") {
    return { ...draft, provider_id: action.provider_id, model_id: action.model_id }
  }
  if (action.type === "repository.path") {
    return { ...draft, repository_path: action.repository_path, repository: undefined }
  }
  if (action.type === "repository.inspected") {
    return { ...draft, repository_path: action.repository.root_path, repository: action.repository }
  }
  return { ...draft, approval_preset: action.approval_preset }
}

export function canSubmit(draft: CompanyBootstrapDraft) {
  return !!draft.provider_id && !!draft.model_id && !!draft.repository_path && !!draft.repository
}

export function serializeDraft(draft: CompanyBootstrapDraft) {
  return JSON.stringify({
    request_id: draft.request_id,
    company_name: draft.company_name,
    provider_id: draft.provider_id,
    model_id: draft.model_id,
    repository_path: draft.repository_path,
    approval_preset: draft.approval_preset,
  })
}

function isPreset(value: unknown): value is ApprovalPreset {
  return value === "autonomous" || value === "balanced" || value === "strict"
}

export function restoreDraft(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
    const draft = parsed as Record<string, unknown>
    if (typeof draft.request_id !== "string" || typeof draft.company_name !== "string") return
    if (draft.provider_id !== undefined && typeof draft.provider_id !== "string") return
    if (draft.model_id !== undefined && typeof draft.model_id !== "string") return
    if (draft.repository_path !== undefined && typeof draft.repository_path !== "string") return
    if (!isPreset(draft.approval_preset)) return
    return {
      request_id: draft.request_id,
      company_name: draft.company_name,
      provider_id: draft.provider_id,
      model_id: draft.model_id,
      repository_path: draft.repository_path,
      repository: undefined,
      approval_preset: draft.approval_preset,
    } satisfies CompanyBootstrapDraft
  } catch {
    return
  }
}

export function bootstrapDraftStorageKey(normalizedServerUrl: string) {
  return `agent-company.bootstrap-draft:${normalizedServerUrl}`
}
