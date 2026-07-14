import { describe, expect, test, beforeEach } from "bun:test"
import { createConversationStore, type ConversationStore } from "./company-conversation-data-source"
import type {
  EventCompanyChannelInvalidated,
  EventCompanyThreadInvalidated,
} from "@agents-company/sdk/v2/client"

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockResult<T>(data: T) {
  return { data, error: undefined, response: new Response() }
}

function mockError(name: string) {
  return { data: undefined, error: { name, data: {} }, response: new Response() }
}

const CHANNEL_RESPONSE = [
  { id: "chn_company", kind: "company", title: "公司群", retentionDays: 30, time: { created: 1, updated: 1 } },
  { id: "chn_board", kind: "board", title: "董事会", retentionDays: 30, time: { created: 2, updated: 2 } },
  { id: "chn_project", kind: "project", title: "M2 Real IM", retentionDays: 90, time: { created: 3, updated: 3 } },
]

const MSG_PAGE_1 = [
  {
    id: "cmsg_1",
    channelID: "chn_board",
    author: { kind: "user", id: "local-user" },
    body: "Let's implement M2",
    visibility: "channel",
    mentions: [],
    time: { created: 200, updated: 200 },
  },
  {
    id: "cmsg_2",
    channelID: "chn_board",
    author: { kind: "agent", id: "ceo" },
    body: "Agreed. Starting the board discussion.",
    visibility: "channel",
    signalType: "conclusion",
    mentions: [],
    time: { created: 100, updated: 100 },
  },
]

const MSG_PAGE_2 = [
  {
    id: "cmsg_3",
    channelID: "chn_board",
    author: { kind: "agent", id: "cto" },
    body: "Technical scope defined.",
    visibility: "channel",
    signalType: "conclusion",
    mentions: [],
    time: { created: 50, updated: 50 },
  },
]

const THREAD_DETAIL = {
  id: "cth_1",
  channelID: "chn_board",
  rootNeedID: "need_1",
  status: "active",
  title: "M2 Implementation",
  members: [
    { principal: { kind: "agent", id: "ceo" }, time: { joined: 100 } },
    { principal: { kind: "agent", id: "cto" }, time: { joined: 100 } },
    { principal: { kind: "agent", id: "product_lead" }, time: { joined: 100 } },
  ],
  time: { created: 100, updated: 200 },
}

const THREAD_ENTRIES_PAGE_1 = [
  {
    type: "message",
    message: {
      id: "cmsg_2",
      channelID: "chn_board",
      author: { kind: "agent", id: "ceo" },
      body: "Agreed. Starting the board discussion.",
      visibility: "channel",
      signalType: "conclusion",
      mentions: [],
      time: { created: 200, updated: 200 },
    },
  },
]

// ── Mock client factory ─────────────────────────────────────────────────────

const THREAD_ACTION_RESPONSE = { ...THREAD_DETAIL }

