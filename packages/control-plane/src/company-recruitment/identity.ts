import { createHash } from "node:crypto"
import { CompanyAgentID } from "@/company-agent/schema"

const HASH_LENGTH = 16
const LOGICAL_KEY_MAX_LENGTH = 100

const fragment = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "") || "agent"

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH)

const withHash = (prefix: string, material: string, maximumLength: number) => {
  const suffix = hash(material)
  const readable = prefix
    .slice(0, maximumLength - suffix.length - 1)
    .replace(/[^a-z0-9]+$/g, "")
  return `${readable || "agent"}-${suffix}`
}

export const stableLogicalKey = (value: string) => {
  const normalized = fragment(value)
  const canonical = value.normalize("NFKC")
  if (canonical === normalized && normalized.length <= LOGICAL_KEY_MAX_LENGTH) return normalized
  return withHash(normalized, canonical, LOGICAL_KEY_MAX_LENGTH)
}

export const stableCandidateAgentID = (input: {
  company_id: string
  project_id: string
  need_key: string
  role: string
}) =>
  CompanyAgentID.make(
    withHash(
      `project-${fragment(input.project_id.slice(-12))}-${fragment(input.need_key)}-${fragment(input.role)}`,
      JSON.stringify([input.company_id, input.project_id, input.need_key, input.role]),
      72,
    ),
  )
