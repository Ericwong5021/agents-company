import { describe, expect, test } from "bun:test"

const component = await Bun.file(new URL("./thread-panel.tsx", import.meta.url)).text()

describe("ThreadPanel", () => {
  test("exposes only the interrupt action, never approve/delegate", () => {
    // interrupt is the only structured M2 thread action; approve/delegate are
    // M3 governance and must not appear as a string-only stub.
    expect(component).toContain("onInterrupt")
    expect(component).toContain("company.thread.interrupt")
    expect(component).not.toMatch(/\/approve|approve.*thread|delegate/i)
  })

  test("thread status is text, not color-only", () => {
    expect(component).toContain("company-thread-status")
    expect(component).toContain("data-status")
    // Status label is resolved through i18n by the runtime status value
    expect(component).toContain("company.thread.status.${th().status}")
  })

  test("never renders fixture final-decision or approval cards", () => {
    expect(component).not.toContain("company-final-decision")
    expect(component).not.toContain("company-approval")
  })

  test("interrupt is disabled for terminal thread states", () => {
    // interrupted/completed threads must not be interruptible again
    expect(component).toContain("th().status === \"interrupted\"")
    expect(component).toContain("th().status === \"completed\"")
  })

  test("entries come from the snapshot, with on-demand load-more", () => {
    expect(component).toContain("props.entries")
    expect(component).toContain("onLoadMore")
    expect(component).toContain("company.thread.loadMore")
  })
})
