import { expect, test } from "bun:test"
import { isAgentCompanyProvider } from "./provider-filter"

test("filters inherited Control Plane providers from Agent Company surfaces", () => {
  expect(isAgentCompanyProvider("control-plane")).toBe(false)
  expect(isAgentCompanyProvider("control-plane-go")).toBe(false)
  expect(isAgentCompanyProvider("openai")).toBe(true)
  expect(isAgentCompanyProvider("custom")).toBe(true)
})
