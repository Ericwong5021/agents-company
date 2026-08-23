import { describe, expect, test } from "bun:test"
import {
  applyQuickIntent,
  canSubmit,
  composerIntentHint,
  composerQuickIntents,
  composerTargetLabel,
  draftStorageKey,
  MAX_COMPOSER_RESOURCES,
  MAX_MENTIONS,
  mentionOptions,
  parseComposerDraft,
  pathResource,
  resourceImpact,
  serializeComposerDraft,
  sendFailureText,
  shouldRotateRequestID,
  toggleMention,
  urlResource,
} from "../modules/agent-company/runtime/shared/company-composer"

// WORK-04 — 统一 Composer 的纯逻辑：目标标签、提及、幂等、草稿隔离与失败文案。

describe("composerTargetLabel / composerIntentHint", () => {
  test("董事会目标标签与意图提示", () => {
    expect(composerTargetLabel({ kind: "board" })).toBe("董事会")
    expect(composerIntentHint({ kind: "board" })).toContain("意图分类")
  })

  test("项目目标带项目标题，且提示不会创建新项目", () => {
    const target = { kind: "project", projectId: "prj-1", title: "官网改版" } as const
    expect(composerTargetLabel(target)).toBe("当前项目 · 官网改版")
    expect(composerIntentHint(target)).toContain("不会创建新项目")
  })
})

describe("mentionOptions", () => {
  test("来自真实名册并按 id 去重", () => {
    const options = mentionOptions([
      { id: "agt-1", name: "小张", role: "工程师" },
      { id: "agt-1", name: "小张", role: "工程师" },
      { id: "agt-2", name: "小李", role: undefined },
    ])
    expect(options).toEqual([
      { agentId: "agt-1", name: "小张", role: "工程师" },
      { agentId: "agt-2", name: "小李", role: undefined },
    ])
  })

  test("空名册返回空候选", () => {
    expect(mentionOptions([])).toEqual([])
  })
})

describe("toggleMention", () => {
  test("选中、取消选中", () => {
    expect(toggleMention([], "agt-1")).toEqual(["agt-1"])
    expect(toggleMention(["agt-1"], "agt-1")).toEqual([])
  })

  test("达到后端上限（20）后不再追加，但仍可取消已选项", () => {
    const full = Array.from({ length: MAX_MENTIONS }, (_, index) => `agt-${index}`)
    expect(toggleMention(full, "agt-extra")).toEqual(full)
    expect(toggleMention(full, "agt-0")).toHaveLength(MAX_MENTIONS - 1)
  })
})

describe("canSubmit", () => {
  test("空白内容或发送中不可提交", () => {
    expect(canSubmit({ body: "   ", sending: false })).toBe(false)
    expect(canSubmit({ body: "追问一下", sending: true })).toBe(false)
    expect(canSubmit({ body: "追问一下", sending: false })).toBe(true)
  })
})

describe("shouldRotateRequestID", () => {
  test("仅服务端确认接受后轮换；失败沿用同一 request_id 供幂等重试", () => {
    expect(shouldRotateRequestID("accepted")).toBe(true)
    expect(shouldRotateRequestID("failed")).toBe(false)
  })
})

describe("draftStorageKey", () => {
  test("草稿按发送目标隔离", () => {
    expect(draftStorageKey({ kind: "board" })).toBe("agent-company-composer:board")
    expect(draftStorageKey({ kind: "project", projectId: "prj-1", title: "官网改版" }))
      .toBe("agent-company-composer:project:prj-1")
    expect(draftStorageKey({ kind: "project", projectId: "prj-2", title: "另一个" }))
      .not.toBe(draftStorageKey({ kind: "project", projectId: "prj-1", title: "官网改版" }))
  })
})

describe("Composer resources", () => {
  test("persists structured drafts and remains compatible with body-only drafts", () => {
    const resources = [{ kind: "url" as const, url: "https://example.com" }]
    expect(parseComposerDraft(serializeComposerDraft("补充材料", resources))).toEqual({ body: "补充材料", resources })
    expect(parseComposerDraft("旧草稿")).toEqual({ body: "旧草稿", resources: [] })
  })

  test("accepts http resources and read-only local paths", () => {
    expect(urlResource("https://example.com/topic")).toEqual({ kind: "url", url: "https://example.com/topic" })
    expect(urlResource("file:///tmp/secret")).toBeUndefined()
    const path = pathResource("/tmp/content-methods", "directory")
    expect(path).toMatchObject({ kind: "path", resource_type: "directory", access: "read_only" })
    expect(path && resourceImpact(path)).toContain("不会提升文件权限")
    expect(MAX_COMPOSER_RESOURCES).toBe(8)
  })
})

describe("applyQuickIntent", () => {
  test("追加前缀且不重复叠加", () => {
    const prefix = composerQuickIntents[0].prefix
    expect(applyQuickIntent("聚焦移动端", prefix)).toBe(`${prefix}聚焦移动端`)
    expect(applyQuickIntent(`${prefix}聚焦移动端`, prefix)).toBe(`${prefix}聚焦移动端`)
  })

  test("三个快捷意图均为文本前缀，不虚构后端命令", () => {
    expect(composerQuickIntents.map((intent) => intent.id)).toEqual(["adjust", "constraint", "summary"])
    composerQuickIntents.forEach((intent) => expect(intent.prefix.endsWith("：")).toBe(true))
  })
})

describe("sendFailureText", () => {
  test("按真实状态码给出如实原因，并始终强调内容已保留", () => {
    expect(sendFailureText(403)).toContain("无权限或提及对象不在频道内")
    expect(sendFailureText(404)).toContain("不存在或已归档")
    expect(sendFailureText(409)).toContain("已提交过不同内容")
    expect(sendFailureText(503)).toContain("暂不可用")
    const cases = [401, 403, 404, 409, 503, 500, undefined]
    cases.forEach((status) => expect(sendFailureText(status)).toContain("内容已保留"))
  })

  test("失败文案不出现成功字样", () => {
    expect(sendFailureText(500)).not.toContain("成功")
    expect(sendFailureText(undefined)).not.toContain("成功")
  })
})
