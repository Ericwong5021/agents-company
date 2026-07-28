import { describe, expect, test } from "bun:test"
import { Glob } from "bun"

// GOAL-05 — 删除强制大型 Charter 表单与 Markdown 解析回退。
//
// 这是一个静态守卫：确保旧的 Markdown Charter 解析器（从 **价值**、**范围**、**DRI**
// 等标题提取结构，并把目标文本复制进多个字段）不再出现在任何生产路径的页面/组件里，
// 也防止后续回归。目标从输入到执行只走结构化 Goal Brief。

const appRoot = new URL("../", import.meta.url).pathname
const productionDirs = ["app", "modules/agent-company/runtime"]
// charterSection / prepareCharter 是旧 Markdown 解析器与目标复制逻辑的专有符号。
const legacyParserSymbols = ["charterSection", "prepareCharter"]

async function filesReferencingLegacyParser() {
  const glob = new Glob("**/*.{vue,ts}")
  const hits: string[] = []
  for (const dir of productionDirs) {
    for await (const relative of glob.scan({ cwd: `${appRoot}${dir}` })) {
      const text = await Bun.file(`${appRoot}${dir}/${relative}`).text()
      if (legacyParserSymbols.some((symbol) => text.includes(symbol))) hits.push(`${dir}/${relative}`)
    }
  }
  return hits
}

describe("GOAL-05 legacy Charter/Markdown 解析器移除", () => {
  test("生产路径不再引用旧 Markdown Charter 解析器", async () => {
    expect(await filesReferencingLegacyParser()).toEqual([])
  })

  test("旧的大型 Charter 立项表单页面已删除", async () => {
    const legacyBoardPage = `${appRoot}modules/agent-company/runtime/app/pages/company/board.vue`
    expect(await Bun.file(legacyBoardPage).exists()).toBe(false)
  })
})
