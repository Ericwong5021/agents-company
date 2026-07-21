import { createHash } from "node:crypto"
import type { RuntimeCapabilities, RuntimePermissionMode } from "@/runtime"

export type CapabilityPackDefinition = {
  id: string
  version: string
  role: string
  instructions: string
  tools: string[]
  permissionMode: RuntimePermissionMode
  requiredRuntimeCapabilities: Array<keyof RuntimeCapabilities>
  timeoutMs: number
  maxTurns: number
}

export type CapabilityPack = CapabilityPackDefinition & { checksum: string }

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}

function pack(input: CapabilityPackDefinition): CapabilityPack {
  return {
    ...input,
    checksum: createHash("sha256").update(canonical(input)).digest("hex"),
  }
}

const definitions: CapabilityPackDefinition[] = [
  {
    id: "board-strategy",
    version: "1",
    role: "Board strategist",
    instructions: "Evaluate the goal, surface material risks and produce explicit strategic decisions.",
    tools: ["read", "grep", "glob"],
    permissionMode: "read_only",
    requiredRuntimeCapabilities: ["structuredOutput", "workspaceRead"],
    timeoutMs: 10 * 60_000,
    maxTurns: 8,
  },
  {
    id: "delivery-governance",
    version: "1",
    role: "Delivery governor",
    instructions: "Enforce gates, evidence requirements and terminal state rules without implementing the work.",
    tools: ["read", "grep", "glob"],
    permissionMode: "read_only",
    requiredRuntimeCapabilities: ["structuredOutput", "workspaceRead"],
    timeoutMs: 10 * 60_000,
    maxTurns: 8,
  },
  {
    id: "independent-review",
    version: "1",
    role: "Independent reviewer",
    instructions: "Review implementation evidence independently and report only actionable, evidence-backed findings.",
    tools: ["read", "grep", "glob", "bash"],
    permissionMode: "read_only",
    requiredRuntimeCapabilities: ["toolCalls", "structuredOutput", "workspaceRead"],
    timeoutMs: 20 * 60_000,
    maxTurns: 16,
  },
  {
    id: "product-charter",
    version: "1",
    role: "Product charter author",
    instructions: "Turn an approved goal into a bounded charter with success criteria, exclusions and decision gates.",
    tools: ["read", "grep", "glob"],
    permissionMode: "read_only",
    requiredRuntimeCapabilities: ["structuredOutput", "workspaceRead"],
    timeoutMs: 10 * 60_000,
    maxTurns: 8,
  },
  {
    id: "software-implementation",
    version: "1",
    role: "Implementation engineer",
    instructions: "Implement the assigned work inside the authorized worktree and return changed files plus verification evidence.",
    tools: ["read", "grep", "glob", "bash", "edit", "write"],
    permissionMode: "workspace_write",
    requiredRuntimeCapabilities: ["toolCalls", "structuredOutput", "workspaceRead", "workspaceWrite"],
    timeoutMs: 60 * 60_000,
    maxTurns: 64,
  },
  {
    id: "technical-planning",
    version: "1",
    role: "Technical planner",
    instructions: "Inspect the repository and produce decision-complete, dependency-ordered implementation work items.",
    tools: ["read", "grep", "glob"],
    permissionMode: "read_only",
    requiredRuntimeCapabilities: ["structuredOutput", "workspaceRead"],
    timeoutMs: 20 * 60_000,
    maxTurns: 16,
  },
  {
    id: "research-analysis",
    version: "1",
    role: "Research and analysis specialist",
    instructions: "Gather evidence, distinguish facts from inference, cross-check important claims and return structured findings.",
    tools: ["read", "grep", "glob", "websearch", "webfetch", "read_doc", "codesearch"],
    permissionMode: "read_only",
    requiredRuntimeCapabilities: ["toolCalls", "structuredOutput", "workspaceRead"],
    timeoutMs: 30 * 60_000,
    maxTurns: 24,
  },
  {
    id: "document-authoring",
    version: "1",
    role: "Document author",
    instructions: "Produce a structured, decision-useful document that satisfies the assigned acceptance criteria.",
    tools: ["read", "grep", "glob", "websearch", "webfetch", "read_doc"],
    permissionMode: "read_only",
    requiredRuntimeCapabilities: ["toolCalls", "structuredOutput", "workspaceRead"],
    timeoutMs: 20 * 60_000,
    maxTurns: 20,
  },
  {
    id: "design-production",
    version: "1",
    role: "Design specialist",
    instructions: "Produce concrete design artifacts, explain their intent and preserve all material constraints.",
    tools: ["read", "grep", "glob", "websearch", "webfetch", "read_doc"],
    permissionMode: "read_only",
    requiredRuntimeCapabilities: ["toolCalls", "structuredOutput", "workspaceRead"],
    timeoutMs: 30 * 60_000,
    maxTurns: 24,
  },
  {
    id: "verification-testing",
    version: "1",
    role: "Verification engineer",
    instructions: "Run repository-prescribed checks, preserve raw evidence and distinguish product failure from environment failure.",
    tools: ["read", "grep", "glob", "bash"],
    permissionMode: "read_only",
    requiredRuntimeCapabilities: ["toolCalls", "structuredOutput", "workspaceRead"],
    timeoutMs: 30 * 60_000,
    maxTurns: 24,
  },
]

const registry = new Map(definitions.map((definition) => [`${definition.id}@${definition.version}`, pack(definition)]))

export const CapabilityCatalog = {
  list() {
    return [...registry.values()].sort((left, right) => left.id.localeCompare(right.id))
  },
  resolve(reference: string) {
    if (!reference.includes("@")) throw new Error(`Capability pack ${reference} must include an immutable version`)
    const result = registry.get(reference)
    if (!result) throw new Error(`Unknown capability pack: ${reference}`)
    return result
  },
}
