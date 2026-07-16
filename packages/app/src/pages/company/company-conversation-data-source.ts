import type { Event } from "@agents-company/sdk/v2/client"
import type {
  ChannelId,
  ChannelMessageId,
  ConversationThreadId,
  ChannelSendInput,
  ConversationMention,
} from "@agents-company/sdk/v2/client"
import type {
  ConversationChannelItem,
  ConversationMessageItem,
  ConversationPendingMessage,
  ConversationThreadDetail,
  ConversationThreadEntryItem,
  ConversationThreadSource,
  ConversationSnapshot,
  ConversationError,
} from "./company-model"
import type { CompanyClient } from "./company-data-source"

type Unsubscriber = () => void

function createRequestID(): string {
  return crypto.randomUUID()
}

export type MessageAccepted = {
  messageID: ChannelMessageId
  rootNeedID?: string
  threadID?: ConversationThreadId
  runID?: string
  replayed: boolean
}

export type ConversationStore = {
  getState(): ConversationSnapshot
  subscribe(listener: (state: ConversationSnapshot) => void): Unsubscriber
  refresh(): Promise<void>
  /** Switch active channel and load its first page of messages */
  setActiveChannel(channelID: ChannelId): Promise<void>
  /** Send a message to the active channel; returns immediately after 202 */
  sendMessage(
    body: string,
    opts?: { reply_to?: string; referenced_thread_id?: ConversationThreadId; mentions?: Array<ConversationMention> },
  ): Promise<MessageAccepted>
  /** Load older messages for the active channel (cursor-based before) */
  pageMessages(limit?: number): Promise<void>
  /** Open a thread and load its first page of entries */
  openThread(threadID: ConversationThreadId): Promise<void>
  /** Load older thread entries (cursor-based before) */
  pageThreadEntries(limit?: number): Promise<void>
  /** Resolve one exact projection source after an explicit user request */
  loadThreadSource(sourceID: string): Promise<ConversationThreadSource>
  /** Interrupt the current thread's run */
  interruptThread(): Promise<void>
  /** Handle an invalidation event from the SSE stream */
  handleEvent(event: Event): void
  /** Get the active channel's channelID */
  getActiveChannelID(): ChannelId | null
  /** Get the open thread's threadID */
  getOpenThreadID(): ConversationThreadId | null
}

/** Compute the "before" cursor from the oldest (last) item in a message list. */
function beforeCursorFromMessages(items: ConversationMessageItem[]): string | null {
  if (items.length === 0) return null
  return String(items[items.length - 1].time.created)
}

/** Compute the "before" cursor from the oldest (last) item in a thread entry list. */
function beforeCursorFromEntries(items: ConversationThreadEntryItem[]): string | null {
  if (items.length === 0) return null
  return String(items[items.length - 1].message.time.created)
}

