// Maps a business scope or org template to the founding roles we recruit.
// Each role is resolved against the bundled agent-template library via a
// keyword search in a division, so we never hardcode template slugs that
// might drift. A fallback is used when the library has no match, guaranteeing
// the founding team always assembles even offline.
//
// Two resolution paths:
//   1. Template-based (new): OrgTemplateService.flatRoles(template) — preferred
//   2. Scope-based (legacy): resolveFoundingRoles(scopes) — still works for custom flows

import { OrgTemplateService, type FlatRole } from "@/company-agent/org-templates"

export type { FlatRole as FoundingRoleSpec }

// Re-export the old interface shape for backward compat.
export interface LegacyFoundingRoleSpec {
  key: string
  division: string
  query: string
  fallback: {
    name: string
    description: string
    icon: string
    color: string
  }
}

// Business scopes shown to the user are the presets in business-scope-cards.tsx
// (saas / content / consulting / ecommerce / agency) plus any free-form custom
// scope. Custom scopes fall back to the generalist founders below.
const SCOPE_ROLES: Record<string, LegacyFoundingRoleSpec[]> = {
  saas: [
    {
      key: "cto",
      division: "engineering",
      query: "engineering lead architect",
      fallback: { name: "技术合伙人 (CTO)", description: "负责产品架构与技术方向", icon: "🛠", color: "#3B82F6" },
    },
    {
      key: "cpo",
      division: "product",
      query: "product manager strategy",
      fallback: { name: "产品负责人", description: "把握产品定位与路线图", icon: "🧭", color: "#8B5CF6" },
    },
  ],
  content: [
    {
      key: "content-strategist",
      division: "marketing",
      query: "content strategy",
      fallback: { name: "内容主理人", description: "策划内容方向与选题", icon: "✍", color: "#F59E0B" },
    },
    {
      key: "growth",
      division: "marketing",
      query: "growth audience",
      fallback: { name: "增长负责人", description: "负责获客与渠道增长", icon: "📈", color: "#10B981" },
    },
  ],
  consulting: [
    {
      key: "chief-of-staff",
      division: "specialized",
      query: "chief of staff operations",
      fallback: { name: "幕僚长", description: "统筹运营与重大决策", icon: "🗂", color: "#6366F1" },
    },
    {
      key: "finance",
      division: "finance",
      query: "financial analyst",
      fallback: { name: "财务顾问", description: "把控盈利模式与现金流", icon: "💰", color: "#22C55E" },
    },
  ],
  ecommerce: [
    {
      key: "growth",
      division: "marketing",
      query: "growth acquisition",
      fallback: { name: "增长负责人", description: "负责获客与渠道增长", icon: "📈", color: "#10B981" },
    },
    {
      key: "ops",
      division: "project-management",
      query: "operations project manager",
      fallback: { name: "运营负责人", description: "打理供应链与日常运营", icon: "📦", color: "#0EA5E9" },
    },
  ],
  agency: [
    {
      key: "creative-director",
      division: "design",
      query: "creative director brand",
      fallback: { name: "创意总监", description: "把控创意与品牌表达", icon: "🎨", color: "#EC4899" },
    },
    {
      key: "account-exec",
      division: "sales",
      query: "account executive client",
      fallback: { name: "客户总监", description: "拓展客户与商务合作", icon: "🤝", color: "#F97316" },
    },
  ],
}

// The default opening team is two generalist co-founders — a strategist who
// shapes the company thesis and a builder who ships the first real thing —
// NOT vertical specialists. Specialists are recruited later, once the direction
// is settled. These resolve to the cofounder-* templates in the specialized
// division (see templates/specialized/cofounder-*.md).
const DEFAULT_ROLES: LegacyFoundingRoleSpec[] = [
  {
    key: "strategist",
    division: "specialized",
    query: "联合创始人 谋士 方向",
    fallback: {
      name: "联合创始人 · 谋士",
      description: "在出方案前，先帮创始人把「为谁、解决什么、凭什么是我们」想清楚",
      icon: "🧭",
      color: "#8B5CF6",
    },
  },
  {
    key: "builder",
    division: "specialized",
    query: "联合创始人 操盘手 落地",
    fallback: {
      name: "联合创始人 · 操盘手",
      description: "不写宏伟架构，先做出能跑的最小真东西来验证方向",
      icon: "🔨",
      color: "#3B82F6",
    },
  },
]

// Map legacy scope keys to org template IDs for smooth migration.
const SCOPE_TO_TEMPLATE: Record<string, string> = {
  saas: "startup-saas",
  content: "startup-content",
  consulting: "consulting-boutique",
  ecommerce: "ecommerce-dtc",
  agency: "agency-digital",
}

/**
 * Resolve founding roles from an org template ID. Preferred path for the
 * new onboarding flow. Returns null if the template doesn't exist.
 */
export function resolveTemplateRoles(templateId: string): FlatRole[] | null {
  const tpl = OrgTemplateService.get(templateId)
  if (!tpl) return null
  return OrgTemplateService.flatRoles(tpl)
}

/**
 * Resolve founding roles from business scopes (legacy path).
 * Tries to map each scope to an org template first; falls back to
 * the hardcoded SCOPE_ROLES for custom/unknown scopes.
 */
export function resolveFoundingRoles(_scopes: string[]): FlatRole[] {
  // Co-founder-first: regardless of business scope, the opening team is the two
  // generalist co-founders. Their job is to help the founder figure out what the
  // company actually does; vertical specialists are recruited later. The scope
  // only flavours each agent's prompt (injected downstream), it no longer picks
  // the roles. SCOPE_ROLES / SCOPE_TO_TEMPLATE remain available for the explicit
  // org-template selection path (resolveTemplateRoles).
  return DEFAULT_ROLES.map((r) => ({
    key: r.key,
    division: r.division,
    query: r.query,
    fallback: r.fallback,
    level: "c-suite" as const,
    reportsTo: null,
    divisionName: r.division,
    divisionNameEn: r.division,
  }))
}
