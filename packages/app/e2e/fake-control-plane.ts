import { mkdir, rename } from "node:fs/promises"
import path from "node:path"
import {
  ExperienceActionMutatesBusinessState,
  ExperienceAllowedActionTypes,
  ExperienceArtifactView,
  ExperienceNeedsUserAction,
  GoalBrief,
  GoalBriefProjectView,
  GoalBriefStructuredFailure,
  WorkProjectionList,
  type ExperienceActionDescriptor,
  type ExperienceActionType,
  type ExperienceUserStatus,
} from "@agents-company/shared/experience"

const updatedAt = "2026-07-25T09:00:00.000Z"
const sourceRefs = (workID: string) => [{ kind: "project" as const, id: workID }]
function action(workID: string, id: ExperienceActionType, enabled: boolean): ExperienceActionDescriptor {
  const targetRef = { kind: "project" as const, id: workID }
  if (enabled) return { id, targetRef, enabled: true }
  return {
    id,
    targetRef,
    enabled: false,
    disabledReason: "当前版本仅提供只读查看。",
  }
}
const reason = (workID: string, text: string) => ({
  availability: "known" as const,
  text,
  sourceRefs: sourceRefs(workID),
})
const runningActions = [
  action("project-running", "view_progress", true),
  action("project-running", "pause_work", false),
  action("project-running", "stop_work", false),
]
const blockedActions = [
  action("project-blocked", "resolve_blocker", false),
  action("project-blocked", "open_diagnostics", true),
  action("project-blocked", "stop_work", false),
]
const deliveredActions = [
  action("project-delivered", "open_delivery", true),
  action("project-delivered", "accept_delivery", false),
  action("project-delivered", "request_change", false),
  action("project-delivered", "view_evidence", true),
]
const gateActions = [
  action("project-gate", "approve", false),
  action("project-gate", "reject", false),
  action("project-gate", "request_change", false),
  action("project-gate", "open_diagnostics", true),
]
const briefActions = [
  action("project-brief", "start_work", false),
  action("project-brief", "adjust_brief", false),
]
const work = WorkProjectionList.parse({
  items: [
    {
      availability: "available",
      projectorVersion: 1,
      sourceWatermark: "a".repeat(64),
      summary: {
        workId: "project-running",
        title: "准备本地发布",
        userStatus: "running",
        phase: "执行",
        owner: { id: "agent-1", name: "小岚" },
        nextMilestone: { id: "milestone-2", title: "完成发布检查", completed: false },
        needsUserAction: false,
        reason: reason("project-running", "发布检查正在执行，目前不需要用户处理。"),
        nextAction: runningActions[0],
        updatedAt,
        sourceRefs: sourceRefs("project-running"),
        allowedActions: runningActions,
      },
      progress: {
        workId: "project-running",
        userStatus: "running",
        phase: "执行",
        completedItems: 1,
        totalItems: 3,
        percent: 33,
        reason: reason("project-running", "发布检查正在执行，目前不需要用户处理。"),
        nextAction: runningActions[0],
        updatedAt,
        sourceRefs: sourceRefs("project-running"),
        allowedActions: runningActions,
      },
      attentionItems: [],
      diagnostics: [],
    },
    {
      availability: "available",
      projectorVersion: 1,
      sourceWatermark: "b".repeat(64),
      summary: {
        workId: "project-blocked",
        title: "整理验收证据",
        userStatus: "blocked",
        phase: "执行",
        owner: { id: "agent-1", name: "小岚" },
        needsUserAction: true,
        reason: reason("project-blocked", "缺少一项发布凭据，工作无法继续。"),
        nextAction: blockedActions[1],
        updatedAt,
        sourceRefs: sourceRefs("project-blocked"),
        allowedActions: blockedActions,
      },
      progress: {
        workId: "project-blocked",
        userStatus: "blocked",
        phase: "执行",
        completedItems: 2,
        totalItems: 3,
        percent: 67,
        reason: reason("project-blocked", "缺少一项发布凭据，工作无法继续。"),
        nextAction: blockedActions[1],
        updatedAt,
        sourceRefs: sourceRefs("project-blocked"),
        allowedActions: blockedActions,
      },
      attentionItems: [
        {
          id: "attention-blocked",
          type: "blocked",
          workId: "project-blocked",
          title: "补充发布凭据",
          reason: reason("project-blocked", "验收流程没有找到发布凭据。"),
          impact: "在凭据补齐前无法完成验收。",
          recommendedAction: blockedActions[1],
          priority: "high",
          updatedAt,
          sourceRefs: sourceRefs("project-blocked"),
          allowedActions: blockedActions,
        },
      ],
      diagnostics: [
        {
          id: "diagnostic-missing-evidence",
          code: "missing_fact",
          message: "交付事实缺少对应 Artifact。",
          sourceRef: { kind: "project", id: "project-blocked" },
        },
      ],
    },
    {
      availability: "available",
      projectorVersion: 1,
      sourceWatermark: "c".repeat(64),
      summary: {
        workId: "project-delivered",
        title: "输出体验审查报告",
        userStatus: "delivered",
        phase: "交付",
        owner: { id: "agent-1", name: "小岚" },
        needsUserAction: true,
        reason: reason("project-delivered", "已形成可查看和验收的交付成果。"),
        nextAction: deliveredActions[0],
        updatedAt,
        sourceRefs: sourceRefs("project-delivered"),
        allowedActions: deliveredActions,
      },
      progress: {
        workId: "project-delivered",
        userStatus: "delivered",
        phase: "交付",
        completedItems: 2,
        totalItems: 2,
        percent: 100,
        reason: reason("project-delivered", "已形成可查看和验收的交付成果。"),
        nextAction: deliveredActions[0],
        updatedAt,
        sourceRefs: sourceRefs("project-delivered"),
        allowedActions: deliveredActions,
      },
      attentionItems: [
        {
          id: "attention-delivery",
          type: "delivery",
          workId: "project-delivered",
          title: "验收体验审查报告",
          reason: reason("project-delivered", "报告已完成并等待验收。"),
          impact: "验收后本次工作将进入已接受状态。",
          recommendedAction: deliveredActions[0],
          priority: "normal",
          updatedAt,
          sourceRefs: sourceRefs("project-delivered"),
          allowedActions: deliveredActions,
        },
      ],
      delivery: {
        id: "delivery-project-delivered-1",
        workId: "project-delivered",
        version: 1,
        acceptanceState: "pending",
        artifacts: [{
          id: "artifact-report",
          projectId: "project-delivered",
          kind: "report",
          title: "体验审查报告",
          href: "/experience/projects/project-delivered/artifacts/artifact-report",
        }],
        reason: reason("project-delivered", "体验审查报告已完成并保留来源。"),
        nextAction: deliveredActions[0],
        updatedAt,
        sourceRefs: sourceRefs("project-delivered"),
        allowedActions: deliveredActions,
      },
      diagnostics: [],
    },
    {
      availability: "available",
      projectorVersion: 1,
      sourceWatermark: "f".repeat(64),
      summary: {
        workId: "project-brief",
        title: "定义本地研究交付",
        userStatus: "ready",
        phase: "目标确认",
        owner: { id: "agent-2", name: "阿衡" },
        nextMilestone: { id: "milestone-brief", title: "进入可控执行", completed: false },
        needsUserAction: true,
        reason: reason("project-brief", "目标、交付内容与验收标准已经确认，可以进入后续执行阶段。"),
        nextAction: null,
        updatedAt,
        sourceRefs: sourceRefs("project-brief"),
        allowedActions: briefActions,
      },
      progress: {
        workId: "project-brief",
        userStatus: "ready",
        phase: "目标确认",
        completedItems: 0,
        totalItems: 3,
        percent: 0,
        reason: reason("project-brief", "目标、交付内容与验收标准已经确认，可以进入后续执行阶段。"),
        nextAction: null,
        updatedAt,
        sourceRefs: sourceRefs("project-brief"),
        allowedActions: briefActions,
      },
      attentionItems: [],
      diagnostics: [],
    },
    {
      availability: "available",
      projectorVersion: 1,
      sourceWatermark: "d".repeat(64),
      summary: {
        workId: "project-gate",
        title: "发布候选版本",
        userStatus: "needs_approval",
        phase: "发布审批",
        owner: { id: "agent-1", name: "小岚" },
        nextMilestone: { id: "milestone-gate", title: "完成发布审批", completed: false },
        needsUserAction: true,
        reason: reason("project-gate", "发布候选已形成，等待人工审批后才能继续。"),
        nextAction: gateActions[3],
        updatedAt,
        sourceRefs: sourceRefs("project-gate"),
        allowedActions: gateActions,
      },
      progress: {
        workId: "project-gate",
        userStatus: "needs_approval",
        phase: "发布审批",
        completedItems: 4,
        totalItems: 4,
        percent: 100,
        reason: reason("project-gate", "发布候选已形成，等待人工审批后才能继续。"),
        nextAction: gateActions[3],
        updatedAt,
        sourceRefs: sourceRefs("project-gate"),
        allowedActions: gateActions,
      },
      attentionItems: [
        {
          id: "attention-gate",
          type: "approval",
          workId: "project-gate",
          title: "审查发布候选",
          reason: reason("project-gate", "发布候选正在等待人工决定。"),
          impact: "在审批完成前，候选版本不会进入发布流程。",
          recommendedAction: gateActions[3],
          priority: "critical",
          updatedAt,
          sourceRefs: sourceRefs("project-gate"),
          allowedActions: gateActions,
        },
      ],
      diagnostics: [],
    },
    {
      availability: "unavailable",
      projectorVersion: 1,
      sourceWatermark: "e".repeat(64),
      workId: "project-unavailable",
      title: "恢复未知工作",
      updatedAt,
      reason: {
        availability: "unavailable",
        text: "当前原因不可用",
        diagnosticIds: ["diagnostic-unavailable"],
      },
      diagnostics: [
        {
          id: "diagnostic-unavailable",
          code: "missing_fact",
          message: "缺少决定当前状态所需的事实。",
          sourceRef: { kind: "project", id: "project-unavailable" },
        },
      ],
    },
  ],
})
const hr01States = [
  {
    promptId: "HR01-P01",
    status: "needs_input",
    title: "地区范围尚未确定",
    phase: "目标核对",
    reasonText: "目标缺少必须确认的地区范围，继续执行可能产出错误结论。请先回答地区范围问题。",
    completedItems: 0,
    totalItems: 4,
    nextAction: null,
    deliveryState: null,
  },
  {
    promptId: "HR01-P02",
    status: "ready",
    title: "本地研究交付",
    phase: "目标确认",
    reasonText: "交付内容、来源边界和验收标准已经明确。现在可以开始执行，也可以先调整 Brief。",
    completedItems: 0,
    totalItems: 4,
    nextAction: null,
    deliveryState: null,
  },
  {
    promptId: "HR01-P03",
    status: "running",
    title: "核验本地发布路径",
    phase: "执行",
    reasonText: "团队正在已确认的范围内执行，目前不需要用户处理。可以查看进展，必要时停止在当前检查点。",
    completedItems: 2,
    totalItems: 4,
    nextAction: "view_progress",
    deliveryState: null,
  },
  {
    promptId: "HR01-P04",
    status: "paused",
    title: "市场资料核验",
    phase: "执行控制",
    reasonText: "执行已停止在可恢复检查点，期间不会产生新的执行。可以恢复、调整目标或停止工作。",
    completedItems: 2,
    totalItems: 4,
    nextAction: null,
    deliveryState: null,
  },
  {
    promptId: "HR01-P05",
    status: "blocked",
    title: "整理验收证据",
    phase: "依赖处理",
    reasonText: "缺少发布凭据，工作在补齐前无法继续。请先解决这项凭据问题，也可以查看诊断依据。",
    completedItems: 2,
    totalItems: 4,
    nextAction: "open_diagnostics",
    deliveryState: null,
  },
  {
    promptId: "HR01-P06",
    status: "needs_approval",
    title: "发布候选版本",
    phase: "高影响决策",
    reasonText: "外部发布会改变用户可见状态，正在等待明确决定。请批准、拒绝或要求修改后再继续。",
    completedItems: 3,
    totalItems: 4,
    nextAction: null,
    deliveryState: null,
  },
  {
    promptId: "HR01-P07",
    status: "reviewing",
    title: "体验审查报告",
    phase: "独立核验",
    reasonText: "独立审查人正在按验收标准核对结果，当前还不能接受交付。证据可用时可以直接查看。",
    completedItems: 4,
    totalItems: 5,
    nextAction: "view_evidence",
    deliveryState: null,
  },
  {
    promptId: "HR01-P08",
    status: "revision",
    title: "体验审查报告",
    phase: "质量修正",
    reasonText: "前一版缺少两项来源引用，团队正按明确发现修改。可以查看要求修改的范围和已完成变化。",
    completedItems: 3,
    totalItems: 5,
    nextAction: "view_revision",
    deliveryState: "revision_requested",
  },
  {
    promptId: "HR01-P09",
    status: "delivered",
    title: "体验审查报告",
    phase: "交付验收",
    reasonText: "可用报告和验证证据已经形成，正在等待按标准验收。可以打开交付、接受或要求修改。",
    completedItems: 5,
    totalItems: 5,
    nextAction: "open_delivery",
    deliveryState: "pending",
  },
  {
    promptId: "HR01-P10",
    status: "accepted",
    title: "体验审查报告",
    phase: "交付完成",
    reasonText: "用户已经明确确认交付符合标准，本次验收生命周期完成。现在可以使用结果或将其归档。",
    completedItems: 5,
    totalItems: 5,
    nextAction: "open_delivery",
    deliveryState: "accepted",
  },
  {
    promptId: "HR01-P11",
    status: "failed",
    title: "生成来源索引",
    phase: "执行恢复",
    reasonText: "本次执行在生成来源索引时终止，无法自动继续。请重试、检查诊断或停止这项工作。",
    completedItems: 2,
    totalItems: 4,
    nextAction: "open_diagnostics",
    deliveryState: null,
  },
  {
    promptId: "HR01-P12",
    status: "cancelled",
    title: "竞品资料整理",
    phase: "工作收尾",
    reasonText: "用户已经停止这项工作，不会再发生新的执行，先前证据仍被保留。可以查看保留结果或归档。",
    completedItems: 2,
    totalItems: 4,
    nextAction: "view_retained_results",
    deliveryState: null,
  },
] as const satisfies readonly {
  promptId: string
  status: ExperienceUserStatus
  title: string
  phase: string
  reasonText: string
  completedItems: number
  totalItems: number
  nextAction: ExperienceActionType | null
  deliveryState: "pending" | "accepted" | "revision_requested" | null
}[]
const hr01Work = WorkProjectionList.parse({
  items: hr01States.map((item, index) => {
    const workID = `hr01-${item.status.replaceAll("_", "-")}`
    const allowedActions = ExperienceAllowedActionTypes[item.status].map(id =>
      action(workID, id, !ExperienceActionMutatesBusinessState[id]))
    const nextAction = item.nextAction
      ? allowedActions.find(candidate => candidate.id === item.nextAction && candidate.enabled) ?? null
      : null
    return {
      availability: "available",
      projectorVersion: 1,
      sourceWatermark: (index + 1).toString(16).padStart(64, "0"),
      summary: {
        workId: workID,
        title: item.title,
        userStatus: item.status,
        phase: item.phase,
        owner: { id: "agent-1", name: "小岚" },
        needsUserAction: ExperienceNeedsUserAction[item.status],
        reason: reason(workID, item.reasonText),
        nextAction,
        updatedAt,
        sourceRefs: sourceRefs(workID),
        allowedActions,
      },
      progress: {
        workId: workID,
        userStatus: item.status,
        phase: item.phase,
        completedItems: item.completedItems,
        totalItems: item.totalItems,
        percent: Math.round((item.completedItems / item.totalItems) * 100),
        reason: reason(workID, item.reasonText),
        nextAction,
        updatedAt,
        sourceRefs: sourceRefs(workID),
        allowedActions,
      },
      attentionItems: [],
      ...(item.deliveryState
        ? {
            delivery: {
              id: `delivery-${workID}`,
              workId: workID,
              version: item.deliveryState === "revision_requested" ? 2 : 1,
              acceptanceState: item.deliveryState,
              artifacts: [{
                id: `artifact-${workID}`,
                projectId: workID,
                kind: "report",
                title: "体验审查报告",
                href: `/experience/projects/${workID}/artifacts/artifact-${workID}`,
              }],
              reason: reason(workID, item.reasonText),
              nextAction,
              updatedAt,
              sourceRefs: sourceRefs(workID),
              allowedActions,
            },
          }
        : {}),
      diagnostics: [],
    }
  }),
})
const longReason = reason(
  "project-running",
  "这是一段用于验证长内容布局的真实状态说明，包含本地执行证据、依赖关系、风险边界与下一步处理依据。".repeat(18),
)
const longWork = WorkProjectionList.parse({
  items: work.items.map((item) => item.availability === "available"
    && item.summary.workId === "project-running"
    ? {
        ...item,
        summary: {
          ...item.summary,
          title: "准备本地发布并核验完整依赖关系与可追溯交付证据".repeat(3),
          reason: longReason,
        },
        progress: {
          ...item.progress,
          reason: longReason,
        },
      }
    : item),
})

