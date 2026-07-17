import z from "zod"

// ---------------------------------------------------------------------------
// Task rating — determines grading rigor
// ---------------------------------------------------------------------------

export const TaskRating = z.enum(["company", "project", "individual"])
export type TaskRating = z.infer<typeof TaskRating>

// ---------------------------------------------------------------------------
// Finding — actionable item from grading
// ---------------------------------------------------------------------------

export const FindingSeverity = z.enum(["blocker", "warning", "info"])
export type FindingSeverity = z.infer<typeof FindingSeverity>

export const Finding = z.object({
  /** What was found — concrete, specific item */
  item: z.string(),
  /** How to verify the issue is fixed — actionable steps */
  howToVerify: z.string(),
  /** blocker = must fix before acceptance; warning = should fix but not blocking */
  severity: FindingSeverity,
})
export type Finding = z.infer<typeof Finding>

// ---------------------------------------------------------------------------
// Admission result
// ---------------------------------------------------------------------------

export const AdmissionResult = z.object({
  /** Whether the submission passed grading */
  passed: z.boolean(),
  /** Findings from the grading pass */
  findings: z.array(Finding),
  /** The task rating that was applied */
  taskRating: TaskRating,
})
export type AdmissionResult = z.infer<typeof AdmissionResult>

// ---------------------------------------------------------------------------
// Submission — what gets graded
// ---------------------------------------------------------------------------

export const WorkType = z.enum(["coding", "non_coding"])
export type WorkType = z.infer<typeof WorkType>

export const CodingSubmission = z.object({
  kind: z.literal("coding"),
  /** Whether tests passed */
  testsPassed: z.boolean(),
  /** Whether lint is clean */
  lintClean: z.boolean(),
  /** Whether build succeeds */
  buildSucceeds: z.boolean(),
  /** Optional: test output for findings */
  testOutput: z.string().optional(),
  /** Optional: lint output for findings */
  lintOutput: z.string().optional(),
  /** Optional: build output for findings */
  buildOutput: z.string().optional(),
})
export type CodingSubmission = z.infer<typeof CodingSubmission>

export const NonCodingSubmission = z.object({
  kind: z.literal("non_coding"),
  /** Free-text description of what was delivered */
  deliverable: z.string(),
  /** Acceptance criteria to check against */
  acceptanceCriteria: z.array(z.string()),
})
export type NonCodingSubmission = z.infer<typeof NonCodingSubmission>

export const Submission = z.discriminatedUnion("kind", [CodingSubmission, NonCodingSubmission])
export type Submission = z.infer<typeof Submission>

// ---------------------------------------------------------------------------
// Org layer → task rating mapping
// ---------------------------------------------------------------------------

export const ORG_LAYER_TO_RATING: Record<string, TaskRating> = {
  board: "company",
  department: "project",
  project: "individual",
  execution: "individual",
  tool: "individual",
}
