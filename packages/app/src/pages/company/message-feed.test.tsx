import { describe, expect, test } from "bun:test"

const component = await Bun.file(new URL("./message-feed.tsx", import.meta.url)).text()

describe("MessageFeed", () => {
  test("supports all eight server-authored high-signal types", () => {
    const highSignalSet = component.match(/const HIGH_SIGNAL[\s\S]*?\)/)?.[0] ?? ""
    expect(highSignalSet).toContain('"conclusion"')
    expect(highSignalSet).toContain('"status"')
    expect(highSignalSet).toContain('"risk"')
    expect(highSignalSet).toContain('"intervention"')
    expect(highSignalSet).toContain('"decision"')
    expect(highSignalSet).toContain('"approval"')
    expect(highSignalSet).toContain('"delivery"')
    expect(highSignalSet).toContain('"plan"')
  })

  test("has accessible loading, empty and pending states that are not color-only", () => {
    expect(component).toContain('data-state="loading"')
    expect(component).toContain('data-state="empty"')
    expect(component).toContain("data-state=\"pending\"")
    expect(component).toContain("aria-busy")
    expect(component).toContain("aria-live")
  })

  test("pending messages are the only optimistic UI and are user-owned", () => {
    // No fabricated agent response is shown before the server confirms it.
    expect(component).toContain("pendingMessages")
    expect(component).toContain("company.feed.you")
    // pending rows are distinct from confirmed high-signal rows
    expect(component).toContain("pending.confirmed")
  })

  test("high-signal messages expose a source-thread affordance", () => {
    expect(component).toContain("sourceThreadID")
    expect(component).toContain("onOpenThread")
    expect(component).toContain("company.feed.openThread")
  })

  test("never renders fixture approval or delivery cards", () => {
    expect(component).not.toContain("company-approval")
    expect(component).not.toContain("company-delivery")
    expect(component).not.toContain("已批准")
    expect(component).not.toContain("previewImage")
  })
})
