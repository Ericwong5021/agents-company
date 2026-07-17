import { describe, expect, test } from "bun:test"
import { BootstrapInput, CompanyState } from "../../src/company/schema"

describe("M1 company schema", () => {
  test("defaults policy to balanced and rejects a second repository field", () => {
    const input = BootstrapInput.parse({
      request_id: "018f84f8-9c21-7d4d-a850-d63f8f9344cc",
      company_name: "Agent Company",
      provider_id: "openai",
      model_id: "gpt-5",
      repository_path: "/tmp/product",
    })
    expect(input.approval_preset).toBe("balanced")
    expect(BootstrapInput.safeParse({ ...input, repository_paths: ["/tmp/other"] }).success).toBe(false)
  })

  test("ready state always exposes exactly three board roles", () => {
    const parsed = CompanyState.parse({
      state: "ready",
      data_directory: "/tmp/company/data",
      company: {
        id: "cmp_local",
        name: "Agent Company",
        data_version: 1,
        provider: { provider_id: "openai", model_id: "gpt-5" },
        approval_policy: { preset: "balanced" },
        repository: {
          project_id: "project-1",
          root_path: "/tmp/product",
          default_branch: "main",
          bootstrap_head_commit: null,
          dirty: false,
        },
        board: [
          { id: "board-ceo", role: "ceo", name: "CEO", lifecycle: "employee", responsibilities: ["公司目标与最终取舍"] },
          { id: "board-cto", role: "cto", name: "CTO", lifecycle: "employee", responsibilities: ["技术方向与工程质量"] },
          {
            id: "board-product-lead",
            role: "product_lead",
            name: "Product Lead",
            lifecycle: "employee",
            responsibilities: ["用户价值与验收"],
          },
        ],
        created_at: 1,
        updated_at: 1,
      },
      start_suggestion: {
        kind: "bootstrap_complete",
        action: "open_board",
      },
      capabilities: { board_messages: false },
    })
    if (parsed.state !== "ready") throw new Error("Expected ready state")
    expect(parsed.company.board.map((item) => item.role)).toEqual(["ceo", "cto", "product_lead"])
  })
})