function createMockClient(): { company: Record<string, (...args: any[]) => any> } {
  return {
    company: {
      channels: async (...args: any[]) => mockResult(CHANNEL_RESPONSE),
      channelMessages: async (...args: any[]) => mockResult({ items: MSG_PAGE_1, nextCursor: "100" }),
      channelSend: async (...args: any[]) => mockResult({
        messageID: "cmsg_new",
        rootNeedID: "need_1",
        threadID: "cth_1",
        runID: "crun_1",
        replayed: false,
      }),
      thread: async (...args: any[]) => mockResult(THREAD_DETAIL),
      threadEntries: async (...args: any[]) => mockResult({ items: THREAD_ENTRIES_PAGE_1, nextCursor: undefined }),
      threadAction: async (...args: any[]) => mockResult(THREAD_ACTION_RESPONSE),
    } as any,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ConversationStore", () => {
  let store: ConversationStore
  let client: any
  const COMPANY_ID = "cmp_local"

  beforeEach(() => {
    client = createMockClient()
    store = createConversationStore({ client, companyID: COMPANY_ID })
  })

  // ── Initial state ───────────────────────────────────────────────────────

  test("initial state has loading channels", () => {
    const state = store.getState()
    expect(state.loadingChannels).toBe(true)
    expect(state.channels).toEqual([])
    expect(state.activeChannelID).toBeNull()
    expect(state.messages).toEqual([])
    expect(state.error).toBeNull()
  })

  // ── Refresh ──────────────────────────────────────────────────────────────

  test("refresh loads channels", async () => {
    await store.refresh()
    const state = store.getState()
    expect(state.loadingChannels).toBe(false)
    expect(state.channels).toHaveLength(3)
  })

  test("handles network error gracefully on refresh", async () => {
    client.company.channels = async () => mockError("UnknownError")
    store = createConversationStore({ client, companyID: COMPANY_ID })
    await store.refresh()
    const state = store.getState()
    expect(state.error).not.toBeNull()
    expect(state.error!.retryable).toBe(true)
  })

  // ── Active channel ──────────────────────────────────────────────────────

  test("setActiveChannel loads messages for the channel", async () => {
    await store.setActiveChannel("chn_board")
    await new Promise((resolve) => setTimeout(resolve, 50))
    const state = store.getState()
    expect(state.activeChannelID).toBe("chn_board")
    expect(state.messages).toHaveLength(2)
    expect(state.messages[0].id).toBe("cmsg_1")
    expect(state.messages[1].body).toContain("Agreed")
  })

  test("setActiveChannel clears previous thread state", async () => {
    await store.openThread("cth_1")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(store.getState().thread).not.toBeNull()

    await store.setActiveChannel("chn_company")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(store.getState().thread).toBeNull()
    expect(store.getState().threadEntries).toEqual([])
  })

  test("getActiveChannelID returns current channel", async () => {
    expect(store.getActiveChannelID()).toBeNull()
    await store.setActiveChannel("chn_board")
    expect(store.getActiveChannelID()).toBe("chn_board")
  })

  test("getOpenThreadID returns current thread or null", async () => {
    expect(store.getOpenThreadID()).toBeNull()
    await store.openThread("cth_1")
    expect(store.getOpenThreadID()).toBe("cth_1")
  })

  // ── Pagination ──────────────────────────────────────────────────────────

  test("pageMessages appends and deduplicates", async () => {
    await store.setActiveChannel("chn_board")
    await new Promise((resolve) => setTimeout(resolve, 50))

    client.company.channelMessages = async () =>
      mockResult({ items: MSG_PAGE_2, nextCursor: undefined })

    await store.pageMessages()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const state = store.getState()
    expect(state.messages).toHaveLength(3)
    expect(state.messagesBefore).toBeNull()
  })

  test("pageMessages does not duplicate existing messages", async () => {
    await store.setActiveChannel("chn_board")
    await new Promise((resolve) => setTimeout(resolve, 50))

    client.company.channelMessages = async () =>
      mockResult({ items: MSG_PAGE_1, nextCursor: "50" })

    await store.pageMessages()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const state = store.getState()
    expect(state.messages).toHaveLength(2)
  })

  // ── Send message ────────────────────────────────────────────────────────

  test("sendMessage sends and returns MessageAccepted", async () => {
    await store.setActiveChannel("chn_board")
    await new Promise((resolve) => setTimeout(resolve, 50))

    const result = await store.sendMessage("Hello board")
    expect(result.messageID).toBe("cmsg_new")
    expect(result.threadID).toBe("cth_1")
    expect(result.replayed).toBe(false)
  })

  test("sendMessage throws error without active channel", async () => {
    await expect(store.sendMessage("Hello")).rejects.toThrow("No active channel")
  })

  // ── Thread ──────────────────────────────────────────────────────────────

  test("openThread loads thread detail and entries", async () => {
    await store.openThread("cth_1")
    await new Promise((resolve) => setTimeout(resolve, 50))
    const state = store.getState()
    expect(state.thread).not.toBeNull()
    expect(state.thread!.id).toBe("cth_1")
    expect(state.thread!.status).toBe("active")
    expect(state.threadEntries).toHaveLength(1)
  })

  test("interruptThread sends interrupt action", async () => {
    await store.openThread("cth_1")

    let actionCalled = false
    client.company.threadAction = async () => {
      actionCalled = true
      return mockResult(THREAD_ACTION_RESPONSE)
    }

    await store.interruptThread()
    expect(actionCalled).toBe(true)
  })

  test("interruptThread throws without open thread", async () => {
    await expect(store.interruptThread()).rejects.toThrow("No open thread")
  })

  // ── Event handling ──────────────────────────────────────────────────────

  test("handleEvent company.channel.invalidated refreshes channels", async () => {
    let channelsCalled = false
    client.company.channels = async () => {
      channelsCalled = true
      return mockResult(CHANNEL_RESPONSE)
    }

    const event: EventCompanyChannelInvalidated = {
      type: "company.channel.invalidated",
      properties: { channel_id: "chn_board" },
    }
    store.handleEvent(event)

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(channelsCalled).toBe(true)
  })

  test("handleEvent company.channel.invalidated also refreshes active channel messages", async () => {
    await store.setActiveChannel("chn_board")
    await new Promise((resolve) => setTimeout(resolve, 50))

    let messagesCalled = false
    client.company.channelMessages = async () => {
      messagesCalled = true
      return mockResult({ items: MSG_PAGE_1, nextCursor: undefined })
    }

    const event: EventCompanyChannelInvalidated = {
      type: "company.channel.invalidated",
      properties: { channel_id: "chn_board" },
    }
    store.handleEvent(event)

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(messagesCalled).toBe(true)
  })

  test("handleEvent company.thread.invalidated refreshes open thread", async () => {
    await store.openThread("cth_1")
    await new Promise((resolve) => setTimeout(resolve, 50))

    let threadCalled = false
    client.company.thread = async () => {
      threadCalled = true
      return mockResult(THREAD_DETAIL)
    }

    const event: EventCompanyThreadInvalidated = {
      type: "company.thread.invalidated",
      properties: { thread_id: "cth_1" },
    }
    store.handleEvent(event)

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(threadCalled).toBe(true)
  })

  test("handleEvent skips refresh for non-matching thread", async () => {
    await store.openThread("cth_1")
    await new Promise((resolve) => setTimeout(resolve, 50))

    let threadCalled = false
    client.company.thread = async () => {
      threadCalled = true
      return mockResult(THREAD_DETAIL)
    }

    const event: EventCompanyThreadInvalidated = {
      type: "company.thread.invalidated",
      properties: { thread_id: "cth_other" },
    }
    store.handleEvent(event)

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(threadCalled).toBe(false)
  })

  // ── Subscription ────────────────────────────────────────────────────────

  test("subscribe receives state updates on channel switch", async () => {
    const updates: string[] = []
    const unsub = store.subscribe((s) => {
      updates.push(`active:${s.activeChannelID ?? "null"}`)
    })

    await store.setActiveChannel("chn_board")
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(updates.length).toBeGreaterThanOrEqual(1)
    const last = updates[updates.length - 1]
    expect(last).toContain("active:chn_board")
    unsub()
  })

  test("subscribe returns unsubscriber that stops updates", async () => {
    let count = 0
    const unsub = store.subscribe(() => { count++ })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const countAfterSubscribe = count

    unsub()
    await store.setActiveChannel("chn_board")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(count).toBe(countAfterSubscribe)
  })
})

describe("ConversationStore refresh isolation", () => {
  test("full refresh re-fetches channels and active messages", async () => {
    const client: any = createMockClient()
    const store = createConversationStore({ client, companyID: "cmp_local" })

    await store.setActiveChannel("chn_board")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(store.getState().messages).toHaveLength(2)

    client.company.channels = async () =>
      mockResult([
        ...CHANNEL_RESPONSE,
        { id: "chn_new", kind: "project", title: "New Project", retentionDays: 90, time: { created: 4, updated: 4 } },
      ])

    await store.refresh()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const state = store.getState()
    expect(state.channels).toHaveLength(4)
  })

  test("pageMessages uses oldest message timestamp as before cursor", async () => {
    const client: any = createMockClient()
    const store = createConversationStore({ client, companyID: "cmp_local" })

    await store.setActiveChannel("chn_board")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(store.getState().messages).toHaveLength(2)

    // messagesBefore should be "100" (oldest = MSG_PAGE_1[1].time.created = 100)
    expect(store.getState().messagesBefore).toBe("100")
  })
})
