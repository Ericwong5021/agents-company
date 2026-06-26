import type { OrgTemplate, OrgRoleSpec } from "./types"
import startupSaaS from "./startup-saas.json"
import startupContent from "./startup-content.json"
import consultingBoutique from "./consulting-boutique.json"
import ecommerceDTC from "./ecommerce-dtc.json"
import agencyDigital from "./agency-digital.json"
import enterpriseTech from "./enterprise-tech.json"
import soloCreator from "./solo-creator.json"

export type { OrgTemplate, OrgRoleSpec }

// All bundled org templates.
const ALL_TEMPLATES: OrgTemplate[] = [
  startupSaaS as OrgTemplate,
  startupContent as OrgTemplate,
  consultingBoutique as OrgTemplate,
  ecommerceDTC as OrgTemplate,
  agencyDigital as OrgTemplate,
  enterpriseTech as OrgTemplate,
  soloCreator as OrgTemplate,
]

const byId = new Map<string, OrgTemplate>()
for (const tpl of ALL_TEMPLATES) byId.set(tpl.id, tpl)

export const OrgTemplateService = {
  /** All available org templates. */
  all(): OrgTemplate[] {
    return ALL_TEMPLATES
  },

  /** Templates filtered by tier. */
  byTier(tier: "starter" | "advanced"): OrgTemplate[] {
    return ALL_TEMPLATES.filter((t) => t.tier === tier)
  },

  /** Single template by id, or undefined. */
  get(id: string): OrgTemplate | undefined {
    return byId.get(id)
  },

  /**
   * Flatten all roles from a template into a single list of FoundingRoleSpec
   * objects compatible with the existing founding-team assembly logic.
   * Deduplicates by key (in case the same role appears in multiple divisions).
   */
  flatRoles(template: OrgTemplate): FlatRole[] {
    const seen = new Set<string>()
    const result: FlatRole[] = []
    for (const div of template.divisions) {
      for (const role of div.roles) {
        if (seen.has(role.key)) continue
        seen.add(role.key)
        result.push({
          key: role.key,
          division: role.division,
          query: role.templateQuery,
          fallback: {
            name: role.fallback.name,
            description: role.fallback.description,
            icon: role.fallback.icon,
            color: role.fallback.color,
          },
          level: role.level,
          reportsTo: role.reportsTo,
          divisionName: div.name,
          divisionNameEn: div.nameEn,
        })
      }
    }
    return result
  },
} as const

/** Flattened role with division context, ready for founding-team assembly. */
export interface FlatRole {
  key: string
  division: string
  query: string
  fallback: {
    name: string
    description: string
    icon: string
    color: string
  }
  level: "c-suite" | "lead" | "ic"
  reportsTo: string | null
  divisionName: string
  divisionNameEn: string
}

