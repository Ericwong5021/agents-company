import { describe, expect, test } from "bun:test"

const workspace = await Bun.file(new URL("./index.tsx", import.meta.url)).text()
const settings = await Bun.file(new URL("../../components/dialog-settings.tsx", import.meta.url)).text()
const composer = await Bun.file(new URL("./company-composer.tsx", import.meta.url)).text()

describe("Company shell integration contract", () => {
  test("does not expose a separate coding workspace", () => {
    expect(workspace).not.toContain("projectWorkspacePath")
    expect(workspace).not.toContain("onOpenProject")
  })

  test("keeps the current loopback browser entry direct", () => {
    expect(workspace).not.toContain("<BrowserPairing")
    expect(workspace).not.toContain('searchParams.has("pair")')
  })

  test("opens workspace-style settings without replacing the active conversation", () => {
    expect(workspace).toContain("dialog.show")
    expect(workspace).toContain('const openSettings = (defaultValue = "company")')
    expect(settings).toContain('class="company-settings-dialog"')
    expect(workspace).toContain('label: "公司概览"')
    expect(settings).toContain("extension().render()")
  })

  test("sends messages for real and keeps unsupported attachments disabled", () => {
    expect(workspace).toContain("referenced_thread_id: current.getOpenThreadID() ?? undefined")
    expect(composer).toContain("当前 Company 会话暂不支持文件附件")
    expect(composer).toContain("disabled")
  })

  test("forwards repository-scoped Company events instead of listening only to the global directory", () => {
    expect(workspace).toContain("globalSDK.event.listen")
    expect(workspace).not.toContain('globalSDK.event.on("global"')
  })

  test("routes a fresh conversation to the Board without restoring the previous thread", () => {
    expect(workspace).toContain('channel.kind === "board"')
    expect(workspace).toContain("setActiveChannel(board.id, { restoreLatestThread: false })")
  })

  test("lets the control plane resolve the configured global model for a new project", () => {
    expect(workspace).toContain(".startCompanyProject({ goal: boardGoal(), title: conversation().thread?.title })")
    expect(workspace).not.toContain(
      ".startCompanyProject({ goal: boardGoal(), title: conversation().thread?.title, ...executionModel })",
    )
  })
})
