import { describe, expect, test } from "bun:test"

const component = await Bun.file(new URL("./project-room.tsx", import.meta.url)).text()

describe("ProjectRoom", () => {
  test("keeps project execution outside the board timeline", () => {
    expect(component).toContain('aria-label="项目室"')
    expect(component).toContain("动态任务树")
    expect(component).toContain("projectWorkTree")
  })

  test("shows dynamic roles, model economics, decision scope, and review state", () => {
    expect(component).not.toContain("PROJECT_AGENT")
    expect(component).toContain("模型路由")
    expect(component).toContain("模型成本")
    expect(component).toContain("决策范围")
    expect(component).toContain("REVIEW_LABEL")
  })

  test("opens real artifact content from a work item", () => {
    expect(component).toContain("selectedArtifacts")
    expect(component).toContain("artifact().content")
    expect(component).toContain("<Markdown")
  })

  test("routes governance gates back to the board", () => {
    expect(component).toContain("去董事会审批")
    expect(component).toContain("props.onOpenBoard")
  })
})
