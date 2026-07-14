import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { launcherState, loadCompanyRuntime, normalizeCompanyHome } from "./company-home"

const originalHome = process.env.AGENTCOMPANY_HOME
const companyHome = path.join(path.parse(process.cwd()).root, "company", "root")

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
    expect(launcherState(companyHome, "/ignored")).toEqual({
      state: "ready",
      company_home: companyHome,
    })
  })

  test("sets company home before loading the control plane", async () => {
    expect(await loadCompanyRuntime(companyHome, async () => process.env.AGENTCOMPANY_HOME)).toBe(companyHome)
  })
})
