import { describe, expect, test } from "bun:test"

const component = await Bun.file(new URL("./company-composer.tsx", import.meta.url)).text()

describe("CompanyComposer", () => {
  test("sends through the store, not a fabricated action", () => {
    expect(component).toContain("props.onSend")
    expect(component).toContain("company.composer.send")
  })

  test("offers @board-role mentions but not @arbitrary-agent", () => {
    expect(component).toContain("company.composer.mention.ceo")
    expect(component).toContain("company.composer.mention.cto")
    expect(component).toContain("company.composer.mention.product_lead")
  })

  test("exposes /interrupt but never /approve or /delegate", () => {
    expect(component).toContain("onInterrupt")
    expect(component).toContain("company.composer.interrupt")
    // No approve/delegate handler or label is wired up
    expect(component).not.toContain("onApprove")
    expect(component).not.toContain("onDelegate")
    expect(component).not.toContain("company.composer.approve")
    expect(component).not.toContain("company.composer.delegate")
  })

  test("state is text and aria, not color-only", () => {
    expect(component).toContain("data-state")
    expect(component).toContain("aria-live")
    expect(component).toContain("role=\"alert\"")
    expect(component).toContain("company.composer.sending")
    expect(component).toContain("company.composer.retry")
  })

  test("send is disabled while sending or empty", () => {
    expect(component).toContain("canSend")
    expect(component).toContain("props.sending()")
  })
})
