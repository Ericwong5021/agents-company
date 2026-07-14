import type { CompanyNeedsBootstrapState, CompanyProviderList, ProviderAuthMethod } from "@agents-company/sdk/v2/client"
import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { normalizeServerUrl } from "@/context/server"
import type { CompanyWorkspaceDataSource } from "./company-data-source"
import type { CompanyWorkspaceAccess } from "./company-model"
import {
  bootstrapDraftStorageKey,
  canSubmit,
  createDraft,
  reduceDraft,
  restoreDraft,
  serializeDraft,
  type CompanyDraftAction,
} from "./company-state"

export type CompanyBootstrapSnapshot = CompanyNeedsBootstrapState & {
  status: "needs_bootstrap"
  access: CompanyWorkspaceAccess
}

const steps = ["provider", "company", "repository", "policy", "review"] as const

function newRequestID() {
  if (typeof crypto === "object" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function readDraft(key: string) {
  if (typeof localStorage !== "object") return
  try {
    const value = localStorage.getItem(key)
    return value ? restoreDraft(value) : undefined
  } catch {
    return
  }
}

function clearDraft(key: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.removeItem(key)
  } catch {
    return
  }
}

export function CompanyBootstrap(props: {
  snapshot: CompanyBootstrapSnapshot
  dataSource: CompanyWorkspaceDataSource
  serverUrl: string
  onComplete?: () => void
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const key = bootstrapDraftStorageKey(normalizeServerUrl(props.serverUrl) ?? props.serverUrl)
  const [draft, setDraft] = createSignal(readDraft(key) ?? createDraft(newRequestID(), props.snapshot.defaults.company_name))
  const [providers, setProviders] = createSignal<CompanyProviderList>()
  const [methods, setMethods] = createSignal<Record<string, ProviderAuthMethod[]>>({})
  const [step, setStep] = createSignal(0)
  const [apiKey, setApiKey] = createSignal("")
  const [oauthCode, setOauthCode] = createSignal("")
  const [oauthMethod, setOauthMethod] = createSignal<number>()
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const selectedProvider = createMemo(() => providers()?.providers.find((item) => item.provider_id === draft().provider_id))
  const selectedMethods = createMemo(() => methods()[draft().provider_id ?? ""] ?? [])
  const currentStep = () => steps[step()]

  createEffect(() => {
    const value = draft()
    try {
      localStorage.setItem(key, serializeDraft(value))
    } catch {}
  })

  const update = (action: CompanyDraftAction) => setDraft((current) => reduceDraft(current, action))

  const loadProviders = async () => {
    const [available, auth] = await Promise.all([props.dataSource.listProviders(), props.dataSource.listProviderAuth()])
    setProviders(available)
    setMethods(auth ?? {})
  }

  onMount(() => {
    void loadProviders().catch(() => setError(language.t("company.bootstrap.error.load")))
  })

  const chooseProvider = (providerID: string) => {
    const provider = providers()?.providers.find((item) => item.provider_id === providerID)
    const model = provider?.models.find((item) => item.status !== "deprecated") ?? provider?.models[0]
    if (!model) return
    update({ type: "provider.selected", provider_id: providerID, model_id: model.model_id })
  }

  const connectApi = async () => {
    const provider = selectedProvider()
    if (!provider || !apiKey().trim() || pending()) return
    setPending(true)
    setError()
    try {
      await props.dataSource.setProvider({
        providerID: provider.provider_id,
        auth: { type: "api", key: apiKey().trim() },
      })
      await loadProviders()
    } catch {
      setError(language.t("company.bootstrap.error.provider"))
    } finally {
      setApiKey("")
      setPending(false)
    }
  }

  const beginOAuth = async (index: number) => {
    const provider = selectedProvider()
    if (!provider || pending()) return
    setPending(true)
    setError()
    try {
      const authorization = await props.dataSource.authorizeProvider({ providerID: provider.provider_id, method: index })
      if (!authorization) throw new Error("Missing OAuth authorization")
      setOauthMethod(index)
      platform.openLink(authorization.url)
    } catch {
      setError(language.t("company.bootstrap.error.provider"))
    } finally {
      setPending(false)
    }
  }

  const completeOAuth = async () => {
    const provider = selectedProvider()
    const method = oauthMethod()
    if (!provider || method === undefined || !oauthCode().trim() || pending()) return
    setPending(true)
    setError()
    try {
      await props.dataSource.completeProviderOAuth({
        providerID: provider.provider_id,
        method,
        code: oauthCode().trim(),
      })
      setOauthMethod()
      await loadProviders()
    } catch {
      setError(language.t("company.bootstrap.error.provider"))
    } finally {
      setOauthCode("")
      setPending(false)
    }
  }

  const inspect = async () => {
    const path = draft().repository_path?.trim()
    if (!path || pending()) return
    setPending(true)
    setError()
    try {
      const repository = await props.dataSource.inspectRepository({ repositoryInspectInput: { repository_path: path } })
      if (!repository) throw new Error("Missing repository inspection")
      update({ type: "repository.inspected", repository })
    } catch {
      setError(language.t("company.bootstrap.error.repository"))
    } finally {
      setPending(false)
    }
  }

  const chooseDirectory = async () => {
    if (platform.platform !== "desktop" || !platform.openDirectoryPickerDialog) return
    const picked = await platform.openDirectoryPickerDialog({ title: language.t("company.bootstrap.repository.pick") })
    const path = Array.isArray(picked) ? picked[0] : picked
    if (path) update({ type: "repository.path", repository_path: path })
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!canSubmit(draft()) || pending()) return
    setPending(true)
    setError()
    try {
      const current = draft()
      await props.dataSource.bootstrap({
        bootstrapInput: {
          request_id: current.request_id,
          company_name: current.company_name.trim(),
          provider_id: current.provider_id!,
          model_id: current.model_id!,
          repository_path: current.repository_path!,
          approval_preset: current.approval_preset,
        },
      })
      clearDraft(key)
      props.onComplete?.()
    } catch (reason) {
      if (reason && typeof reason === "object" && "name" in reason && reason.name === "CompanyAlreadyInitialized") {
        await props.dataSource.refresh()
        setError(language.t("company.bootstrap.error.initialized"))
      } else {
        setError(language.t("company.bootstrap.error.submit"))
      }
    } finally {
      setPending(false)
    }
  }

  const canContinue = () => {
    if (currentStep() === "provider") return !!draft().provider_id && !!draft().model_id
    if (currentStep() === "company") return !!draft().company_name.trim()
    if (currentStep() === "repository") return !!draft().repository
    return true
  }

  return (
    <main class="company-bootstrap" data-company-state="needs-bootstrap">
      <header class="company-bootstrap-header">
        <div>
          <span class="company-bootstrap-eyebrow">Agent Company</span>
          <h1>{language.t("company.bootstrap.title")}</h1>
          <p>{language.t("company.bootstrap.subtitle")}</p>
        </div>
        <span class="company-bootstrap-progress">{language.t("company.bootstrap.progress", { current: step() + 1, total: steps.length })}</span>
      </header>

      <form class="company-bootstrap-form" onSubmit={submit}>
        <nav class="company-bootstrap-steps" aria-label={language.t("company.bootstrap.steps.label")}>
          <For each={steps}>
            {(item, index) => (
              <button type="button" classList={{ active: step() === index(), complete: step() > index() }} onClick={() => setStep(index())}>
                <span>{index() + 1}</span>
                {language.t(`company.bootstrap.step.${item}`)}
              </button>
            )}
          </For>
        </nav>

        <section class="company-bootstrap-panel">
          <Show when={currentStep() === "provider"}>
            <div class="company-bootstrap-field-grid">
              <label>
                <span>{language.t("company.bootstrap.provider.label")}</span>
                <select value={draft().provider_id ?? ""} onChange={(event) => chooseProvider(event.currentTarget.value)}>
                  <option value="">{language.t("company.bootstrap.provider.placeholder")}</option>
                  <For each={providers()?.providers ?? []}>{(provider) => <option value={provider.provider_id}>{provider.name}</option>}</For>
                </select>
              </label>
              <label>
                <span>{language.t("company.bootstrap.model.label")}</span>
                <select
                  value={draft().model_id ?? ""}
                  disabled={!selectedProvider()}
                  onChange={(event) => {
                    const provider = selectedProvider()
                    if (!provider) return
                    update({ type: "provider.selected", provider_id: provider.provider_id, model_id: event.currentTarget.value })
                  }}
                >
                  <option value="">{language.t("company.bootstrap.model.placeholder")}</option>
                  <For each={selectedProvider()?.models ?? []}>{(model) => <option value={model.model_id}>{model.name}</option>}</For>
                </select>
              </label>
            </div>
            <Show when={selectedProvider() && !selectedProvider()!.connected}>
              <div class="company-bootstrap-connection">
                <strong>{language.t("company.bootstrap.provider.connect")}</strong>
                <Show when={selectedMethods().some((method) => method.type === "api")}>
                  <div class="company-bootstrap-inline-form">
                    <input
                      type="password"
                      autocomplete="off"
                      value={apiKey()}
                      placeholder={language.t("company.bootstrap.provider.apiKey")}
                      onInput={(event) => setApiKey(event.currentTarget.value)}
                    />
                    <button type="button" onClick={() => void connectApi()} disabled={pending() || !apiKey().trim()}>
                      {language.t("company.bootstrap.provider.connectAction")}
                    </button>
                  </div>
                </Show>
                <For each={selectedMethods()}>
                  {(method, index) => (
                    <Show when={method.type === "oauth"}>
                      <button type="button" onClick={() => void beginOAuth(index())} disabled={pending()}>
                        {method.label}
                      </button>
                    </Show>
                  )}
                </For>
                <Show when={oauthMethod() !== undefined}>
                  <div class="company-bootstrap-inline-form">
                    <input
                      value={oauthCode()}
                      placeholder={language.t("company.bootstrap.provider.oauthCode")}
                      onInput={(event) => setOauthCode(event.currentTarget.value)}
                    />
                    <button type="button" onClick={() => void completeOAuth()} disabled={pending() || !oauthCode().trim()}>
                      {language.t("company.bootstrap.provider.confirmOAuth")}
                    </button>
                  </div>
                </Show>
              </div>
            </Show>
          </Show>

          <Show when={currentStep() === "company"}>
            <label class="company-bootstrap-field">
              <span>{language.t("company.bootstrap.company.name")}</span>
              <input value={draft().company_name} maxlength={80} onInput={(event) => update({ type: "company.named", company_name: event.currentTarget.value })} />
            </label>
            <div class="company-bootstrap-readonly">
              <span>{language.t("company.bootstrap.company.dataDirectory")}</span>
              <strong>{props.snapshot.data_directory}</strong>
            </div>
            <div class="company-bootstrap-board-preview">
              <For each={props.snapshot.defaults.board}>
                {(member) => (
                  <div>
                    <strong>{member.name}</strong>
                    <span>{member.role.replace("_", " ")}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={currentStep() === "repository"}>
            <label class="company-bootstrap-field">
              <span>{language.t("company.bootstrap.repository.path")}</span>
              <div class="company-bootstrap-inline-form">
                <input
                  value={draft().repository_path ?? ""}
                  placeholder={language.t("company.bootstrap.repository.placeholder")}
                  onInput={(event) => update({ type: "repository.path", repository_path: event.currentTarget.value })}
                />
                <Show when={platform.platform === "desktop" && platform.openDirectoryPickerDialog}>
                  <button type="button" onClick={() => void chooseDirectory()}>{language.t("company.bootstrap.repository.pick")}</button>
                </Show>
                <button type="button" onClick={() => void inspect()} disabled={pending() || !draft().repository_path?.trim()}>
                  {language.t("company.bootstrap.repository.inspect")}
                </button>
              </div>
            </label>
            <Show when={draft().repository}>
              {(repository) => (
                <div class="company-bootstrap-repository-result">
                  <strong>{repository().root_path}</strong>
                  <span>{repository().default_branch}</span>
                  <span>{repository().bootstrap_head_commit ?? "HEAD"}</span>
                  <span>{repository().dirty ? language.t("company.bootstrap.repository.dirty") : language.t("company.bootstrap.repository.clean")}</span>
                </div>
              )}
            </Show>
          </Show>

          <Show when={currentStep() === "policy"}>
            <fieldset class="company-bootstrap-policies">
              <legend>{language.t("company.bootstrap.policy.title")}</legend>
              <For each={["autonomous", "balanced", "strict"] as const}>
                {(preset) => (
                  <label classList={{ selected: draft().approval_preset === preset }}>
                    <input
                      type="radio"
                      name="approval-preset"
                      checked={draft().approval_preset === preset}
                      onChange={() => update({ type: "policy.selected", approval_preset: preset })}
                    />
                    <strong>{language.t(`company.bootstrap.policy.${preset}.title`)}</strong>
                    <span>{language.t(`company.bootstrap.policy.${preset}.body`)}</span>
                  </label>
                )}
              </For>
            </fieldset>
          </Show>

          <Show when={currentStep() === "review"}>
            <dl class="company-bootstrap-review">
              <div><dt>{language.t("company.bootstrap.review.company")}</dt><dd>{draft().company_name}</dd></div>
              <div><dt>{language.t("company.bootstrap.review.provider")}</dt><dd>{draft().provider_id} / {draft().model_id}</dd></div>
              <div><dt>{language.t("company.bootstrap.review.repository")}</dt><dd>{draft().repository_path}</dd></div>
              <div><dt>{language.t("company.bootstrap.review.policy")}</dt><dd>{draft().approval_preset}</dd></div>
            </dl>
          </Show>
        </section>

        <Show when={error()}>{(message) => <p class="company-bootstrap-error">{message()}</p>}</Show>
        <footer class="company-bootstrap-actions">
          <button type="button" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step() === 0 || pending()}>
            {language.t("company.bootstrap.back")}
          </button>
          <Show
            when={currentStep() === "review"}
            fallback={
              <button type="button" onClick={() => setStep((current) => Math.min(steps.length - 1, current + 1))} disabled={!canContinue() || pending()}>
                {language.t("company.bootstrap.next")}
              </button>
            }
          >
            <button type="submit" disabled={!canSubmit(draft()) || pending()}>
              {pending() ? language.t("company.bootstrap.creating") : language.t("company.bootstrap.create")}
            </button>
          </Show>
        </footer>
      </form>
    </main>
  )
}
