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
  sendMessage(body: string, opts?: { reply_to?: string; referenced_thread_id?: ConversationThreadId; mentions?: Array<ConversationMention> }): Promise<MessageAccepted>
  /** Load older messages for the active channel (cursor-based before) */
  pageMessages(limit?: number): Promise<void>
  /** Open a thread and load its first page of entries */
  openThread(threadID: ConversationThreadId): Promise<void>
  /** Load older thread entries (cursor-based before) */
  pageThreadEntries(limit?: number): Promise<void>
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
  let loadingChannels = false
  let loadingMessages = false
  let sending = false
  let error: ConversationError | null = null

  const listeners = new Set<(state: ConversationSnapshot) => void>()
  let invalidateTimer: ReturnType<typeof setTimeout> | undefined

  function snapshot(): ConversationSnapshot {
    return Object.freeze({
      channels,
      activeChannelID,
      messages,
      messagesBefore,
      pendingMessages,
      thread,
      threadEntries,
      threadEntriesBefore,
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
          loadingChannels = true
          publish()
          const result = await client.company.channels({ company_id: companyID })
          if (result.error) throw result.error
          channels = (result.data ?? []).map((raw) => raw as unknown as ConversationChannelItem)
          loadingChannels = false
        }
        if (flags.messages && activeChannelID) {
          loadingMessages = true
          publish()
          const result = await client.company.channelMessages({
            channelID: activeChannelID,
            company_id: companyID,
            limit: 50,
          })
          if (result.error) throw result.error
          const page = result.data
          if (page) {
            messages = page.items.map((raw) => raw as unknown as ConversationMessageItem)
            messagesBefore = page.nextCursor ?? null
          }
          loadingMessages = false
        }
        if (flags.thread && thread) {
          const result = await client.company.thread({
            threadID: thread.id,
            company_id: companyID,
          })
          if (result.error) throw result.error
          if (result.data) {
            thread = result.data as unknown as ConversationThreadDetail
          }
        }
      } catch (err: unknown) {
        const message = err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
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
      loadingChannels = true
      loadingMessages = false
      error = null
      publish()
      try {
        const channelsResult = await client.company.channels({ company_id: companyID })
        if (channelsResult.error) throw channelsResult.error
        channels = (channelsResult.data ?? []).map((raw) => raw as unknown as ConversationChannelItem)
        loadingChannels = false

        if (activeChannelID) {
          loadingMessages = true
          publish()
          const msgResult = await client.company.channelMessages({
            channelID: activeChannelID,
            company_id: companyID,
            limit: 50,
          })
          if (msgResult.error) throw msgResult.error
          const page = msgResult.data
          if (page) {
            messages = page.items.map((raw) => raw as unknown as ConversationMessageItem)
            messagesBefore = page.nextCursor ?? null
          }
          loadingMessages = false
        }

        if (thread) {
          const tResult = await client.company.thread({
            threadID: thread.id,
            company_id: companyID,
          })
          if (tResult.error) throw tResult.error
          if (tResult.data) {
            thread = tResult.data as unknown as ConversationThreadDetail
          }
        }

        clearError()
      } catch (err: unknown) {
        const message = err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Failed to load conversation", message, true)
      }
      publish()
    },

    async setActiveChannel(channelID) {
      if (channelID === activeChannelID) return
      activeChannelID = channelID
      messages = []
      messagesBefore = null
      thread = null
      threadEntries = []
      threadEntriesBefore = null
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
        if (page) {
          messages = page.items.map((raw) => raw as unknown as ConversationMessageItem)
          messagesBefore = page.nextCursor ?? null
        }
        loadingMessages = false
        clearError()
      } catch (err: unknown) {
        const message = err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Failed to load messages", message, true)
        loadingMessages = false
      }
      publish()
    },

    async sendMessage(body, opts) {
      if (!activeChannelID) throw new Error("No active channel")
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
          channelID: activeChannelID,
          company_id: companyID,
          channelSendInput: input,
        })
        if (result.error) throw result.error
        const accepted = result.data as MessageAccepted

        sending = false
        publish()

        // Trigger background refresh for the active channel
        scheduleMessagesRefresh()

        return accepted as MessageAccepted
      } catch (err: unknown) {
        const message = err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Failed to send message", message, true)
        sending = false
        publish()
        throw err
      }
    },

    async pageMessages(limit = 50) {
      if (!activeChannelID) return
      const cursor = messagesBefore ?? beforeCursorFromMessages(messages)
      if (!cursor) return // No more pages
      try {
        const result = await client.company.channelMessages({
          channelID: activeChannelID,
          company_id: companyID,
          before: cursor,
          limit,
        })
        if (result.error) throw result.error
        const page = result.data
        if (page) {
          const existingIDs = new Set(messages.map((m) => m.id))
          const newItems = page.items.filter((item) => !existingIDs.has(item.id)).map((raw) => raw as unknown as ConversationMessageItem)
          messages = [...messages, ...newItems]
          messagesBefore = page.nextCursor ?? null
        } else {
          messagesBefore = null
        }
        clearError()
      } catch (err: unknown) {
        const message = err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Failed to load more messages", message, true)
      }
      publish()
    },

    async openThread(threadID) {
      thread = null
      threadEntries = []
      threadEntriesBefore = null
      error = null
      publish()
      try {
        const [tResult, eResult] = await Promise.all([
          client.company.thread({ threadID, company_id: companyID }),
          client.company.threadEntries({ threadID, company_id: companyID, limit: 50 }),
        ])
        if (tResult.error) throw tResult.error
        if (eResult.error) throw eResult.error
        if (tResult.data) thread = tResult.data as unknown as ConversationThreadDetail
        const page = eResult.data
        if (page) {
          threadEntries = page.items as unknown as ConversationThreadEntryItem[]
          threadEntriesBefore = page.nextCursor ?? null
        }
        clearError()
      } catch (err: unknown) {
        const message = err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Failed to load thread", message, true)
      }
      publish()
    },

    async pageThreadEntries(limit = 50) {
      if (!thread) return
      const cursor = threadEntriesBefore ?? beforeCursorFromEntries(threadEntries)
      if (!cursor) return
      try {
        const result = await client.company.threadEntries({
          threadID: thread.id,
          company_id: companyID,
          before: cursor,
          limit,
        })
        if (result.error) throw result.error
        const page = result.data
        if (page) {
          const existingIDs = new Set(threadEntries.map((e) => e.message.id))
          const newItems = page.items.filter((item) => !existingIDs.has(item.message.id)) as ConversationThreadEntryItem[]
          threadEntries = [...threadEntries, ...newItems]
          threadEntriesBefore = page.nextCursor ?? null
        } else {
          threadEntriesBefore = null
        }
        clearError()
      } catch (err: unknown) {
        const message = err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Failed to load more thread entries", message, true)
      }
      publish()
    },

    async interruptThread() {
      if (!thread) throw new Error("No open thread")
      try {
        const result = await client.company.threadAction({
          threadID: thread.id,
          company_id: companyID,
          threadActionInput: { kind: "interrupt" },
        })
        if (result.error) throw result.error
        // Refresh thread state
        store.openThread(thread.id)
      } catch (err: unknown) {
        const message = err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : String(err)
        setError("Failed to interrupt thread", message, false)
        publish()
        throw err
      }
    },

    handleEvent(event: Event) {
      if (event.type === "company.channel.invalidated") {
        scheduleChannelRefresh()
        if (event.properties.channel_id === activeChannelID) {
          scheduleMessagesRefresh()
        }
      } else if (event.type === "company.thread.invalidated") {
        if (thread && event.properties.thread_id === thread.id) {
          scheduleThreadRefresh()
        }
      }
      // Note: company.conversation_run.updated is handled by the thread
      // invalidation event; we don't maintain a separate runState locally
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