const gateBrief = GoalBriefProjectView.parse({
  kind: "goal_brief",
  brief: {
    id: "goalBrief_project-gate",
    version: 2,
    projectId: "project-gate",
    source: "user_confirmation",
    createdAt: updatedAt,
    goal: "形成可审批的本地发布候选，并保留完整验证证据。",
    deliverables: [
      {
        id: "deliverable-release",
        title: "发布候选",
        description: "可在本地复现并进入人工审批的候选版本。",
      },
      {
        id: "deliverable-evidence",
        title: "验证证据",
        description: "构建、测试与契约校验形成的可追溯证据。",
      },
    ],
    acceptanceCriteria: [
      {
        id: "criterion-build",
        description: "候选版本通过生产构建。",
        verification: "保存构建结果并关联发布候选。",
      },
      {
        id: "criterion-gate",
        description: "业务发布必须等待人工审批。",
        verification: "审批前不得执行发布动作。",
      },
    ],
    constraints: ["仅使用本地服务", "当前版本仅提供只读查看"],
    nonGoals: ["不执行真实发布"],
    assumptions: [
      {
        id: "assumption-local",
        description: "本地运行环境可访问必要依赖。",
        confirmed: true,
      },
    ],
    openQuestions: [],
    riskLevel: "high",
    recommendedPlan: {
      summary: "先完成候选验证，再进入人工审批。",
      steps: [
        {
          id: "step-verify",
          title: "验证候选",
          outcome: "形成可追溯的构建与测试证据。",
        },
        {
          id: "step-approval",
          title: "等待审批",
          outcome: "人工决定是否允许后续发布。",
        },
      ],
    },
    approvalMode: "strict",
    sourceRefs: sourceRefs("project-gate"),
  },
})

