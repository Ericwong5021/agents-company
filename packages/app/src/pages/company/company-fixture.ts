import type {
  CompanyAgent,
  CompanyChannel,
  CompanyDelivery,
  CompanyMessage,
  CompanyDemoSnapshot,
  CompanyThreadEvent,
  CompanyWorkspaceSnapshot,
} from "./company-model"
import type { CompanyWorkspaceDataSource } from "./company-data-source"

const agents: Record<string, CompanyAgent> = {
  "product-lead": {
    id: "product-lead",
    name: "Product Lead",
    role: "产品与交付负责人",
    avatar: "/assets/company/product-lead.png",
    status: "online",
  },
  "ui-implementer": {
    id: "ui-implementer",
    name: "UI-Implementer",
    role: "前端与设计系统",
    avatar: "/assets/company/ui-implementer.png",
    status: "working",
  },
  "backend-engineer": {
    id: "backend-engineer",
    name: "Backend-Engineer",
    role: "服务端与运行时",
    avatar: "/assets/company/backend-engineer.png",
    status: "working",
  },
  "qa-agent": {
    id: "qa-agent",
    name: "QA-Agent",
    role: "质量与发布验收",
    avatar: "/assets/company/qa-agent.png",
    status: "reviewing",
  },
}

const channels: CompanyChannel[] = [
  { id: "lobby", section: "公司", name: "公司大厅", preview: "3 个项目正在推进" },
  { id: "board", section: "公司", name: "董事会", preview: "2 项决定等待确认", badge: 2 },
  { id: "pre-public-webui", section: "项目", name: "Pre-Public WebUI", preview: "准备合并到 main", badge: 6 },
  { id: "agent-runtime", section: "项目", name: "Agent Runtime", preview: "Memory layer refactor 完成", badge: 3 },
  { id: "billing", section: "项目", name: "Billing & Subscriptions", preview: "Stripe 集成上线计划" },
  { id: "docs", section: "项目", name: "Docs & Knowledge", preview: "API 文档结构更新", badge: 1 },
  { id: "infra", section: "项目", name: "Infra & Observability", preview: "日志采样策略优化", badge: 2 },
  { id: "direct-product-lead", section: "Direct", name: "Product Lead", preview: "好的，收到", agent: "product-lead" },
  { id: "direct-ui", section: "Direct", name: "UI-Implementer", preview: "正在处理图标规范", agent: "ui-implementer" },
  {
    id: "direct-backend",
    section: "Direct",
    name: "Backend-Engineer",
    preview: "已提交 PR",
    agent: "backend-engineer",
  },
  { id: "direct-qa", section: "Direct", name: "QA-Agent", preview: "有一条评审意见", badge: 1, agent: "qa-agent" },
]

const messages: CompanyMessage[] = [
  {
    id: "delivery-request",
    agent: "product-lead",
    time: "今天 10:28",
    bubble: true,
    body: [
      "各位，Pre-Public WebUI 的实现已完成，所有验收项通过，准备合并到 main。",
      "请查阅交付物与证据，如无异议请批准合并。",
    ],
  },
  {
    id: "ui-complete",
    agent: "ui-implementer",
    time: "今天 10:31",
    body: ["前端已完成全部需求与响应式适配，组件库更新完毕，文档与 Storybook 已同步。", "验证清单全绿，建议合并。"],
  },
  {
    id: "backend-complete",
    agent: "backend-engineer",
    time: "今天 10:33",
    body: ["后端接口、权限与审计日志已实现并通过测试。", "回滚脚本与数据兼容处理已验证，风险可控。"],
  },
]

