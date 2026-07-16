import { describe, expect, test } from "bun:test"
import { companyWorkspacePath, projectWorkspacePath } from "./shell-navigation"

describe("shell navigation", () => {
  test("keeps the Company workspace at the root route", () => {
    expect(companyWorkspacePath).toBe("/")
  })

  test("encodes project directories into the existing session route", () => {
    expect(projectWorkspacePath("/tmp/Agent Company")).toBe("/L3RtcC9BZ2VudCBDb21wYW55/session")
  })
})
