import { describe, expect, test } from "bun:test"

const workspace = await Bun.file(new URL("./index.tsx", import.meta.url)).text()
const settings = await Bun.file(new URL("../../components/dialog-settings.tsx", import.meta.url)).text()
const composer = await Bun.file(new URL("./company-composer.tsx", import.meta.url)).text()
const layout = await Bun.file(new URL("../layout.tsx", import.meta.url)).text()

describe("Company shell integration contract", () => {
  test("uses a full navigation boundary between the Company and coding shells", () => {
    expect(workspace).toContain("window.location.assign(projectWorkspacePath(directory))")
    expect(layout).toContain("window.location.assign(companyWorkspacePath)")
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

  test("sends messages for real and redirects unsupported attachments to the project workspace", () => {
    expect(workspace).toContain("current.sendMessage(body)")
    expect(composer).toContain("当前 Company 会话暂不支持文件附件，可在项目工作台中附加文件")
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
})
