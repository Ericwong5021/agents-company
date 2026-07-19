import { type CompanyReadyState, createControlPlaneClient, type LocalAuthSession, type Event } from "@agents-company/sdk/v2/client"
import type {
  CompanyProjectExecutionState,
  CompanyProjectSummary,
  CompanyReadyWorkspaceSnapshot,
  CompanyWorkspaceAccess,
  CompanyWorkspaceSnapshot,
  ConversationSnapshot,
} from "./company-model"
import { createConversationStore, type ConversationStore } from "./company-conversation-data-source"

export type CompanyClient = Pick<ReturnType<typeof createControlPlaneClient>, "company" | "localAuth"> &
  Partial<Pick<ReturnType<typeof createControlPlaneClient>, "companyProject">>

export type CompanyWorkspaceDataSource = {
  getSnapshot(): CompanyWorkspaceSnapshot
  subscribe(listener: (snapshot: CompanyWorkspaceSnapshot) => void): () => void
  refresh(): Promise<void>
  listAgents(
    input: Parameters<CompanyClient["company"]["agents"]>[0],
  ): Promise<Awaited<ReturnType<CompanyClient["company"]["agents"]>>["data"]>
  listProviders(): Promise<Awaited<ReturnType<CompanyClient["company"]["providers"]>>["data"]>
  setProvider(
    input: Parameters<CompanyClient["company"]["providerSet"]>[0],
  ): Promise<Awaited<ReturnType<CompanyClient["company"]["providerSet"]>>["data"]>
  deferSetupGoal(
    input: Parameters<CompanyClient["company"]["deferSetupGoal"]>[0],
  ): Promise<Awaited<ReturnType<CompanyClient["company"]["deferSetupGoal"]>>["data"]>
  createPairing(
    input: Parameters<CompanyClient["localAuth"]["pair"]>[0],
  ): Promise<Awaited<ReturnType<CompanyClient["localAuth"]["pair"]>>["data"]>
  listCredentials(): Promise<Awaited<ReturnType<CompanyClient["localAuth"]["credentials"]>>["data"]>
  revokeCredential(
    input: Parameters<CompanyClient["localAuth"]["revoke"]>[0],
  ): Promise<Awaited<ReturnType<CompanyClient["localAuth"]["revoke"]>>["data"]>
  listCompanyProjects(): Promise<CompanyProjectSummary[]>
  startCompanyProject(input: {
    goal: string
    title?: string
    provider_id?: string
    model_id?: string
  }): Promise<CompanyProjectSummary>
  getCompanyProject(projectID: string): Promise<CompanyProjectExecutionState>
  cancelCompanyProject(input: { projectID: string; reason?: string }): Promise<void>
  retryCompanyProject(input: { projectID: string; provider_id?: string; model_id?: string }): Promise<CompanyProjectSummary>
  resolveCompanyProjectGate(input: {
    projectID: string
    gateID: string
    decision: "approve" | "reject"
    note?: string
  }): Promise<void>
  /** M2 conversation store, available when company is ready */
  conversation?: ConversationStore
  /** Forward an SSE event to the data source for M2 invalidation handling */
  handleEvent?(event: Event): void
}

type VisibilityTarget = {
  visibilityState: string
  addEventListener(type: "visibilitychange", listener: EventListener): void
  removeEventListener(type: "visibilitychange", listener: EventListener): void
}

export function installCompanyRefreshTriggers(
  source: Pick<CompanyWorkspaceDataSource, "refresh">,
  target: VisibilityTarget,
) {
  const refresh = () => {
    if (target.visibilityState !== "visible") return
    void source.refresh()
  }
  target.addEventListener("visibilitychange", refresh)
  return () => target.removeEventListener("visibilitychange", refresh)
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

/** Build a ready snapshot that includes the conversation state, if available. */
function toReadySnapshot(
  state: CompanyReadyState,
  session: LocalAuthSession,
  conversation?: ConversationSnapshot,
  agents: CompanyReadyWorkspaceSnapshot["agents"] = [],
): CompanyWorkspaceSnapshot {
  if (state.state !== "ready") throw new Error("Expected ready state")
  const base = { status: "ready" as const, access: access(session), ...state }
  if (conversation) {
    return { ...base, conversation, agents }
  }
  // Default empty conversation state when store is not yet initialized
  return {
    ...base,
    agents,
    conversation: {
      channels: [],
      activeChannelID: null,
      messages: [],
      messagesBefore: null,
      pendingMessages: [],
      thread: null,
      threadEntries: [],
      threadEntriesBefore: null,
      threadSources: {},
      loadingThreadSourceIDs: [],
      loadingChannels: true,
      loadingMessages: false,
      sending: false,
      error: null,
    } satisfies ConversationSnapshot,
  }
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
    listAgents: async () => undefined,
    listProviders: async () => undefined,
    setProvider: async () => undefined,
    deferSetupGoal: async () => undefined,
    createPairing: async () => undefined,
    listCredentials: async () => undefined,
    revokeCredential: async () => undefined,
    listCompanyProjects: async () => [],
    startCompanyProject: async () => {
      throw new Error("Company Project API is unavailable")
    },
    getCompanyProject: async () => {
      throw new Error("Company Project API is unavailable")
    },
    cancelCompanyProject: async () => undefined,
    retryCompanyProject: async () => {
      throw new Error("Company Project API is unavailable")
    },
    resolveCompanyProjectGate: async () => undefined,
    handleEvent: () => undefined,
  }
}

