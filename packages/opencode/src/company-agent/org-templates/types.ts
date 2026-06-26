// Organization template types. An OrgTemplate defines a pre-built org structure
// that maps to the bundled agent-template library. Each role is resolved via
// search at assembly time (never hardcodes template slugs), with a fallback
// that guarantees the founding team always assembles even offline.

export interface OrgTemplate {
  id: string
  name: string
  nameEn: string
  description: string
  descriptionEn: string
  icon: string
  /** Starter = 2-4 roles, quick setup. Advanced = 5-8 roles, more config. */
  tier: "starter" | "advanced"
  /** Divisions and roles in this org template. */
  divisions: OrgDivisionSpec[]
  /** Optional sample tasks for demo mode. */
  sampleTasks?: SampleTask[]
}

export interface OrgDivisionSpec {
  name: string
  nameEn: string
  roles: OrgRoleSpec[]
}

export interface OrgRoleSpec {
  /** Stable key — used for dedup across overlapping templates and for reportsTo references. */
  key: string
  /** Template library division to search in. */
  division: string
  /** Search query for TemplateService.search(). */
  templateQuery: string
  /** Guaranteed fallback when the template library has no match. */
  fallback: {
    name: string
    nameEn: string
    description: string
    descriptionEn: string
    icon: string
    color: string
  }
  /** Organizational level — determines delegation authority. */
  level: "c-suite" | "lead" | "ic"
  /** Key of the role this person reports to (null = reports to founder). */
  reportsTo: string | null
}

export interface SampleTask {
  title: string
  titleEn: string
  description: string
  descriptionEn: string
  assigneeRoleKey: string
  status: "todo" | "in-progress" | "done"
}