export function createConversationStore(options: {
  client: Pick<CompanyClient, "company">
  companyID: string
}): ConversationStore {
  const { client, companyID } = options

  // ── Internal mutable state ────────────────────────────────────────────────
  let channels: ConversationChannelItem[] = []
  let activeChannelID: ChannelId | null = null
  let messages: ConversationMessageItem[] = []
  let messagesBefore: string | null = null
  let pendingMessages: ConversationPendingMessage[] = []
  let thread: ConversationThreadDetail | null = null
  let threadEntries: ConversationThreadEntryItem[] = []
  let threadEntriesBefore: string | null = null
  let threadSources: Record<string, ConversationThreadSource> = {}
  let loadingThreadSourceIDs: string[] = []
  let loadingChannels = false
  let loadingMessages = false
  let sending = false
  let error: ConversationError | null = null
  let channelsGeneration = 0
  let messagesGeneration = 0
  let threadGeneration = 0

  const listeners = new Set<(state: ConversationSnapshot) => void>()
  let invalidateTimer: ReturnType<typeof setTimeout> | undefined

  function snapshot(): ConversationSnapshot {
    return Object.freeze({
      channels,
      activeChannelID,
      messages,
      messagesBefore,
      pendingMessages: pendingMessages.filter((pending) => pending.channelID === activeChannelID),
      thread,
      threadEntries,
      threadEntriesBefore,
      threadSources,
      loadingThreadSourceIDs,
      loadingChannels,
      loadingMessages,
      sending,
      error,
    } satisfies ConversationSnapshot)
  }

  function publish() {
    if (!invalidateTimer) {
      invalidateTimer = setTimeout(() => {
        invalidateTimer = undefined
        const s = snapshot()
        listeners.forEach((fn) => fn(s))
      }, 0)
    }
  }

  function setError(title: string, description: string, retryable: boolean) {
    error = { title, description, retryable }
    publish()
  }

  function clearError() {
    if (error) {
      error = null
      publish()
    }
  }

  function replaceMessages(channelID: ChannelId, items: ConversationMessageItem[], nextCursor?: string) {
    messages = items
    messagesBefore = nextCursor ?? null
    const persistedIDs = new Set(items.map((message) => message.id))
    const persistedRequests = new Set(
      items.map((message) => message.requestID).filter((id): id is string => Boolean(id)),
    )
    pendingMessages = pendingMessages.filter(
      (pending) =>
        pending.channelID !== channelID ||
        ((!pending.messageID || !persistedIDs.has(pending.messageID)) && !persistedRequests.has(pending.requestID)),
    )
  }

  // ── Debounced invalidation ────────────────────────────────────────────────
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined

  function scheduleChannelRefresh() {
    invalidateFlags.channels = true
    scheduleRefresh()
  }

  function scheduleMessagesRefresh() {
    invalidateFlags.messages = true
    scheduleRefresh()
  }

  function scheduleThreadRefresh() {
    invalidateFlags.thread = true
    scheduleRefresh()
  }

  let invalidateFlags = { channels: false, messages: false, thread: false }

  function scheduleRefresh() {
    if (coalesceTimer) clearTimeout(coalesceTimer)
    coalesceTimer = setTimeout(async () => {
      coalesceTimer = undefined
      const flags = invalidateFlags
      invalidateFlags = { channels: false, messages: false, thread: false }

      try {
        if (flags.channels) {
          const generation = ++channelsGeneration
          loadingChannels = true
          publish()
          const result = await client.company.channels({ company_id: companyID })
          if (result.error) throw result.error
          if (generation === channelsGeneration) {
            channels = (result.data ?? []).map((raw) => raw as unknown as ConversationChannelItem)
            loadingChannels = false
          }
        }
        if (flags.messages && activeChannelID) {
          const channelID = activeChannelID
          const generation = ++messagesGeneration
          loadingMessages = true
          publish()
          const result = await client.company.channelMessages({
            channelID,
            company_id: companyID,
            limit: 50,
          })
          if (result.error) throw result.error
          const page = result.data
          if (page && generation === messagesGeneration && activeChannelID === channelID) {
            replaceMessages(
              channelID,
              page.items.map((raw) => raw as unknown as ConversationMessageItem),
              page.nextCursor,
            )
            loadingMessages = false
          }
        }
        if (flags.thread && thread) {
          const threadID = thread.id
          const generation = ++threadGeneration
          const result = await client.company.thread({
            threadID,
            company_id: companyID,
          })
          if (result.error) throw result.error
          if (result.data && generation === threadGeneration && thread?.id === threadID) {
            thread = result.data
          }
        }
      } catch (err: unknown) {
        const message =
          err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Conversation refresh failed", message, true)
      }
      publish()
    }, 250)
  }

  // ── Public API ────────────────────────────────────────────────────────────

  const store: ConversationStore = {
    getState: snapshot,

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async refresh() {
      const channelsRequest = ++channelsGeneration
      const channelID = activeChannelID
      const messagesRequest = channelID ? ++messagesGeneration : undefined
      const threadID = thread?.id
      const threadRequest = threadID ? ++threadGeneration : undefined
      loadingChannels = true
      loadingMessages = Boolean(channelID)
      error = null
      publish()
      try {
        const channelsResult = await client.company.channels({ company_id: companyID })
        if (channelsResult.error) throw channelsResult.error
        if (channelsRequest === channelsGeneration) {
          channels = (channelsResult.data ?? []).map((raw) => raw as unknown as ConversationChannelItem)
          loadingChannels = false
          if (!activeChannelID) {
            const initialChannel = channels.find((channel) => channel.kind === "board") ?? channels[0]
            if (initialChannel) {
              await store.setActiveChannel(initialChannel.id)
              return
            }
          }
        }

        if (channelID && messagesRequest) {
          const msgResult = await client.company.channelMessages({
            channelID,
            company_id: companyID,
            limit: 50,
          })
          if (msgResult.error) throw msgResult.error
          const page = msgResult.data
          if (page && messagesRequest === messagesGeneration && activeChannelID === channelID) {
            replaceMessages(
              channelID,
              page.items.map((raw) => raw as unknown as ConversationMessageItem),
              page.nextCursor,
            )
            loadingMessages = false
          }
        }

        if (threadID && threadRequest) {
          const tResult = await client.company.thread({
            threadID,
            company_id: companyID,
          })
          if (tResult.error) throw tResult.error
          if (tResult.data && threadRequest === threadGeneration && thread?.id === threadID) {
            thread = tResult.data
          }
        }

        clearError()
      } catch (err: unknown) {
        const message =
          err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Failed to load conversation", message, true)
      }
      publish()
    },

    async setActiveChannel(channelID) {
      if (channelID === activeChannelID) return
      const generation = ++messagesGeneration
      threadGeneration += 1
      activeChannelID = channelID
      messages = []
      messagesBefore = null
      thread = null
      threadEntries = []
      threadEntriesBefore = null
      threadSources = {}
      loadingThreadSourceIDs = []
      loadingMessages = true
      error = null
      publish()
      try {
        const result = await client.company.channelMessages({
          channelID,
          company_id: companyID,
          limit: 50,
        })
        if (result.error) throw result.error
        const page = result.data
        if (page && generation === messagesGeneration && activeChannelID === channelID) {
          replaceMessages(
            channelID,
            page.items.map((raw) => raw as unknown as ConversationMessageItem),
            page.nextCursor,
          )
          loadingMessages = false
          clearError()
          const latestThreadID =
            channels.find((channel) => channel.id === channelID)?.kind === "board"
              ? messages.find((message) => message.sourceThreadID)?.sourceThreadID
              : undefined
          if (latestThreadID) await store.openThread(latestThreadID)
        }
      } catch (err: unknown) {
        if (generation !== messagesGeneration || activeChannelID !== channelID) return
        const message =
          err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Failed to load messages", message, true)
        loadingMessages = false
      }
      publish()
    },

    async sendMessage(body, opts) {
      if (!activeChannelID) throw new Error("No active channel")
      const channelID = activeChannelID
      sending = true
      publish()
      const requestID = createRequestID()

      try {
        const input: ChannelSendInput = {
          request_id: requestID,
          body,
          reply_to: opts?.reply_to,
          referenced_thread_id: opts?.referenced_thread_id,
          mentions: opts?.mentions,
        }
        const result = await client.company.channelSend({
          channelID,
          company_id: companyID,
          channelSendInput: input,
        })
        if (result.error) throw result.error
        const accepted = result.data as MessageAccepted

        pendingMessages = [
          ...pendingMessages.filter((pending) => pending.requestID !== requestID),
          {
            requestID,
            body,
            channelID,
            time: Date.now(),
            confirmed: true,
            messageID: accepted.messageID,
            threadID: accepted.threadID,
            runID: accepted.runID,
          },
        ]
        sending = false
        publish()

        if (activeChannelID === channelID) scheduleMessagesRefresh()

        return accepted as MessageAccepted
      } catch (err: unknown) {
        const message =
          err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Failed to send message", message, true)
        sending = false
        publish()
        throw err
      }
    },

    async pageMessages(limit = 50) {
      if (!activeChannelID) return
      const channelID = activeChannelID
      const generation = messagesGeneration
      const cursor = messagesBefore ?? beforeCursorFromMessages(messages)
      if (!cursor) return // No more pages
      try {
        const result = await client.company.channelMessages({
          channelID,
          company_id: companyID,
          before: cursor,
          limit,
        })
        if (result.error) throw result.error
        if (generation !== messagesGeneration || activeChannelID !== channelID) return
        const page = result.data
        if (page) {
          const existingIDs = new Set(messages.map((m) => m.id))
          const newItems = page.items
            .filter((item) => !existingIDs.has(item.id))
            .map((raw) => raw as unknown as ConversationMessageItem)
          messages = [...messages, ...newItems]
          messagesBefore = page.nextCursor ?? null
        } else {
          messagesBefore = null
        }
        clearError()
      } catch (err: unknown) {
        const message =
          err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Failed to load more messages", message, true)
      }
      publish()
    },

    async openThread(threadID) {
      const generation = ++threadGeneration
      thread = null
      threadEntries = []
      threadEntriesBefore = null
      threadSources = {}
      loadingThreadSourceIDs = []
      error = null
      publish()
      if (!threadID) return
      try {
        const [tResult, eResult] = await Promise.all([
          client.company.thread({ threadID, company_id: companyID }),
          client.company.threadEntries({ threadID, company_id: companyID, limit: 50 }),
        ])
        if (tResult.error) throw tResult.error
        if (eResult.error) throw eResult.error
        if (generation !== threadGeneration) return
        if (tResult.data) thread = tResult.data
        const page = eResult.data
        if (page) {
          threadEntries = page.items
          threadEntriesBefore = page.nextCursor ?? null
        }
        clearError()
      } catch (err: unknown) {
        if (generation !== threadGeneration) return
        const message =
          err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Failed to load thread", message, true)
      }
      publish()
    },

    async pageThreadEntries(limit = 50) {
      if (!thread) return
      const threadID = thread.id
      const generation = threadGeneration
      const cursor = threadEntriesBefore ?? beforeCursorFromEntries(threadEntries)
      if (!cursor) return
      try {
        const result = await client.company.threadEntries({
          threadID,
          company_id: companyID,
          before: cursor,
          limit,
        })
        if (result.error) throw result.error
        if (generation !== threadGeneration || thread?.id !== threadID) return
        const page = result.data
        if (page) {
          const existingIDs = new Set(threadEntries.map((e) => e.message.id))
          const newItems = page.items.filter((item) => !existingIDs.has(item.message.id))
          threadEntries = [...threadEntries, ...newItems]
          threadEntriesBefore = page.nextCursor ?? null
        } else {
          threadEntriesBefore = null
        }
        clearError()
      } catch (err: unknown) {
        const message =
          err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Failed to load more thread entries", message, true)
      }
      publish()
    },

    async loadThreadSource(sourceID) {
      if (!thread) throw new Error("No open thread")
      const cached = threadSources[sourceID]
      if (cached) return cached
      const threadID = thread.id
      const generation = threadGeneration
      loadingThreadSourceIDs = [...new Set([...loadingThreadSourceIDs, sourceID])]
      publish()
      try {
        const result = await client.company.threadSource({ threadID, sourceID, company_id: companyID })
        if (result.error) throw result.error
        if (!result.data) throw new Error("Thread source response was empty")
        if (generation !== threadGeneration || thread?.id !== threadID) return result.data
        threadSources = { ...threadSources, [sourceID]: result.data }
        clearError()
        return result.data
      } catch (err: unknown) {
        if (generation === threadGeneration && thread?.id === threadID) {
          const message =
            err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
          setError("Failed to load thread evidence", message, true)
        }
        throw err
      } finally {
        if (generation === threadGeneration && thread?.id === threadID) {
          loadingThreadSourceIDs = loadingThreadSourceIDs.filter((id) => id !== sourceID)
          publish()
        }
      }
    },

    async interruptThread() {
      if (!thread) throw new Error("No open thread")
      const threadID = thread.id
      try {
        const result = await client.company.threadAction({
          threadID,
          company_id: companyID,
          threadActionInput: { kind: "interrupt" },
        })
        if (result.error) throw result.error
        if (result.data && thread?.id === threadID) {
          thread = result.data
          publish()
        }
      } catch (err: unknown) {
        const message =
          err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Failed to interrupt thread", message, false)
        publish()
        throw err
      }
    },

    handleEvent(event: Event) {
      if (event.type === "server.connected") {
        void store.refresh()
      } else if (event.type === "company.channel.invalidated") {
        scheduleChannelRefresh()
        if (event.properties.channel_id === activeChannelID) {
          scheduleMessagesRefresh()
        }
      } else if (event.type === "company.thread.invalidated") {
        if (thread && event.properties.thread_id === thread.id) {
          scheduleThreadRefresh()
        }
      } else if (event.type === "company.conversation_run.updated") {
        if (thread && event.properties.thread_id === thread.id) {
          scheduleThreadRefresh()
        }
      }
    },

    getActiveChannelID() {
      return activeChannelID
    },

    getOpenThreadID() {
      return thread?.id ?? null
    },
  }

  // Initial state shows loading; caller must call refresh() to populate
  loadingChannels = true
  publish()

  return store
}