const readyBrief = GoalBriefProjectView.parse({
  kind: "goal_brief",
  brief: {
    ...gateBrief.brief,
    id: "goalBrief_project-brief",
    version: 1,
    projectId: "project-brief",
    source: "user_input",
    goal: "让本地 AI 团队完成一份可验证的研究交付。",
    deliverables: [
      {
        id: "deliverable-research",
        title: "研究报告",
        description: "包含结论、来源与未解决问题的结构化报告。",
      },
      {
        id: "deliverable-source-index",
        title: "来源索引",
        description: "每项关键结论都能回到原始证据。",
      },
    ],
    acceptanceCriteria: [
      {
        id: "criterion-traceability",
        description: "关键结论具备可追溯来源。",
        verification: "逐项抽查结论与来源引用。",
      },
      {
        id: "criterion-boundary",
        description: "未知信息与假设被明确标注。",
        verification: "检查报告中的边界与未解决问题。",
      },
    ],
    constraints: ["仅使用本地可读取的真实材料", "不把未知事实补成确定结论"],
    nonGoals: ["不执行外部发布"],
    assumptions: [],
    riskLevel: "medium",
    recommendedPlan: {
      summary: "先建立来源索引，再形成结论并逐项验证。",
      steps: [
        {
          id: "step-index",
          title: "整理来源",
          outcome: "形成可检索的证据索引。",
        },
        {
          id: "step-report",
          title: "形成报告",
          outcome: "输出经过来源核验的研究结论。",
        },
      ],
    },
    approvalMode: "balanced",
    sourceRefs: sourceRefs("project-brief"),
  },
})

