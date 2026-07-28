import { describe, expect, test } from "bun:test"
import {
  actionLabels,
  canInvoke,
  clientHandlerFor,
  toControlActions,
} from "../modules/agent-company/runtime/shared/work-controls"
import type { ExperienceActionDescriptor } from "@agents-company/shared/experience"

// WORK-07 — 运行控制动作映射的纯逻辑：保留真实 enabled/disabledReason，只在有处理器时允许点击。

describe("actionLabels / clientHandlerFor", () => {
  test("每个动作类型都有中文标签", () => {
    expect(actionLabels.retry).toBe("重试")
    expect(actionLabels.stop_work).toBe("停止")
    expect(actionLabels.pause_work).toBe("暂停")
    expect(actionLabels.adjust_brief).toBe("调整方向")
  })

  test("导航/查看类与 retry 有客户端处理器，其余变更类为 none", () => {
    expect(clientHandlerFor("view_progress")).toBe("navigate_progress")
    expect(clientHandlerFor("open_diagnostics")).toBe("open_diagnostics")
    expect(clientHandlerFor("open_delivery")).toBe("open_delivery")
    expect(clientHandlerFor("view_evidence")).toBe("open_evidence")
    expect(clientHandlerFor("retry")).toBe("retry")
    expect(clientHandlerFor("pause_work")).toBe("none")
    expect(clientHandlerFor("stop_work")).toBe("none")
    expect(clientHandlerFor("approve")).toBe("none")
  })
})

describe("toControlActions", () => {
  test("保留投影下发的 enabled 与 disabledReason，并标注是否变更业务状态", () => {
    const descriptors: ExperienceActionDescriptor[] = [
      { id: "view_progress", enabled: true },
      { id: "stop_work", enabled: false, disabledReason: "运行控制尚未在本地实现" },
    ]
    const actions = toControlActions(descriptors)
    expect(actions[0]).toEqual({
      id: "view_progress",
      label: "查看进展",
      enabled: true,
      mutates: false,
      handler: "navigate_progress",
      disabledReason: undefined,
    })
    expect(actions[1]).toEqual({
      id: "stop_work",
      label: "停止",
      enabled: false,
      mutates: true,
      handler: "none",
      disabledReason: "运行控制尚未在本地实现",
    })
  })
})

describe("canInvoke", () => {
  test("仅在 enabled 且客户端有处理器时可点击", () => {
    expect(canInvoke({ id: "view_progress", label: "查看进展", enabled: true, mutates: false, handler: "navigate_progress" })).toBe(true)
    expect(canInvoke({ id: "retry", label: "重试", enabled: true, mutates: true, handler: "retry" })).toBe(true)
  })

  test("enabled 但无处理器不可点击（避免伪成功按钮）", () => {
    expect(canInvoke({ id: "approve", label: "批准", enabled: true, mutates: true, handler: "none" })).toBe(false)
  })

  test("有处理器但 disabled 不可点击", () => {
    expect(canInvoke({ id: "retry", label: "重试", enabled: false, mutates: true, handler: "retry", disabledReason: "尚未实现" })).toBe(false)
  })
})