export function createSdkCompanyWorkspaceDataSource(client: CompanyClient): CompanyWorkspaceDataSource {
  let current: CompanyWorkspaceSnapshot = { status: "loading" }
  let refreshGeneration = 0
  const listeners = new Set<(snapshot: CompanyWorkspaceSnapshot) => void>()
  const publish = (next: CompanyWorkspaceSnapshot) => {
    current = next
    listeners.forEach((listener) => listener(next))
  }

  // ── Conversation store management ─────────────────────────────────────────
  let conversationStore: ConversationStore | undefined
  let unsubConversation: (() => void) | undefined

  function ensureConversationStore(companyID: string) {
    if (conversationStore) return conversationStore
    conversationStore = createConversationStore({ client: client as Pick<CompanyClient, "company">, companyID })
    // Subscribe to conversation store changes to update the ready snapshot
    unsubConversation = conversationStore.subscribe((cs) => {
      const currentSnapshot = current
      if (currentSnapshot.status === "ready") {
        publish({ ...currentSnapshot, conversation: cs })
      }
    })
    return conversationStore
  }

  function disposeConversationStore() {
    if (unsubConversation) {
      unsubConversation()
      unsubConversation = undefined
    }
    conversationStore = undefined
  }

  const refresh = async () => {
    const generation = ++refreshGeneration
    const previous = current
    const preserve = previous.status === "ready"
    if (!preserve) publish({ status: "loading" })
    try {
      const [company, session] = await Promise.all([client.company.current(), client.localAuth.session()])
      const companyState = unwrap(company) as CompanyReadyState
      const sessionState = unwrap(session)
      if (generation !== refreshGeneration) return

      if (companyState.state === "ready") {
        // Initialize or refresh conversation store
        const cs = ensureConversationStore(companyState.company.id)
        const [, agents] = await Promise.all([
          cs.refresh(),
          client.company.agents({ company_id: companyState.company.id }).then(unwrap),
        ])
        if (generation !== refreshGeneration) return
        publish(toReadySnapshot(companyState, sessionState, cs.getState(), agents))
      }
    } catch (error) {
      if (generation !== refreshGeneration) return
      if (preserve) {
        publish(previous)
        return
      }
      disposeConversationStore()
      publish(errorSnapshot(error))
    }
  }

  const request = async <T, E>(operation: Promise<SdkResult<T, E>>) => unwrap(await operation)
  const companyProject = () => {
    if (!client.companyProject) throw new Error("Company Project API is unavailable")
    return client.companyProject
  }

  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    listAgents: (input) => request(client.company.agents(input)),
    listProviders: () => request(client.company.providers()),
    setProvider: (input) => request(client.company.providerSet(input)),
    async deferSetupGoal(input) {
      const result = await request(client.company.deferSetupGoal(input))
      await refresh()
      return result
    },
    createPairing: (input) => request(client.localAuth.pair(input)),
    listCredentials: () => request(client.localAuth.credentials()),
    revokeCredential: (input) => request(client.localAuth.revoke(input)),
    async listCompanyProjects() {
      return (await request(companyProject().list())) as CompanyProjectSummary[]
    },
    async startCompanyProject(input) {
      const result = await request(companyProject().start(input))
      return result.project as CompanyProjectSummary
    },
    async getCompanyProject(projectID) {
      return (await request(companyProject().get({ projectID }))) as CompanyProjectExecutionState
    },
    async cancelCompanyProject(input) {
      await request(companyProject().cancel(input))
    },
    async retryCompanyProject(input) {
      const result = await request(companyProject().retry(input))
      return result.project as CompanyProjectSummary
    },
    async resolveCompanyProjectGate(input) {
      await request(companyProject().resolveGate(input))
    },
    get conversation() { return conversationStore },
    handleEvent(event: Event) {
      if (event.type === "server.connected") {
        void refresh()
        return
      }
      if (
        event.type === "company.channel.invalidated" ||
        event.type === "company.thread.invalidated" ||
        event.type === "company.conversation_run.updated"
      ) {
        conversationStore?.handleEvent(event)
      }
      if (event.type === "company.agent_activity.invalidated") void refresh()
    },
  }
}

export function createCompanyWorkspaceDataSource(client: CompanyClient): CompanyWorkspaceDataSource {
  return createSdkCompanyWorkspaceDataSource(client)
}