const runningBrief = GoalBriefProjectView.parse({
  kind: "goal_brief",
  brief: {
    ...readyBrief.brief,
    id: "goalBrief_project-running",
    projectId: "project-running",
    source: "user_confirmation",
    goal: "完成本地发布前检查，并保留每项检查的可追溯证据。",
    deliverables: [
      {
        id: "deliverable-release-check",
        title: "发布检查结果",
        description: "记录构建、配置与关键用户路径的检查结论。",
      },
      {
        id: "deliverable-release-evidence",
        title: "检查证据",
        description: "每项结论都关联可复核的本地证据。",
      },
    ],
    acceptanceCriteria: [
      {
        id: "criterion-release-path",
        description: "关键用户路径可在本地完成。",
        verification: "逐项执行并保存通过结果。",
      },
      {
        id: "criterion-release-evidence",
        description: "所有检查结论均有证据。",
        verification: "核对结论与证据引用。",
      },
    ],
    constraints: ["仅使用本地可验证状态", "不隐藏失败检查"],
    nonGoals: ["不执行外部发布"],
    assumptions: [],
    openQuestions: [],
    riskLevel: "medium",
    recommendedPlan: {
      summary: "依次完成构建、配置与关键路径检查。",
      steps: [
        {
          id: "step-build-check",
          title: "检查构建",
          outcome: "确认生产构建可复现。",
        },
        {
          id: "step-path-check",
          title: "检查关键路径",
          outcome: "确认用户可完成核心任务。",
        },
      ],
    },
    approvalMode: "balanced",
    sourceRefs: sourceRefs("project-running"),
  },
})

