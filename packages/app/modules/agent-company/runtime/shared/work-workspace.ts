import type { CompanyProjectDetail } from "./company-contract"

// WORK-02 — 三栏高信号工作区的纯逻辑：右侧上下文面板派生、活动面板解析、
// 窄屏列优先级切换，以及切换项目时防止上一项目上下文残留。
// 保持纯函数、无副作用，可脱离 Vue 单测。

export type ContextPanelKind = "goal_brief" | "approval" | "artifact" | "agent" | "thread" | "diagnostics"

// 右侧上下文面板固定展示顺序（Goal Brief、Approval、Artifact、Agent、Thread、Diagnostics）。
export const contextPanelOrder: ContextPanelKind[] = [
  "goal_brief",
  "approval",
  "artifact",
  "agent",
  "thread",
  "diagnostics",
]

export const contextPanelLabels: Record<ContextPanelKind, string> = {
  goal_brief: "目标",
  approval: "审批",
  artifact: "制品",
  agent: "成员",
  thread: "讨论",
  diagnostics: "诊断",
}

// 派生右侧面板可用性只依据真实数据存在与否，空数据不制造面板。
export type ContextPanelInput = {
  hasGoalBrief: boolean
  gates: number
  artifacts: number
  agents: number
  threadAvailable: boolean
  diagnostics: number
}

export function availableContextPanels(input: ContextPanelInput): ContextPanelKind[] {
  return contextPanelOrder.filter((kind) => {
    if (kind === "goal_brief") return input.hasGoalBrief
    if (kind === "approval") return input.gates > 0
    if (kind === "artifact") return input.artifacts > 0
    if (kind === "agent") return input.agents > 0
    if (kind === "thread") return input.threadAvailable
    return input.diagnostics > 0
  })
}

// 解析当前活动面板：优先保留用户偏好，偏好在当前项目不可用时回退到第一个可用面板。
export function resolveActivePanel(
  preferred: ContextPanelKind | undefined,
  available: ContextPanelKind[],
): ContextPanelKind | undefined {
  if (preferred && available.includes(preferred)) return preferred
  return available[0]
}

// 窄屏按 Work list → Main → Context 优先级切换，不简单压缩三栏。
export type WorkspaceColumn = "list" | "main" | "context"

export const columnOrder: WorkspaceColumn[] = ["list", "main", "context"]

export function nextColumn(current: WorkspaceColumn): WorkspaceColumn {
  const index = columnOrder.indexOf(current)
  return columnOrder[Math.min(index + 1, columnOrder.length - 1)] ?? current
}

export function prevColumn(current: WorkspaceColumn): WorkspaceColumn {
  const index = columnOrder.indexOf(current)
  return columnOrder[Math.max(index - 1, 0)] ?? current
}

// 每个项目独立保存的视图状态，键为 projectID，确保切换项目时互不串用。
export type WorkspaceViewState = {
  column: WorkspaceColumn
  activePanel?: ContextPanelKind
  selectedArtifactID?: string
  selectedAgentID?: string
}

export function defaultViewState(): WorkspaceViewState {
  return { column: "main" }
}

export function viewStateFor(
  store: Record<string, WorkspaceViewState>,
  projectID: string,
): WorkspaceViewState {
  return store[projectID] ?? defaultViewState()
}

type ReconcileInput = {
  artifacts: CompanyProjectDetail["artifacts"]
  agents: { id: string }[]
}

// 依据当前项目真实数据校正视图状态：丢弃在本项目不存在的选中制品/成员与不可用面板，
// 从根本上避免显示上一项目的残留上下文。
export function reconcileViewState(
  state: WorkspaceViewState,
  available: ContextPanelKind[],
  detail: ReconcileInput,
): WorkspaceViewState {
  const artifactValid = state.selectedArtifactID
    ? detail.artifacts.some((artifact) => artifact.id === state.selectedArtifactID)
    : false
  const agentValid = state.selectedAgentID
    ? detail.agents.some((agent) => agent.id === state.selectedAgentID)
    : false
  return {
    column: state.column,
    activePanel: resolveActivePanel(state.activePanel, available),
    selectedArtifactID: artifactValid ? state.selectedArtifactID : undefined,
    selectedAgentID: agentValid ? state.selectedAgentID : undefined,
  }
}
