import { describe, expect, test } from "bun:test"
import { decideCompanyEntry, type CompanyEntryState } from "./company-entry"

const ready = (repository_path: string): CompanyEntryState => ({
  state: "ready",
  repository_path,
})

describe("TUI company entry", () => {
  test("requires primary UI bootstrap", () => {
    expect(
      decideCompanyEntry(
        { state: "needs_bootstrap", data_directory: "/company/data" },
        "/repo",
      ),
    ).toEqual({ type: "setup_required", data_directory: "/company/data" })
  })

  test("rejects a cwd outside the primary repository", () => {
    expect(decideCompanyEntry(ready("/repo"), "/other")).toEqual({
      type: "repository_mismatch",
      repository_path: "/repo",
    })
  })

  test("enters the existing shell in the bound repository", () => {
    expect(decideCompanyEntry(ready("/repo"), "/repo")).toEqual({ type: "ready" })
  })

  test("accepts a cwd inside the bound repository", () => {
    expect(decideCompanyEntry(ready("/repo"), "/repo/packages/app")).toEqual({ type: "ready" })
  })
})