const deliveredBrief = GoalBriefProjectView.parse({
  kind: "goal_brief",
  brief: {
    ...readyBrief.brief,
    id: "goalBrief_project-delivered",
    projectId: "project-delivered",
    source: "user_confirmation",
    goal: "形成一份可直接查看、具备来源并可按标准验收的体验审查报告。",
    deliverables: [
      {
        id: "deliverable-experience-report",
        title: "体验审查报告",
        description: "汇总关键发现、验证证据与后续建议。",
      },
    ],
    acceptanceCriteria: [
      {
        id: "criterion-report-openable",
        description: "报告可直接打开并阅读。",
        verification: "从交付区打开报告并核对正文。",
      },
      {
        id: "criterion-report-evidence",
        description: "关键结论保留来源。",
        verification: "抽查结论与证据引用。",
      },
    ],
    constraints: ["保留验证边界", "不把未知信息写成确定结论"],
    nonGoals: ["不自动接受交付"],
    assumptions: [],
    openQuestions: [],
    riskLevel: "low",
    recommendedPlan: {
      summary: "打开报告，按验收标准核对正文与来源。",
      steps: [
        {
          id: "step-open-report",
          title: "打开报告",
          outcome: "确认交付内容可读取。",
        },
        {
          id: "step-review-report",
          title: "核对证据",
          outcome: "确认关键结论具备来源。",
        },
      ],
    },
    approvalMode: "balanced",
    sourceRefs: sourceRefs("project-delivered"),
  },
})

