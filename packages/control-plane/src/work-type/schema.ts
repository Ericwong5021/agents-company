import z from "zod"

// ---------------------------------------------------------------------------
// Artifact type — what a work type produces
// ---------------------------------------------------------------------------

export const ArtifactType = z.enum(["code", "document", "analysis", "design"])
export type ArtifactType = z.infer<typeof ArtifactType>

// ---------------------------------------------------------------------------
// Work type ID — branded string
// ---------------------------------------------------------------------------

export const WorkTypeID = z.string().brand<"WorkTypeID">()
export type WorkTypeID = z.infer<typeof WorkTypeID>

// ---------------------------------------------------------------------------
// Verification outcome
// ---------------------------------------------------------------------------

export const VerifyResult = z.object({
  passed: z.boolean(),
  findings: z.array(z.string()),
})
export type VerifyResult = z.infer<typeof VerifyResult>

// ---------------------------------------------------------------------------
// Work type definition — the universal contract
// ---------------------------------------------------------------------------

export const WorkTypeDef = z.object({
  /** Unique identifier for this work type */
  id: WorkTypeID,
  /** Human-readable name */
  name: z.string(),
  /** Tool IDs available to agents doing this type of work */
  tools: z.array(z.string()).readonly(),
  /** What kind of artifact this work type produces */
  artifactType: ArtifactType,
  /** Human-readable description of when to use this work type */
  description: z.string(),
})
export type WorkTypeDef = z.infer<typeof WorkTypeDef>

// ---------------------------------------------------------------------------
// Decision-specific types
// ---------------------------------------------------------------------------

/** A single approach option in a decision flow */
export const Approach = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  estimatedEffort: z.string().optional(),
  riskLevel: z.enum(["low", "medium", "high"]).optional(),
})
export type Approach = z.infer<typeof Approach>

/** Scored approach after evaluation */
export const ScoredApproach = Approach.extend({
  score: z.number().min(0).max(100),
  rationale: z.string(),
})
export type ScoredApproach = z.infer<typeof ScoredApproach>

/** The full decision result artifact */
export const DecisionResult = z.object({
  question: z.string(),
  approaches: z.array(ScoredApproach),
  recommended: z.string(), // approach id
  reasoning: z.string(),
})
export type DecisionResult = z.infer<typeof DecisionResult>

// ---------------------------------------------------------------------------
// Research-specific types
// ---------------------------------------------------------------------------

export const Source = z.object({
  url: z.string().optional(),
  title: z.string(),
  relevantExcerpt: z.string(),
})
export type Source = z.infer<typeof Source>

export const ResearchResult = z.object({
  question: z.string(),
  summary: z.string(),
  findings: z.array(z.string()),
  sources: z.array(Source),
  crossValidated: z.boolean(),
})
export type ResearchResult = z.infer<typeof ResearchResult>
