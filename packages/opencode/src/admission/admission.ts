import { Context, Effect, Layer } from "effect"
import type {
  TaskRating,
  Finding,
  FindingSeverity,
  AdmissionResult,
  Submission,
  CodingSubmission,
  NonCodingSubmission,
} from "./schema"
import { ORG_LAYER_TO_RATING } from "./schema"

// ---------------------------------------------------------------------------
// Severity hierarchy for self-check relaxation
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: FindingSeverity[] = ["info", "warning", "blocker"]

/** Drop severity by one level for self-check (blocker→warning, warning→info). */
function relaxSeverity(severity: FindingSeverity): FindingSeverity {
  const idx = SEVERITY_ORDER.indexOf(severity)
  return idx > 0 ? SEVERITY_ORDER[idx - 1] : "info"
}

// ---------------------------------------------------------------------------
// Rigor profiles per task rating
// ---------------------------------------------------------------------------

interface RigorProfile {
  /** Whether to require cross-validation (company-level only) */
  requireCrossValidation: boolean
  /** Whether to require strong model (company-level only) */
  requireStrongModel: boolean
  /** Minimum severity that counts as blocker */
  blockerThreshold: FindingSeverity
  /** Description of the rigor level */
  description: string
}

const RIGOR_PROFILES: Record<TaskRating, RigorProfile> = {
  company: {
    requireCrossValidation: true,
    requireStrongModel: true,
    blockerThreshold: "warning", // Everything counts as blocker at company level
    description: "Company-level: cross-validation required, strong model, simulation checks",
  },
  project: {
    requireCrossValidation: false,
    requireStrongModel: false,
    blockerThreshold: "blocker",
    description: "Project-level: standard review, medium rigor",
  },
  individual: {
    requireCrossValidation: false,
    requireStrongModel: false,
    blockerThreshold: "blocker",
    description: "Individual-level: lightweight self-check",
  },
}

// ---------------------------------------------------------------------------
// Grading logic
// ---------------------------------------------------------------------------

function gradeCodingSubmission(submission: CodingSubmission, profile: RigorProfile): Finding[] {
  const findings: Finding[] = []

  if (!submission.testsPassed) {
    findings.push({
      item: "Tests failing",
      howToVerify: "Run the test suite and confirm all tests pass. Check test output for specific failure messages.",
      severity: "blocker",
    })
  }

  if (!submission.lintClean) {
    findings.push({
      item: "Lint errors present",
      howToVerify: "Run the linter (e.g., `bun run lint`) and fix all reported issues.",
      severity: profile.blockerThreshold === "warning" ? "blocker" : "warning",
    })
  }

  if (!submission.buildSucceeds) {
    findings.push({
      item: "Build failing",
      howToVerify: "Run the build command (e.g., `bun run build`) and resolve all compilation/bundling errors.",
      severity: "blocker",
    })
  }

  // At company level, also check for simulation/cross-validation indicators
  if (profile.requireCrossValidation) {
    // This is a signal that the submission should have been cross-validated
    // The actual cross-validation happens at the delegation layer
    findings.push({
      item: "Cross-validation required for company-level work",
      howToVerify: "Ensure a peer agent has reviewed and validated the submission independently.",
      severity: "warning",
    })
  }

  return findings
}

function gradeNonCodingSubmission(
  submission: NonCodingSubmission,
  profile: RigorProfile,
): Finding[] {
  const findings: Finding[] = []

  // Check each acceptance criterion against the deliverable
  for (const criterion of submission.acceptanceCriteria) {
    // Simple heuristic: check if key terms from the criterion appear in the deliverable
    // In Phase 3, this will be delegated to an LLM-based adapter
    const keyTerms = extractKeyTerms(criterion)
    const missingTerms = keyTerms.filter(
      (term) => !submission.deliverable.toLowerCase().includes(term.toLowerCase()),
    )

    if (missingTerms.length > 0 && missingTerms.length === keyTerms.length) {
      // All key terms missing — likely didn't address this criterion
      findings.push({
        item: `Acceptance criterion not addressed: "${criterion}"`,
        howToVerify: `Review the deliverable and ensure it explicitly addresses: ${criterion}`,
        severity: profile.blockerThreshold === "warning" ? "blocker" : "warning",
      })
    } else if (missingTerms.length > 0) {
      // Some terms missing — partially addressed
      findings.push({
        item: `Acceptance criterion partially addressed: "${criterion}"`,
        howToVerify: `Verify the deliverable covers these aspects: ${missingTerms.join(", ")}`,
        severity: "warning",
      })
    }
  }

  // At company level, require more thorough coverage
  if (profile.requireCrossValidation && submission.acceptanceCriteria.length > 0) {
    findings.push({
      item: "Cross-validation required for company-level work",
      howToVerify: "Ensure a peer agent has reviewed the deliverable against all acceptance criteria.",
      severity: "warning",
    })
  }

  return findings
}