const reportContent = [
  "# 体验审查报告",
  "",
  "## 结论",
  "",
  "核心路径已完成审查，交付状态与证据来源均可追溯。",
  "",
  "## 验证证据",
  "",
  "- 生产构建通过",
  "- 关键路径自动验收通过",
  "- 失败与边界状态均有明确说明",
].join("\n")
const reportArtifact = ExperienceArtifactView.parse({
  id: "artifact-report",
  projectId: "project-delivered",
  kind: "report",
  title: "体验审查报告",
  href: "/experience/projects/project-delivered/artifacts/artifact-report",
  source: "inline",
  mediaType: "text/markdown",
  encoding: "utf8",
  presentation: "text",
  content: reportContent,
  byteLength: new TextEncoder().encode(reportContent).byteLength,
  createdAt: updatedAt,
})

const legacyBrief = GoalBriefProjectView.parse({
  kind: "legacy_charter",
  brief: {
    id: "legacy_project-blocked",
    version: 1,
    projectId: "project-blocked",
    goal: "整理旧项目的验收证据。",
    deliverables: ["验收证据清单"],
    acceptanceCriteria: ["所有证据均有来源"],
    constraints: ["保持旧数据只读"],
    nonGoals: ["不自动改写旧 Charter"],
    assumptions: ["旧项目仍可读取"],
    openQuestions: ["缺失凭据由谁补充"],
    riskLevel: null,
    recommendedPlan: null,
    approvalMode: "balanced",
    sourceRefs: [{ kind: "legacy_charter", id: "project-blocked" }],
    source: "legacy_charter",
    missingFields: ["riskLevel", "recommendedPlan"],
    createdAt: updatedAt,
  },
})
const structuredBriefFailure = GoalBriefStructuredFailure.parse({
  code: "goal_brief_structured_output_failed",
  message: "The model response did not match the required structure.",
  attempts: 3,
  recoveryActions: ["retry", "manual_edit"],
})
const generatedBrief = (requestId: string, goal: string) =>
  GoalBrief.parse({
    id: `brief-${requestId}`,
    version: 1,
    source: "system_suggestion",
    createdAt: updatedAt,
    goal,
    deliverables: [
      {
        id: "delivery-local",
        title: "可验证交付物",
        description: "形成与目标一致、来源可追溯的本地交付物。",
      },
    ],
    acceptanceCriteria: [
      {
        id: "criterion-local",
        description: "交付结果能够逐项核验。",
        verification: "按验收标准检查结果与来源。",
      },
    ],
    constraints: ["只生成摘要，不创建项目。"],
    nonGoals: ["不启动 Agent 执行。"],
    assumptions: [],
    openQuestions: [],
    riskLevel: "low",
    recommendedPlan: {
      summary: "先确认只读摘要，再决定是否正式提交。",
      steps: [
        {
          id: "step-local",
          title: "确认目标摘要",
          outcome: "得到未绑定项目的只读 Goal Brief。",
        },
      ],
    },
    approvalMode: "balanced",
    sourceRefs: [{ kind: "goal_request", id: requestId }],
  })

