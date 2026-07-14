import { expect, test } from "bun:test"
import { isAgentCompanyProvider } from "./provider-filter"

test("filters inherited OpenCode providers from Agent Company surfaces", () => {
  expect(isAgentCompanyProvider("opencode")).toBe(false)
  expect(isAgentCompanyProvider("opencode-go")).toBe(false)
  expect(isAgentCompanyProvider("openai")).toBe(true)
  expect(isAgentCompanyProvider("custom")).toBe(true)
})