const threadEvents: CompanyThreadEvent[] = [
  {
    id: "ui-complete",
    agent: "ui-implementer",
    time: "昨天 16:12",
    body: "完成页面实现与响应式适配。",
    detail: "构建前端包",
    duration: "2m 14s",
  },
  {
    id: "backend-complete",
    agent: "backend-engineer",
    time: "昨天 16:48",
    body: "API、权限与审计日志实现完成。",
    detail: "运行数据库迁移",
    duration: "1m 07s",
  },
  {
    id: "qa-test",
    agent: "qa-agent",
    time: "昨天 17:20",
    body: "执行回归测试与探索性测试。",
    detail: "测试证据 · 142/142 通过",
  },
  {
    id: "qa-review",
    agent: "qa-agent",
    time: "昨天 18:05",
    body: "评审发现：设置页边距在 1200px 下异常。",
    detail: "UI-1024 · 已修复",
  },
  { id: "ui-verified", agent: "ui-implementer", time: "昨天 18:32", body: "已修复并补充测试，验证通过。" },
  { id: "approval-requested", agent: "product-lead", time: "今天 10:28", body: "所有验收项通过，发起合并申请。" },
]

const delivery: CompanyDelivery = {
  id: "pre-public-webui-delivery",
  status: "pending",
  targetBranch: "main",
  requesterAgentID: "product-lead",
  repository: "agent-company/web",
  reason: "功能完整、验收通过，进入发布候选窗口。",
  risk: "低（向后兼容，无破坏性变更）",
  reversibility: "可回滚（回滚脚本已验证）",
  checks: [
    { label: "测试通过", value: "142/142" },
    { label: "评审通过", value: "2/2" },
    { label: "构建通过", value: "#1287" },
  ],
  evidence: [
    { label: "功能验收", value: "28/28" },
    { label: "兼容性检查", value: "12/12" },
    { label: "可访问性", value: "8/8" },
    { label: "性能基准", value: "4/4" },
  ],
  files: ["PR #4527", "变更日志.md", "回滚脚本.sh", "设计稿导出.zip"],
  previewImage: "/assets/company/delivery-preview.png",
  sourceLabel: "来自 Thread · 交付验收",
}

const snapshot = (status: CompanyDelivery["status"], userMessages: string[]): CompanyDemoSnapshot => ({
  status: "demo",
  company: { name: "Agent Company", versionLabel: "本地优先 · v1.0.0" },
  currentUserAgentID: "product-lead",
  agents,
  channels,
  featuredChannelID: "pre-public-webui",
  featuredDescription: "Pre-public Web UI for the agent company OS",
  participantAgentIDs: ["ui-implementer", "backend-engineer", "qa-agent"],
  participantCount: 8,
  dateLabel: "2026年7月13日",
  messages,
  delivery: { ...delivery, status },
  threadTitle: "来自 Thread · 交付验收",
  threadEvents,
  userMessages,
})

export function createFixtureCompanyWorkspaceDataSource(): CompanyWorkspaceDataSource {
  const state = { snapshot: snapshot("pending", []) as CompanyWorkspaceSnapshot }
  const listeners = new Set<(snapshot: CompanyWorkspaceSnapshot) => void>()
  const publish = (next: CompanyWorkspaceSnapshot) => {
    state.snapshot = next
    listeners.forEach((listener) => listener(next))
  }

  return {
    getSnapshot: () => state.snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh: async () => undefined,
    listProviders: async () => undefined,
    listProviderAuth: async () => undefined,
    listCustomProviderModels: async () => undefined,
    setProvider: async () => undefined,
    authorizeProvider: async () => undefined,
    completeProviderOAuth: async () => undefined,
    inspectRepository: async () => undefined,
    bootstrap: async () => undefined,
    createPairing: async () => undefined,
    listCredentials: async () => undefined,
    revokeCredential: async () => undefined,
    handleEvent: () => undefined,
    async sendMessage(input) {
      if (state.snapshot.status !== "demo") return
      if (input.channelID !== state.snapshot.featuredChannelID) return
      publish({ ...state.snapshot, userMessages: [...state.snapshot.userMessages, input.body] })
    },
    async approveDelivery(input) {
      if (state.snapshot.status !== "demo") return
      if (input.deliveryID !== state.snapshot.delivery.id) return
      publish({ ...state.snapshot, delivery: { ...state.snapshot.delivery, status: "approved" } })
    },
  }
}