const agents = [
  {
    agent: {
      id: "agent-1",
      name: "小岚",
      role: "Delivery lead",
      lifecycle: "employee",
      department: "Delivery",
      responsibilities: ["发布检查", "交付验收"],
      brain: { big_model: "standard", small_model: "lite" },
    },
    employment: "employee",
    workload: {
      active: 1,
      blocked: 0,
      recent_delivery: {
        work_item_id: "work-item-release",
        title: "发布前检查",
        review_status: "accepted",
        time_completed: 1_753_430_000_000,
      },
    },
    presence: "online",
    attention: "focused",
    activity: "working",
    location: "发布工作区",
    subject: "准备本地发布",
    since: 1_753_434_000_000,
    interruptibility: "coordinate_first",
    collaborators: [],
    evidence: {
      kind: "agent_run",
      runID: "run-agent-1",
      threadID: "thread-release",
      timeUpdated: 1_753_434_000_000,
    },
  },
  {
    agent: {
      id: "agent-2",
      name: "阿衡",
      role: "Research partner",
      lifecycle: "employee",
      department: "Research",
      responsibilities: ["事实核验"],
      brain: { big_model: "standard", small_model: "lite" },
    },
    employment: "employee",
    workload: { active: 0, blocked: 0 },
    presence: "offline",
    attention: "none",
    activity: "idle",
    since: 1_753_434_000_000,
    interruptibility: "interruptible",
    collaborators: [],
  },
]

let mode = "ready"
const requests: { method: string; path: string }[] = []
const goalBriefRequests: { requestId: string; goal: string }[] = []
const auditRequests: { method: string; path: string }[] = []
const auditPath = process.env.PLAYWRIGHT_FAKE_CP_AUDIT_PATH
  ? path.resolve(process.env.PLAYWRIGHT_FAKE_CP_AUDIT_PATH)
  : undefined
const auditID = process.env.PLAYWRIGHT_SIDE_EFFECT_AUDIT_ID
if (auditPath && !auditID) {
  throw new Error("PLAYWRIGHT_SIDE_EFFECT_AUDIT_ID is required with PLAYWRIGHT_FAKE_CP_AUDIT_PATH")
}
let auditWrite = Promise.resolve()

function persistRequestsAudit() {
  if (!auditPath || !auditID) return Promise.resolve()
  auditWrite = auditWrite.then(async () => {
    await mkdir(path.dirname(auditPath), { recursive: true })
    const temporaryPath = `${auditPath}.${process.pid}.${crypto.randomUUID()}.tmp`
    await Bun.write(temporaryPath, `${JSON.stringify({
      schemaVersion: 1,
      auditId: auditID,
      requests: auditRequests,
    }, null, 2)}\n`)
    await rename(temporaryPath, auditPath)
  })
  return auditWrite
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status })
}