/** Extract key terms from an acceptance criterion for matching. */
function extractKeyTerms(criterion: string): string[] {
  // Remove common words and extract meaningful terms
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "shall",
    "can",
    "that",
    "which",
    "who",
    "whom",
    "this",
    "these",
    "those",
    "it",
    "its",
    "and",
    "or",
    "but",
    "if",
    "then",
    "else",
    "when",
    "where",
    "how",
    "what",
    "why",
    "not",
    "no",
    "nor",
    "so",
    "yet",
    "both",
    "either",
    "neither",
    "each",
    "every",
    "all",
    "any",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "than",
    "too",
    "very",
    "just",
    "about",
    "above",
    "after",
    "again",
    "also",
    "am",
    "as",
    "at",
    "before",
    "between",
    "by",
    "during",
    "for",
    "from",
    "in",
    "into",
    "of",
    "on",
    "out",
    "over",
    "through",
    "to",
    "under",
    "up",
    "with",
  ])

  return criterion
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))
}

// ---------------------------------------------------------------------------
// Core grading function
// ---------------------------------------------------------------------------

function gradeCore(
  submission: Submission,
  taskRating: TaskRating,
): AdmissionResult {
  const profile = RIGOR_PROFILES[taskRating]

  const findings: Finding[] =
    submission.kind === "coding"
      ? gradeCodingSubmission(submission, profile)
      : gradeNonCodingSubmission(submission, profile)

  // Determine pass/fail: any blocker findings = fail
  const hasBlockers = findings.some((f) => f.severity === "blocker")

  return {
    passed: !hasBlockers,
    findings,
    taskRating,
  }
}

// ---------------------------------------------------------------------------
// Self-check (shift-left) — same criteria, relaxed severity
// ---------------------------------------------------------------------------

function selfCheckCore(
  submission: Submission,
  taskRating: TaskRating,
): AdmissionResult {
  const profile = RIGOR_PROFILES[taskRating]

  const findings: Finding[] =
    submission.kind === "coding"
      ? gradeCodingSubmission(submission, profile)
      : gradeNonCodingSubmission(submission, profile)

  // Relax all severities by one level for self-check
  const relaxedFindings = findings.map((f) => ({
    ...f,
    severity: relaxSeverity(f.severity),
  }))

  // At self-check level, only blockers block
  const hasBlockers = relaxedFindings.some((f) => f.severity === "blocker")

  return {
    passed: !hasBlockers,
    findings: relaxedFindings,
    taskRating,
  }
}

// ---------------------------------------------------------------------------
// Resolve task rating from org layer
// ---------------------------------------------------------------------------

function resolveRating(orgLayer: string | undefined): TaskRating {
  if (!orgLayer) return "individual"
  return ORG_LAYER_TO_RATING[orgLayer] ?? "individual"
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface Interface {
  /** Grade a submission against criteria at the given rigor level */
  readonly grade: (
    submission: Submission,
    taskRating: TaskRating,
  ) => Effect.Effect<AdmissionResult>

  /** Shift-left self-check: same criteria, relaxed severity */
  readonly selfCheck: (
    submission: Submission,
    taskRating: TaskRating,
  ) => Effect.Effect<AdmissionResult>

  /** Resolve task rating from an agent's org_layer */
  readonly resolveRating: (orgLayer: string | undefined) => TaskRating

  /** Build a human-readable rejection message from findings */
  readonly buildRejectionMessage: (result: AdmissionResult) => string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Admission") {}

// ---------------------------------------------------------------------------
// Layer — pure logic, no external dependencies
// ---------------------------------------------------------------------------

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const grade = Effect.fn("Admission.grade")(function* (
      submission: Submission,
      taskRating: TaskRating,
    ) {
      return gradeCore(submission, taskRating)
    })

    const selfCheck = Effect.fn("Admission.selfCheck")(function* (
      submission: Submission,
      taskRating: TaskRating,
    ) {
      return selfCheckCore(submission, taskRating)
    })

    const buildRejectionMessage = (result: AdmissionResult): string => {
      if (result.passed) return ""

      const blockers = result.findings.filter((f) => f.severity === "blocker")
      const warnings = result.findings.filter((f) => f.severity === "warning")

      const lines: string[] = [
        `Submission rejected (${result.taskRating}-level grading).`,
        "",
      ]

      if (blockers.length > 0) {
        lines.push("## Blockers (must fix)")
        for (const f of blockers) {
          lines.push(`- **${f.item}**`)
          lines.push(`  How to verify: ${f.howToVerify}`)
        }
        lines.push("")
      }

      if (warnings.length > 0) {
        lines.push("## Warnings (should fix)")
        for (const f of warnings) {
          lines.push(`- **${f.item}**`)
          lines.push(`  How to verify: ${f.howToVerify}`)
        }
        lines.push("")
      }

      return lines.join("\n")
    }

    return { grade, selfCheck, resolveRating, buildRejectionMessage }
  }),
)

export const defaultLayer = layer
