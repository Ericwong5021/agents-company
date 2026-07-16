import { describe, expect, test } from "bun:test"

const messageFeed = await Bun.file(new URL("./message-feed.tsx", import.meta.url)).text()
const workspace = await Bun.file(new URL("./workspace.css", import.meta.url)).text()

describe("Company Workspace visual contract", () => {
  test("keeps the message avatar column paired with a real avatar node", () => {
    expect(messageFeed).toContain('class="company-avatar-wrap"')
    expect(workspace.match(/\.company-message \{[\s\S]*?\n\}/)?.[0]).toContain(
      "grid-template-columns: 44px minmax(0, 1fr)",
    )
    expect(workspace).toContain(".company-message > .company-avatar-wrap")
  })

  test("lets the message feed fill the workspace above the composer", () => {
    expect(workspace.match(/\.company-feed \{[\s\S]*?\n\}/)?.[0]).toContain("flex: 1")
  })

  test("keeps the mobile channel wrapper out of the workspace grid", () => {
    expect(workspace.match(/\.company-channels-wrap \{[\s\S]*?\n\}/)?.[0]).toContain("display: contents")
    expect(workspace).toContain(".company-channels-wrap.mobile-open > .company-channels")
  })

  test("pins the approved desktop shell and Marvis settings geometry", () => {
    expect(workspace).toContain("grid-template-columns: 168px minmax(560px, 1fr) 426px")
    expect(workspace).toContain("width: min(calc(100vw - 32px), 646px)")
    expect(workspace).toContain("height: min(calc(100vh - 32px), 486px)")
  })

  test("styles every M2 state and metadata affordance explicitly", () => {
    const classes = [
      "company-channel-empty",
      "company-composer-error",
      "company-composer-input",
      "company-composer-mentions",
      "company-composer-retry",
      "company-composer-status",
      "company-feed-load-more",
      "company-message-dri",
      "company-message-pending",
      "company-message-signal",
      "company-mobile-channels-toggle",
      "company-sidebar-loading",
      "company-source-button",
      "company-thread-empty",
      "company-thread-interrupt",
      "company-thread-members",
      "company-thread-meta",
      "company-thread-status",
    ]

    classes.forEach((name) => expect(workspace).toContain(`.${name}`))
  })
})