Bun.serve({
  hostname: "127.0.0.1",
  port: 3311,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === "/__test/mode" && request.method === "PUT") {
      const body = await request.json() as { mode?: string; reset?: boolean }
      if (body.reset) {
        requests.length = 0
        goalBriefRequests.length = 0
        await persistRequestsAudit()
      }
      mode = body.mode ?? "ready"
      return json({ mode })
    }
    if (url.pathname === "/__test/state") return json({ mode })
    if (url.pathname === "/__test/requests") return json({ items: requests })
    if (url.pathname === "/__test/goal-brief-requests") return json({ items: goalBriefRequests })

    const requestEntry = { method: request.method, path: url.pathname }
    requests.push(requestEntry)
    if (auditPath) auditRequests.push(requestEntry)
    await persistRequestsAudit()

    if (url.pathname === "/global/health") {
      if (mode === "health-401") return json({ error: "injected" }, 401)
      if (mode === "health-403") return json({ error: "injected" }, 403)
      if (mode === "health-404") return json({ error: "injected" }, 404)
      if (mode === "health-500") {
        return json({
          error: "injected",
          apiKey: "sk-sensitive-e2e-key",
          prompt: "SYSTEM PROMPT: private customer instructions",
          path: "/Users/private/customer/project",
        }, 500)
      }
      if (mode === "health-invalid-json") {
        return new Response("{", { headers: { "content-type": "application/json" } })
      }
      if (mode === "health-timeout") await Bun.sleep(6_000)
      if (mode === "slow-ready") await Bun.sleep(900)
      return json({ healthy: true, version: "0.1.2" })
    }
    if (url.pathname === "/global/readiness") {
      if (mode === "readiness-blocked") {
        return json({ ready: false, checks: [{ id: "database", status: "fail", detail: "blocked" }] })
      }
      return json({ ready: true, checks: [{ id: "database", status: "pass", detail: "ready" }] })
    }
    if (url.pathname === "/company") {
      return json({
        state: "ready",
        company: {
          id: "company-e2e",
          name: "Agent Company",
          approval_policy: { preset: "balanced" },
          repository: { root_path: "/tmp/agent-company-e2e-repository" },
          provider: mode === "provider-required" || mode === "empty-work"
            ? null
            : { provider_id: "local-test", model_id: "test-model" },
          setup_goal: null,
        },
      })
    }
    if (url.pathname === "/company/agents") {
      if (mode === "agents-500") return json({ error: "injected" }, 500)
      if (mode === "empty-work" || mode === "empty-work-ready") return json([])
      return json(agents)
    }
    if (url.pathname === "/experience/work") {
      if (mode === "work-500") return json({ error: "injected" }, 500)
      if (mode === "work-invalid") return json({ items: [{ status: "running" }] })
      if (mode === "empty-work" || mode === "empty-work-ready") return json({ items: [] })
      if (mode === "hr01-states") return json(hr01Work)
      if (mode === "quiet-work") return json({ items: [work.items[0]] })
      if (mode === "slow-ready") await Bun.sleep(900)
      if (mode === "long-content") return json(longWork)
      return json(work)
    }
    if (url.pathname === "/experience/goal-brief/generate" && request.method === "POST") {
      const body = await request.json() as { requestId: string; goal: string }
      goalBriefRequests.push({ requestId: body.requestId, goal: body.goal })
      if (mode === "brief-generate-recover" && goalBriefRequests.length === 1) {
        return json(structuredBriefFailure, 422)
      }
      if (mode === "brief-generate-conflict") {
        return json({
          code: "request_in_progress",
          message: "相同目标摘要请求仍在生成。",
        }, 409)
      }
      return json(generatedBrief(body.requestId, body.goal))
    }
    if (url.pathname.startsWith("/experience/goal-brief/project/")) {
      if (mode === "brief-500") return json({ error: "injected" }, 500)
      if (mode === "brief-invalid") return json({ kind: "goal_brief", brief: {} })
      const projectID = decodeURIComponent(url.pathname.slice("/experience/goal-brief/project/".length))
      if (projectID === "project-gate") return json(gateBrief)
      if (projectID === "project-brief") return json(readyBrief)
      if (projectID === "project-running") return json(runningBrief)
      if (projectID === "project-delivered") return json(deliveredBrief)
      if (projectID === "project-blocked") return json(legacyBrief)
      return json({ code: "not_found", message: "Goal Brief not found" }, 404)
    }
    if (url.pathname === reportArtifact.href) return json(reportArtifact)
    if (url.pathname === "/company/threads/cth_auth") {
      return json({
        id: "cth_auth",
        projectScopeID: "project-gate",
        status: "active",
        run: { state: "running", retryable: false },
      })
    }
    if (url.pathname === "/company/threads/cth_auth/entries") return json({ items: [] })
    if (url.pathname === "/company/threads/cth_auth/actions" && request.method === "POST") {
      return json({ accepted: true })
    }
    if (url.pathname === "/company/provider" && request.method === "PUT") {
      return json({ configured: true })
    }
    if (url.pathname === "/company-project/project-gate" && request.method === "GET") {
      return json({
        project: {
          id: "project-gate",
          title: "发布候选版本",
          goal: "形成可审批的本地发布候选。",
          status: "awaiting_approval",
          owner_agent_id: "agent-1",
        },
        charter: null,
        work_items: [],
        artifacts: [],
        gates: [
          { id: "gate-release", title: "发布前人工审批", kind: "approval", status: "pending" },
        ],
      })
    }
    if (url.pathname === "/company-project/project-gate/retry" && request.method === "POST") {
      return json({ project: { id: "project-gate" }, run_id: "run-auth-e2e" })
    }
    if (url.pathname === "/company/recruitment") {
      return json({
        needs: [],
        selections: [],
        candidate_pool: [],
        assigned_candidates: [],
        departments: [],
      })
    }
    if (url.pathname === "/company/channels") {
      if (mode === "empty-work" || mode === "empty-work-ready") return json([])
      return json([{ id: "channel-board", kind: "board" }])
    }
    if (url.pathname === "/company/channels/channel-board/messages") {
      if (mode === "messages-500") return json({ error: "injected" }, 500)
      return json({ items: [] })
    }
    return json({ error: "not found" }, 404)
  },
})
