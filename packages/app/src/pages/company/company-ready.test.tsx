import { describe, expect, test } from "bun:test"
import type { CompanyReadySnapshot } from "./company-ready"

const component = await Bun.file(new URL("./company-ready.tsx", import.meta.url)).text()

const snapshot: CompanyReadySnapshot = {
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
      {
        id: "board-product-lead",
        role: "product_lead",
        name: "Product Lead",
        lifecycle: "employee",
        responsibilities: ["Value"],
      },
    ],
    created_at: 1,
    updated_at: 1,
  },
  start_suggestion: { kind: "bootstrap_complete", action: "open_board" },
  capabilities: { board_messages: false },
}

describe("CompanyReady", () => {
  test("renders real company facts without M0 collaboration shell", () => {
    expect(snapshot.company.name).toBe("Agent Company")
    expect(snapshot.data_directory).toBe("/company/data")
    expect(snapshot.company.provider).toEqual({ provider_id: "openai", model_id: "gpt-5" })
    expect(snapshot.company.repository?.root_path).toBe("/repo")
    expect(snapshot.company.approval_policy.preset).toBe("balanced")
    expect(snapshot.company.board).toHaveLength(3)
    expect(snapshot.start_suggestion.kind).toBe("bootstrap_complete")
    expect(component).toContain('data-capability="board-messages-disabled"')
    expect(component).not.toContain("company-channels")
    expect(component).not.toContain("company-composer")
    expect(component).not.toContain("company-thread")
    expect(component).not.toContain("company-approval")
    expect(component).not.toContain("company-delivery")
  })

  test("opens the real board when the settings dialog supplies the action", () => {
    expect(component).toContain("onOpenBoard?: () => void")
    expect(component).toContain("disabled={!props.onOpenBoard}")
    expect(component).toContain("onClick={props.onOpenBoard}")
  })
})
