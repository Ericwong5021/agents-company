export type CompanyAgentID = "product-lead" | "ui-implementer" | "backend-engineer" | "qa-agent"

export type CompanyAgent = {
  id: CompanyAgentID
  name: string
  role: string
  avatar: string
  status: "online" | "working" | "reviewing"
}

export type CompanyChannel = {
  id: string
  section: "公司" | "项目" | "Direct"
  name: string
  preview?: string
  badge?: number
  agent?: CompanyAgentID
}

export const companyAgents: Record<CompanyAgentID, CompanyAgent> = {
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

export const companyChannels: CompanyChannel[] = [
  { id: "lobby", section: "公司", name: "公司大厅", preview: "3 个项目正在推进" },
  { id: "board", section: "公司", name: "董事会", preview: "2 项决定等待确认", badge: 2 },
  {
    id: "pre-public-webui",
    section: "项目",
    name: "Pre-Public WebUI",
    preview: "准备合并到 main",
    badge: 6,
  },
  { id: "agent-runtime", section: "项目", name: "Agent Runtime", preview: "Memory layer refactor 完成", badge: 3 },
  { id: "billing", section: "项目", name: "Billing & Subscriptions", preview: "Stripe 集成上线计划" },
  { id: "docs", section: "项目", name: "Docs & Knowledge", preview: "API 文档结构更新", badge: 1 },
  { id: "infra", section: "项目", name: "Infra & Observability", preview: "日志采样策略优化", badge: 2 },
  {
    id: "direct-product-lead",
    section: "Direct",
    name: "Product Lead",
    preview: "好的，收到",
    agent: "product-lead",
  },
  {
    id: "direct-ui",
    section: "Direct",
    name: "UI-Implementer",
    preview: "正在处理图标规范",
    agent: "ui-implementer",
  },
  {
    id: "direct-backend",
    section: "Direct",
    name: "Backend-Engineer",
    preview: "已提交 PR",
    agent: "backend-engineer",
  },
  {
    id: "direct-qa",
    section: "Direct",
    name: "QA-Agent",
    preview: "有一条评审意见",
    badge: 1,
    agent: "qa-agent",
  },
]

export const threadEvents = [
  {
    id: "ui-complete",
    agent: "ui-implementer" as const,
    time: "昨天 16:12",
    body: "完成页面实现与响应式适配。",
    detail: "构建前端包",
    duration: "2m 14s",
  },
  {
    id: "backend-complete",
    agent: "backend-engineer" as const,
    time: "昨天 16:48",
    body: "API、权限与审计日志实现完成。",
    detail: "运行数据库迁移",
    duration: "1m 07s",
  },
  {
    id: "qa-test",
    agent: "qa-agent" as const,
    time: "昨天 17:20",
    body: "执行回归测试与探索性测试。",
    detail: "测试证据 · 142/142 通过",
  },
  {
    id: "qa-review",
    agent: "qa-agent" as const,
    time: "昨天 18:05",
    body: "评审发现：设置页边距在 1200px 下异常。",
    detail: "UI-1024 · 已修复",
  },
  {
    id: "ui-verified",
    agent: "ui-implementer" as const,
    time: "昨天 18:32",
    body: "已修复并补充测试，验证通过。",
  },
  {
    id: "approval-requested",
    agent: "product-lead" as const,
    time: "今天 10:28",
    body: "所有验收项通过，发起合并申请。",
  },
]

export const deliveryEvidence = [
  { label: "功能验收", value: "28/28" },
  { label: "兼容性检查", value: "12/12" },
  { label: "可访问性", value: "8/8" },
  { label: "性能基准", value: "4/4" },
]

export const deliveryFiles = ["PR #4527", "变更日志.md", "回滚脚本.sh", "设计稿导出.zip"]
