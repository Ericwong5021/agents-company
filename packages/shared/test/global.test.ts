import { describe, expect, test } from "bun:test"
import path from "path"
import { resolveAgentCompanyHome } from "@mimo-ai/shared/global"

describe("resolveAgentCompanyHome", () => {
  test("with AGENTCOMPANY_HOME set, resolves 4 subdirs under root", () => {
    const result = resolveAgentCompanyHome({
      AGENTCOMPANY_HOME: "/tmp/profile-a",
    })
    expect(result.mode).toBe("agent_company_home")
    expect(result.root).toBe("/tmp/profile-a")
    expect(result.config).toBe(path.join("/tmp/profile-a", "config"))
    expect(result.data).toBe(path.join("/tmp/profile-a", "data"))
    expect(result.state).toBe(path.join("/tmp/profile-a", "state"))
    expect(result.cache).toBe(path.join("/tmp/profile-a", "cache"))
  })

  test("without home override, falls through to xdg mode", () => {
    const result = resolveAgentCompanyHome({})
    expect(result.mode).toBe("xdg")
    expect(result.root).toBeUndefined()
    expect(result.config.endsWith(path.join("", "agent-company"))).toBe(true)
    expect(result.data.endsWith(path.join("", "agent-company"))).toBe(true)
    expect(result.state.endsWith(path.join("", "agent-company"))).toBe(true)
    expect(result.cache.endsWith(path.join("", "agent-company"))).toBe(true)
  })

  test("empty home override string is treated as unset (xdg mode)", () => {
    const result = resolveAgentCompanyHome({ AGENTCOMPANY_HOME: "" })
    expect(result.mode).toBe("xdg")
  })

  test("relative AGENTCOMPANY_HOME path throws with clear error", () => {
    expect(() => resolveAgentCompanyHome({ AGENTCOMPANY_HOME: "./foo" })).toThrow(
      /AGENTCOMPANY_HOME must be an absolute path/,
    )
  })

  test("tilde-prefixed home override throws (not treated as absolute)", () => {
    expect(() => resolveAgentCompanyHome({ AGENTCOMPANY_HOME: "~/profiles/a" })).toThrow(
      /AGENTCOMPANY_HOME must be an absolute path/,
    )
  })

  test("error message includes the offending value", () => {
    expect(() => resolveAgentCompanyHome({ AGENTCOMPANY_HOME: "./relative" })).toThrow(
      /\.\/relative/,
    )
  })

})
