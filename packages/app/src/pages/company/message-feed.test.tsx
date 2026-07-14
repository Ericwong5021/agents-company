import { describe, expect, test } from "bun:test"

const component = await Bun.file(new URL("./message-feed.tsx", import.meta.url)).text()

describe("MessageFeed", () => {
  test("only badges the four real M2 high-signal types", () => {
    // conclusion/status/risk/intervention are the only signals M2 runtime may
    // produce. The HIGH_SIGNAL set is the source of truth for badge eligibility.
    const highSignalSet = component.match(/const HIGH_SIGNAL[\s\S]*?\)/)?.[0] ?? ""
    expect(highSignalSet).toContain('"conclusion"')
    expect(highSignalSet).toContain('"status"')
    expect(highSignalSet).toContain('"risk"')
    expect(highSignalSet).toContain('"intervention"')
    // decision/approval/delivery/plan need M3 facts and must not badge
    expect(highSignalSet).not.toContain('"decision"')
    expect(highSignalSet).not.toContain('"approval"')
    expect(highSignalSet).not.toContain('"delivery"')
    expect(highSignalSet).not.toContain('"plan"')
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
