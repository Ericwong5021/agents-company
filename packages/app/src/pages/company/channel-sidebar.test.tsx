import { describe, expect, test } from "bun:test"

const component = await Bun.file(new URL("./channel-sidebar.tsx", import.meta.url)).text()

describe("ChannelSidebar", () => {
  test("renders only real channel kinds and never Direct/department sections", () => {
    // M2 opens company/board/project only; Direct and department stay closed
    // until M5. The sidebar must not render those group headings.
    expect(component).toContain("company")
    expect(component).toContain("board")
    expect(component).toContain("project")
    expect(component).not.toContain('"direct"')
    expect(component).not.toContain('"department"')
  })

  test("has no client-side channel creation affordance", () => {
    // ensureProjectChannel is the only creation path; the UI must not offer
    // a create/new-channel button. Check for absence of a creation button class
    // and absence of any onClick that creates a channel.
    expect(component).not.toContain("company-channel-create")
    expect(component).not.toContain("createChannel")
    expect(component).not.toContain("aria-label=\"新建频道\"")
  })

  test("renders an empty group placeholder instead of faking channels", () => {
    expect(component).toContain("company-channel-empty")
  })

  test("channels come from a snapshot accessor, not a hardcoded list", () => {
    expect(component).toContain("props.channels")
    expect(component).not.toContain("pre-public-webui")
  })
})
