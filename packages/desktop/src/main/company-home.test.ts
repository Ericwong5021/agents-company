import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { launcherState, loadCompanyRuntime, normalizeCompanyHome } from "./company-home"

const originalHome = process.env.AGENTCOMPANY_HOME

afterEach(() => {
  if (originalHome) process.env.AGENTCOMPANY_HOME = originalHome
  if (!originalHome) delete process.env.AGENTCOMPANY_HOME
})

describe("company home", () => {
  test("requires an absolute path", () => {
    expect(() => normalizeCompanyHome("./company")).toThrow("Company home must be an absolute path")
  })

  test("returns preflight before a home is stored", () => {
    expect(launcherState(null, "/Users/test/Documents")).toEqual({
      state: "needs_company_home",
      suggested_path: path.join("/Users/test/Documents", "Agent Company"),
    })
  })

  test("returns ready with the same stored root", () => {
    expect(launcherState("/company/root", "/ignored")).toEqual({
      state: "ready",
      company_home: "/company/root",
    })
  })

  test("sets company home before loading the control plane", async () => {
    expect(await loadCompanyRuntime("/company/root", async () => process.env.AGENTCOMPANY_HOME)).toBe("/company/root")
  })
})
