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
// LLM-based non-coding evaluation
// ---------------------------------------------------------------------------

interface CriterionEvaluation {
  criterionIndex: number
  met: boolean
  reasoning: string
}

/** Try LLM-based evaluation; return undefined on failure. */
function evaluateDeliverableWithLLM(
  deliverable: string,
  criteria: string[],
): Promise<CriterionEvaluation[] | undefined> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return Promise.resolve(undefined)

  const prompt = [
    "You are an admission grader. Evaluate a deliverable against each acceptance criterion.",
    "",
    "Deliverable (truncated to 4000 chars):",
    deliverable.slice(0, 4000),
    "",
    "Acceptance Criteria:",
    ...criteria.map((c, i) => `  ${i}: ${c}`),
    "",
    "For each criterion, output a JSON object with keys:",
    '  "criterionIndex": <index>,',
    '  "met": <true or false>,',
    '  "reasoning": "<one-sentence explanation>"',
    "",
    "Output a JSON array of objects, one per criterion. Only output valid JSON.",
  ].join("\n")

  return fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    }),
  })
    .then((r) => {
      if (!r.ok) return undefined
      return r.json()
    })
    .then((data) => {
      const content = data?.choices?.[0]?.message?.content
      if (!content) return undefined
      const parsed = JSON.parse(content)
      return Array.isArray(parsed) ? parsed : undefined
    })
    .catch(() => undefined)
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
): Effect.Effect<Finding[]> {
  return Effect.gen(function* () {
    const findings: Finding[] = []

    // Try LLM-based evaluation first; swallow errors and fall back to keyword matching
    const llmEvaluations = yield* Effect.tryPromise({
      try: () => evaluateDeliverableWithLLM(submission.deliverable, submission.acceptanceCriteria),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined as CriterionEvaluation[] | undefined))

    if (llmEvaluations && Array.isArray(llmEvaluations)) {
      for (const ev of llmEvaluations) {
        if (!ev.met) {
          findings.push({
            item: `Acceptance criterion not met: "${submission.acceptanceCriteria[ev.criterionIndex] ?? "Unknown"}"`,
            howToVerify: ev.reasoning ?? "Review the deliverable against this criterion",
            severity: profile.blockerThreshold === "warning" ? "blocker" : "warning",
          })
        }
      }
      return findings
    }

    // Fallback: improved keyword matching (70% threshold, more lenient)
    for (const criterion of submission.acceptanceCriteria) {
      const keyTerms = extractKeyTerms(criterion)
      const missingTerms = keyTerms.filter(
        (term) => !submission.deliverable.toLowerCase().includes(term.toLowerCase()),
      )

      const missingRatio = missingTerms.length / Math.max(keyTerms.length, 1)
      if (keyTerms.length > 0 && missingRatio > 0.7) {
        findings.push({
          item: `Acceptance criterion may not be fully addressed: "${criterion}"`,
          howToVerify: `Review the deliverable and ensure it covers: ${missingTerms.join(", ")}`,
          severity: "warning",
        })
      }
    }

    // At company level, require cross-validation
    if (profile.requireCrossValidation && submission.acceptanceCriteria.length > 0) {
      findings.push({
        item: "Cross-validation required for company-level work",
        howToVerify: "Ensure a peer agent has reviewed the deliverable against all acceptance criteria.",
        severity: "warning",
      })
    }

    return findings
  })
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
): Effect.Effect<AdmissionResult> {
  return Effect.gen(function* () {
    const profile = RIGOR_PROFILES[taskRating]

    const findings: Finding[] =
      submission.kind === "coding"
        ? (yield* Effect.succeed(gradeCodingSubmission(submission, profile)))
        : (yield* gradeNonCodingSubmission(submission, profile))

    const hasBlockers = findings.some((f) => f.severity === "blocker")

    return {
      passed: !hasBlockers,
      findings,
      taskRating,
    }
  })
}

// ---------------------------------------------------------------------------
// Self-check (shift-left) — same criteria, relaxed severity
// ---------------------------------------------------------------------------

function selfCheckCore(
  submission: Submission,
  taskRating: TaskRating,
): Effect.Effect<AdmissionResult> {
  return Effect.gen(function* () {
    const profile = RIGOR_PROFILES[taskRating]

    const findings: Finding[] =
      submission.kind === "coding"
        ? yield* Effect.succeed(gradeCodingSubmission(submission as CodingSubmission, profile))
        : yield* gradeNonCodingSubmission(submission as NonCodingSubmission, profile)

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
  })
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

export class Service extends Context.Service<Service, Interface>()("@control-plane/Admission") {}

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
      return yield* gradeCore(submission, taskRating)
    })

    const selfCheck = Effect.fn("Admission.selfCheck")(function* (
      submission: Submission,
      taskRating: TaskRating,
    ) {
      return yield* selfCheckCore(submission, taskRating)
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
