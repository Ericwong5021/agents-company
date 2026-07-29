import {
  ExperienceActionMutatesBusinessState,
  type ExperienceActionDescriptor,
  type ExperienceActionType,
} from "@agents-company/shared/experience"

// WORK-07 — 运行控制的纯逻辑：把投影层下发的 allowedActions 描述符映射为可渲染的控制动作，
// 保留每个动作真实的 enabled/disabledReason，并标注前端是否具备可执行的处理路径。
// 关键红线：不虚构可用控制。变更类动作只有在投影标记 enabled 且客户端有真实处理器时才可点击；
// R0 未解除时投影会把变更类动作标为 disabled，此处如实展示禁用原因，绝不伪装成可用。

export const actionLabels: Record<ExperienceActionType, string> = {
  continue_editing: "继续编辑",
  answer_question: "回答问题",
  start_work: "开始工作",
  adjust_brief: "调整方向",
  view_progress: "查看进展",
  pause_work: "暂停",
  resume_work: "恢复",
  stop_work: "停止",
  resolve_blocker: "处理阻塞",
  approve: "批准",
  reject: "驳回",
  request_change: "请求修改",
  view_evidence: "查看依据",
  view_revision: "查看返工",
  open_delivery: "打开交付",
  accept_delivery: "验收交付",
  retry: "重试",
  open_diagnostics: "打开诊断",
  view_retained_results: "查看保留成果",
  archive: "归档",
}

// 前端可执行的处理路径：导航/查看类在客户端内处理；变更类目前仅 retry 有 app 侧真实代理。
export type ClientActionHandler =
  | "navigate_progress"
  | "open_diagnostics"
  | "open_delivery"
  | "open_evidence"
  | "action"
  | "retry"
  | "none"

export function clientHandlerFor(id: ExperienceActionType): ClientActionHandler {
  if (id === "view_progress") return "navigate_progress"
  if (id === "open_diagnostics") return "open_diagnostics"
  if (id === "open_delivery") return "open_delivery"
  if (id === "view_evidence") return "open_evidence"
  if (id === "retry") return "retry"
  return "none"
}

export type ControlAction = {
  id: ExperienceActionType
  label: string
  enabled: boolean
  mutates: boolean
  handler: ClientActionHandler
  disabledReason?: string
}

export function toControlActions(descriptors: ExperienceActionDescriptor[]): ControlAction[] {
  return descriptors.map((descriptor) => ({
    id: descriptor.id,
    label: actionLabels[descriptor.id],
    enabled: descriptor.enabled,
    mutates: ExperienceActionMutatesBusinessState[descriptor.id],
    handler: descriptor.enabled
      ? ["pause_work", "resume_work", "stop_work", "resolve_blocker", "adjust_brief"].includes(descriptor.id)
        ? "action"
        : clientHandlerFor(descriptor.id)
      : "none",
    disabledReason: descriptor.enabled ? undefined : descriptor.disabledReason,
  }))
}

// 只有投影允许且客户端确有处理器的动作才允许点击，避免出现点了没反应或伪成功的按钮。
export function canInvoke(action: ControlAction): boolean {
  return action.enabled && action.handler !== "none"
}
