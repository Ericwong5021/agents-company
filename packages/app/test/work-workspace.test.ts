import { describe, expect, test } from "bun:test"
import {
  availableContextPanels,
  columnOrder,
  contextPanelOrder,
  defaultViewState,
  nextColumn,
  prevColumn,
  reconcileViewState,
  resolveActivePanel,
  viewStateFor,
  type WorkspaceViewState,
} from "../modules/agent-company/runtime/shared/work-workspace"

// WORK-02 — 右侧上下文面板派生、活动面板解析、窄屏列切换与切换项目防残留的纯逻辑。

const fullInput = {
  tasks: 5,
  hasGoalBrief: true,
  gates: 2,
  artifacts: 3,
  agents: 4,
  threadAvailable: true,
  diagnostics: 1,
}

describe("availableContextPanels", () => {
  test("仅在有真实数据时暴露对应面板，且遵循固定顺序", () => {
    expect(availableContextPanels(fullInput)).toEqual(contextPanelOrder)
  })

  test("空数据不制造面板", () => {
    expect(
      availableContextPanels({
        tasks: 0,
        hasGoalBrief: false,
        gates: 0,
        artifacts: 0,
        agents: 0,
        threadAvailable: false,
        diagnostics: 0,
      }),
    ).toEqual([])
  })

  test("部分数据只暴露有数据的面板", () => {
    expect(availableContextPanels({ ...fullInput, gates: 0, threadAvailable: false })).toEqual([
      "task",
      "goal_brief",
      "artifact",
      "agent",
      "diagnostics",
    ])
  })
})

describe("resolveActivePanel", () => {
  test("保留仍可用的偏好面板", () => {
    expect(resolveActivePanel("agent", ["goal_brief", "agent"])).toBe("agent")
  })

  test("偏好不可用时回退到第一个可用面板（切换项目防残留）", () => {
    expect(resolveActivePanel("approval", ["goal_brief", "artifact"])).toBe("goal_brief")
  })

  test("无可用面板时返回 undefined", () => {
    expect(resolveActivePanel("agent", [])).toBeUndefined()
  })
})

describe("窄屏列切换", () => {
  test("nextColumn 按 list→main→context 推进且到边界停止", () => {
    expect(nextColumn("list")).toBe("main")
    expect(nextColumn("main")).toBe("context")
    expect(nextColumn("context")).toBe("context")
  })

  test("prevColumn 反向推进且到边界停止", () => {
    expect(prevColumn("context")).toBe("main")
    expect(prevColumn("main")).toBe("list")
    expect(prevColumn("list")).toBe("list")
  })

  test("列顺序符合优先级定义", () => {
    expect(columnOrder).toEqual(["list", "main", "context"])
  })
})

describe("viewStateFor / reconcileViewState", () => {
  test("未知项目返回默认视图状态", () => {
    expect(viewStateFor({}, "p-x")).toEqual(defaultViewState())
  })

  test("按 projectID 隔离，互不串用", () => {
    const store: Record<string, WorkspaceViewState> = {
      "p-1": { column: "context", activePanel: "artifact", selectedArtifactID: "a-1" },
    }
    expect(viewStateFor(store, "p-1").selectedArtifactID).toBe("a-1")
    expect(viewStateFor(store, "p-2")).toEqual(defaultViewState())
  })

  test("校正丢弃当前项目不存在的选中制品与成员，并回退不可用面板", () => {
    const stale: WorkspaceViewState = {
      column: "context",
      activePanel: "approval",
      selectedArtifactID: "old-artifact",
      selectedAgentID: "old-agent",
      selectedWorkItemID: "old-work-item",
    }
    const reconciled = reconcileViewState(stale, ["goal_brief", "artifact"], {
      artifacts: [{ id: "new-artifact", title: "t", kind: "file", createdAt: 0 }],
      agents: [{ id: "new-agent" }],
      workItems: [{ id: "new-work-item" }],
    })
    expect(reconciled.column).toBe("context")
    expect(reconciled.activePanel).toBe("goal_brief")
    expect(reconciled.selectedArtifactID).toBeUndefined()
    expect(reconciled.selectedAgentID).toBeUndefined()
    expect(reconciled.selectedWorkItemID).toBeUndefined()
  })

  test("校正保留仍有效的选中项", () => {
    const state: WorkspaceViewState = {
      column: "main",
      activePanel: "artifact",
      selectedArtifactID: "a-1",
      selectedAgentID: "g-1",
      selectedWorkItemID: "w-1",
    }
    const reconciled = reconcileViewState(state, ["artifact", "agent"], {
      artifacts: [{ id: "a-1", title: "t", kind: "file", createdAt: 0 }],
      agents: [{ id: "g-1" }],
      workItems: [{ id: "w-1" }],
    })
    expect(reconciled.selectedArtifactID).toBe("a-1")
    expect(reconciled.selectedAgentID).toBe("g-1")
    expect(reconciled.selectedWorkItemID).toBe("w-1")
    expect(reconciled.activePanel).toBe("artifact")
  })
})
