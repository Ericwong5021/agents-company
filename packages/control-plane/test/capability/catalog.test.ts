import { describe, expect, test } from "bun:test"
import { CapabilityCatalog } from "../../src/capability/catalog"

describe("CapabilityCatalog", () => {
  test("ships the first-party software company capability packs as immutable versions", () => {
    const packs = CapabilityCatalog.list()

    expect(packs.map((pack) => pack.id)).toEqual([
      "board-strategy",
      "delivery-governance",
      "design-production",
      "document-authoring",
      "independent-review",
      "product-charter",
      "project-wayfinding",
      "research-analysis",
      "software-implementation",
      "technical-planning",
      "verification-testing",
    ])
    expect(packs.every((pack) => pack.version === "1")).toBe(true)
    expect(packs.every((pack) => /^[a-f0-9]{64}$/.test(pack.checksum))).toBe(true)
  })

  test("resolves an exact version and rejects unknown or unversioned references", () => {
    expect(CapabilityCatalog.resolve("software-implementation@1").id).toBe("software-implementation")
    expect(() => CapabilityCatalog.resolve("software-implementation")).toThrow("must include an immutable version")
    expect(() => CapabilityCatalog.resolve("software-implementation@2")).toThrow("Unknown capability pack")
  })
})
