import { describe, expect, test } from "bun:test"
import { createDisconnectedCompanyWorkspaceDataSource } from "./company-data-source"
import type { CompanyReadyWorkspaceSnapshot } from "./company-model"

describe("company workspace data source", () => {
  test("keeps production honest when runtime data is not connected", () => {
    const source = createDisconnectedCompanyWorkspaceDataSource()
    const snapshot = source.getSnapshot()

    expect(snapshot.status).toBe("disconnected")
    // No fixture/demo content leaks into the disconnected snapshot
    expect(JSON.stringify(snapshot)).not.toMatch(/142\/142|评审通过|已通过|pre-public-webui/)
    expect(source.refresh).toBeDefined()
  })

  test("disconnected source has no conversation store or send/approve actions", () => {
    const source = createDisconnectedCompanyWorkspaceDataSource()
    // The fixture-only sendMessage/approveDelivery methods are gone; sending
    // happens through the conversation store, which is absent when disconnected.
    expect((source as Record<string, unknown>)["sendMessage"]).toBeUndefined()
    expect((source as Record<string, unknown>)["approveDelivery"]).toBeUndefined()
    expect(source.conversation).toBeUndefined()
  })
})

describe("CompanyReadySnapshot shape", () => {
  test("ready snapshot carries the M2 conversation state", () => {
    const snapshot = {
      status: "ready",
      access: { kind: "basic", can_manage_credentials: true },
      state: "ready",
      data_directory: "/company/data",
      company: {
        id: "cmp_local",
        name: "Agent Company",
        data_version: 1,
        provider: { provider_id: "openai", model_id: "gpt-5" },
        setup_goal: null,
        approval_policy: { preset: "balanced" },
        repository: {
          project_id: "project-1",
          root_path: "/repo",
          default_branch: "main",
          bootstrap_head_commit: "abc123",
          dirty: false,
        },
        board: [
          { id: "board-ceo", role: "ceo", name: "CEO", lifecycle: "employee", responsibilities: ["Direction"] },
          { id: "board-cto", role: "cto", name: "CTO", lifecycle: "employee", responsibilities: ["Quality"] },
          { id: "board-product-lead", role: "product_lead", name: "Product Lead", lifecycle: "employee", responsibilities: ["Value"] },
        ],
        created_at: 1,
        updated_at: 1,
      },
      start_suggestion: { kind: "bootstrap_complete", action: "open_board" },
      capabilities: { board_messages: false },
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
      },
    } satisfies CompanyReadyWorkspaceSnapshot

    expect(snapshot.status).toBe("ready")
    expect(snapshot.conversation.channels).toEqual([])
    expect(snapshot.capabilities.board_messages).toBe(false)
  })
})
