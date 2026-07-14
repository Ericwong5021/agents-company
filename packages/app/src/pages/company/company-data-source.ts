import { type CompanyState, createOpencodeClient, type LocalAuthSession } from "@agents-company/sdk/v2/client"
import type { CompanyWorkspaceAccess, CompanyWorkspaceSnapshot } from "./company-model"
import { createFixtureCompanyWorkspaceDataSource } from "./company-fixture"

export type CompanyClient = Pick<ReturnType<typeof createOpencodeClient>, "company" | "localAuth">

export type CompanyWorkspaceDataSource = {
  getSnapshot(): CompanyWorkspaceSnapshot
  subscribe(listener: (snapshot: CompanyWorkspaceSnapshot) => void): () => void
  refresh(): Promise<void>
  listProviders(): Promise<Awaited<ReturnType<CompanyClient["company"]["providers"]>>["data"]>
  listProviderAuth(): Promise<Awaited<ReturnType<CompanyClient["company"]["providerAuth"]>>["data"]>
  setProvider(
    input: Parameters<CompanyClient["company"]["providerSet"]>[0],
  ): Promise<Awaited<ReturnType<CompanyClient["company"]["providerSet"]>>["data"]>
  authorizeProvider(
    input: Parameters<CompanyClient["company"]["providerOauthAuthorize"]>[0],
  ): Promise<Awaited<ReturnType<CompanyClient["company"]["providerOauthAuthorize"]>>["data"]>
  completeProviderOAuth(
    input: Parameters<CompanyClient["company"]["providerOauthCallback"]>[0],
  ): Promise<Awaited<ReturnType<CompanyClient["company"]["providerOauthCallback"]>>["data"]>
  inspectRepository(
    input: Parameters<CompanyClient["company"]["repositoryInspect"]>[0],
  ): Promise<Awaited<ReturnType<CompanyClient["company"]["repositoryInspect"]>>["data"]>
  bootstrap(
    input: Parameters<CompanyClient["company"]["bootstrap"]>[0],
  ): Promise<Awaited<ReturnType<CompanyClient["company"]["bootstrap"]>>["data"]>
  createPairing(
    input: Parameters<CompanyClient["localAuth"]["pair"]>[0],
  ): Promise<Awaited<ReturnType<CompanyClient["localAuth"]["pair"]>>["data"]>
  listCredentials(): Promise<Awaited<ReturnType<CompanyClient["localAuth"]["credentials"]>>["data"]>
  revokeCredential(
    input: Parameters<CompanyClient["localAuth"]["revoke"]>[0],
  ): Promise<Awaited<ReturnType<CompanyClient["localAuth"]["revoke"]>>["data"]>
  sendMessage?(input: { channelID: string; body: string }): Promise<void>
  approveDelivery?(input: { deliveryID: string }): Promise<void>
}

type SdkResult<T, E = unknown> = { data?: T; error?: E; response: Response }

function unwrap<T, E>(result: SdkResult<T, E>) {
  if (result.error !== undefined) throw result.error
  if (result.data === undefined) throw new Error("Agent Company API returned no data")
  return result.data
}

function access(session: LocalAuthSession): CompanyWorkspaceAccess {
  return {
    kind: session.kind,
    can_manage_credentials: session.kind === "trusted" || session.kind === "basic",
  }
}

function toSnapshot(state: CompanyState, session: LocalAuthSession): CompanyWorkspaceSnapshot {
  if (state.state === "needs_bootstrap") return { status: "needs_bootstrap", access: access(session), ...state }
  return { status: "ready", access: access(session), ...state }
}

function errorSnapshot(error: unknown): CompanyWorkspaceSnapshot {
  if (error && typeof error === "object" && "name" in error && error.name === "CompanyCorruptState") {
    return {
      status: "error",
      title: "本地公司数据需要修复",
      description: "Control Plane 无法读取当前 Company 状态。请检查本地数据目录后重试。",
      retryable: false,
    }
  }

  return {
    status: "error",
    title: "无法读取 Company 状态",
    description: "请确认本地 Control Plane 正在运行，然后重试。",
    retryable: true,
  }
}

export const createDisconnectedCompanyWorkspaceDataSource = (): CompanyWorkspaceDataSource => {
  const current: CompanyWorkspaceSnapshot = {
    status: "disconnected",
    company: { name: "Agent Company", versionLabel: "本地运行数据未连接" },
    title: "尚未连接公司运行数据",
    description: "连接本地 Control Plane 后，这里会显示真实 Company 初始化状态。",
  }

  return {
    getSnapshot: () => current,
    subscribe: () => () => undefined,
    refresh: async () => undefined,
    listProviders: async () => undefined,
    listProviderAuth: async () => undefined,
    setProvider: async () => undefined,
    authorizeProvider: async () => undefined,
    completeProviderOAuth: async () => undefined,
    inspectRepository: async () => undefined,
    bootstrap: async () => undefined,
    createPairing: async () => undefined,
    listCredentials: async () => undefined,
    revokeCredential: async () => undefined,
  }
}

export function createSdkCompanyWorkspaceDataSource(client: CompanyClient): CompanyWorkspaceDataSource {
  let current: CompanyWorkspaceSnapshot = { status: "loading" }
  const listeners = new Set<(snapshot: CompanyWorkspaceSnapshot) => void>()
  const publish = (next: CompanyWorkspaceSnapshot) => {
    current = next
    listeners.forEach((listener) => listener(next))
  }

  const refresh = async () => {
    publish({ status: "loading" })
    try {
      const [company, session] = await Promise.all([client.company.current(), client.localAuth.session()])
      publish(toSnapshot(unwrap(company), unwrap(session)))
    } catch (error) {
      publish(errorSnapshot(error))
    }
  }

  const request = async <T, E>(operation: Promise<SdkResult<T, E>>) => unwrap(await operation)

  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    listProviders: () => request(client.company.providers()),
    listProviderAuth: () => request(client.company.providerAuth()),
    setProvider: (input) => request(client.company.providerSet(input)),
    authorizeProvider: (input) => request(client.company.providerOauthAuthorize(input)),
    completeProviderOAuth: (input) => request(client.company.providerOauthCallback(input)),
    inspectRepository: (input) => request(client.company.repositoryInspect(input)),
    async bootstrap(input) {
      const result = await request(client.company.bootstrap(input))
      await refresh()
      return result
    },
    createPairing: (input) => request(client.localAuth.pair(input)),
    listCredentials: () => request(client.localAuth.credentials()),
    revokeCredential: (input) => request(client.localAuth.revoke(input)),
  }
}

export function createCompanyWorkspaceDataSource(client: CompanyClient): CompanyWorkspaceDataSource {
  if (import.meta.env.VITE_AGENTCOMPANY_COMPANY_FIXTURE === "true") return createFixtureCompanyWorkspaceDataSource()
  return createSdkCompanyWorkspaceDataSource(client)
}
