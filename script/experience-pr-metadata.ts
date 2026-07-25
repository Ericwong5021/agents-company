import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const relevantPrefixes = [
  "packages/app/",
  "packages/control-plane/",
  "packages/shared/",
  "packages/desktop/",
  "packages/sdk/",
  "script/experience-",
  ".github/workflows/",
  "docs/design/",
  "docs/product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md",
  "docs/product-design/experience-refactor/",
]
const placeholder = /^(?:n\/a|none|not applicable|tbd|todo|pending|-)$/i
const evidenceLocator =
  /(?:https?:\/\/[^\s)]+|(?:^|\s)(?:bun|git|npm|pnpm|yarn|make|cargo|go|pytest|ruby|node|deno)\s+[^\n]+|(?:^|[\s`(])(?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+(?:\.[A-Za-z0-9]+)?)/i
const evidenceResult =
  /(?:(?:->|=>)\s*(?:pass(?:ed)?|fail(?:ed)?|incomplete|blocked)|\bexit(?:\s+code)?\s*[:=]?\s*\d+\b|\bstatus\s*[:=]\s*(?:pass(?:ed)?|fail(?:ed)?|incomplete|blocked|invalid)\b)/i

function stripComments(value: string) {
  return value.replace(/<!--[\s\S]*?-->/g, "").trim()
}

function field(body: string, label: string) {
  const lines = body.split(/\r?\n/)
  const index = lines.findIndex((line) => line.match(new RegExp(`^${label}:\\s*`, "i")))
  if (index < 0) return ""
  const inline = stripComments(lines[index]!.replace(new RegExp(`^${label}:\\s*`, "i"), ""))
  if (inline) return inline
  const following = lines.slice(index + 1)
  const end = following.findIndex((line) => /^(?:[A-Za-z -]+:|#{1,6}\s)/.test(line))
  return stripComments(following.slice(0, end < 0 ? undefined : end).join("\n"))
}

function section(body: string, heading: string) {
  const lines = body.split(/\r?\n/)
  const index = lines.findIndex((line) => line.trim().toLowerCase() === `### ${heading}`.toLowerCase())
  if (index < 0) return ""
  const following = lines.slice(index + 1)
  const end = following.findIndex((line) => /^###\s/.test(line))
  return following
    .slice(0, end < 0 ? undefined : end)
    .join("\n")
    .replace(/^\s*[-*]\s*/gm, "")
    .trim()
}

function meaningful(value: string) {
  const normalized = value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[[ x]\]/gi, "")
    .replace(/[`#>*_]/g, "")
    .trim()
  return Boolean(normalized) && !placeholder.test(normalized)
}

function locatableEvidence(value: string) {
  return (
    meaningful(value) && !/\btrust\s+me\b/i.test(value) && evidenceLocator.test(value) && evidenceResult.test(value)
  )
}

export function validatePRMetadata(body: string, changedFiles: string[]) {
  const relevant = changedFiles.some((file) => relevantPrefixes.some((prefix) => file.startsWith(prefix)))
  if (!relevant) return { relevant, errors: [] as string[] }

  const taskID = field(body, "Task ID")
  const releaseGate = field(body, "Release gate")
  const coreLoopImpact = field(body, "Core-loop impact")
  const scopeDecision = field(body, "Scope decision")
  const evidence = section(body, "Acceptance evidence")
  const errors = [
    !/^(?:(?:FND|SHELL|TRUST|GOAL|WORK|DELIV|TEAM|QA)-\d{2})(?:\s*[, ]\s*(?:FND|SHELL|TRUST|GOAL|WORK|DELIV|TEAM|QA)-\d{2})*$/.test(
      taskID,
    )
      ? "Task ID must contain one or more plan Task IDs."
      : undefined,
    !/^R[0-4]$/.test(releaseGate) ? "Release gate must be R0 through R4." : undefined,
    !meaningful(coreLoopImpact) ? "Core-loop impact must be non-empty and non-placeholder." : undefined,
    !/^(?:Keep|Rebuild|Defer|Delete|Not applicable)$/.test(scopeDecision)
      ? "Scope decision must use the plan vocabulary."
      : undefined,
    !locatableEvidence(evidence)
      ? "Acceptance evidence must include a locatable command, path, or URL and an explicit result, status, or exit code."
      : undefined,
  ].filter((error): error is string => Boolean(error))

  return { relevant, errors }
}

function changedFilesFromEnvironment() {
  if (process.env.CHANGED_FILES) return process.env.CHANGED_FILES.split(/\r?\n/).filter(Boolean)
  const base = process.env.BASE_SHA
  const head = process.env.HEAD_SHA
  if (!base || !head) throw new Error("BASE_SHA and HEAD_SHA are required when CHANGED_FILES is not set.")
  const result = Bun.spawnSync(["git", "diff", "--name-only", base, head], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim())
  return result.stdout.toString().split(/\r?\n/).filter(Boolean)
}

export function runSelfTest() {
  const valid = validatePRMetadata(
    [
      "Task ID: FND-01, FND-02",
      "Release gate: R0",
      "Core-loop impact: Freezes the truthful product shell contract.",
      "Scope decision: Rebuild",
      "### Acceptance evidence",
      "bun script/experience-validate.ts -> pass",
    ].join("\n"),
    ["packages/control-plane/src/example.ts"],
  )
  const invalid = validatePRMetadata(
    ["Task ID: N/A", "Release gate: N/A", "Core-loop impact:", "Scope decision: N/A", "### Acceptance evidence"].join(
      "\n",
    ),
    ["packages/shared/src/example.ts"],
  )
  const assertionOnly = validatePRMetadata(
    [
      "Task ID: SHELL-04",
      "Release gate: R1",
      "Core-loop impact: Continue into R1.",
      "Scope decision: Rebuild",
      "### Acceptance evidence",
      "R0 complete, trust me.",
    ].join("\n"),
    ["packages/app/app.config.ts"],
  )
  const governanceOnly = [
    validatePRMetadata("", ["script/experience-gate.ts"]),
    validatePRMetadata("", [".github/workflows/test.yml"]),
  ]
  if (
    valid.errors.length ||
    invalid.errors.length !== 5 ||
    assertionOnly.errors.length !== 1 ||
    governanceOnly.some((result) => !result.relevant || result.errors.length !== 5)
  )
    throw new Error("PR metadata self-test failed.")
  return {
    relevantScopes: relevantPrefixes,
    validCaseErrors: valid.errors.length,
    invalidCaseErrors: invalid.errors.length,
    assertionOnlyErrors: assertionOnly.errors.length,
    governanceOnlyErrors: governanceOnly.map((result) => result.errors.length),
  }
}

if (import.meta.main) {
  if (Bun.argv.includes("--self-test")) {
    console.log(JSON.stringify(runSelfTest(), null, 2))
  } else {
    const result = validatePRMetadata(process.env.PR_BODY ?? "", changedFilesFromEnvironment())
    if (result.errors.length) {
      result.errors.forEach((error) => console.error(error))
      process.exit(1)
    }
    console.log(result.relevant ? "Experience refactor metadata is valid." : "No governed experience files changed.")
  }
}
