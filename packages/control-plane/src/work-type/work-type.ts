import { Context, Effect, Layer } from "effect"
import { KnowledgeReadingReceipt } from "@/company-reading/schema"
import type { WorkTypeID, WorkTypeDef, ArtifactType, VerifyResult } from "./schema"

// ---------------------------------------------------------------------------
// Tool ID constants — matches IDs from tool/registry.ts
// ---------------------------------------------------------------------------

const TOOL = {
  bash: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  glob: "glob",
  grep: "grep",
  apply_patch: "apply_patch",
  websearch: "websearch",
  webfetch: "webfetch",
  read_doc: "read_doc",
  codesearch: "codesearch",
  memory: "memory",
  history: "history",
  skill: "skill",
} as const

// ---------------------------------------------------------------------------
// VerifyFn — how each work type checks its output
// ---------------------------------------------------------------------------

/** Input for the verify function */
export interface VerifyInput {
  /** Work-type-specific submission data */
  submission: unknown
  /** Optional org layer for rigor calibration */
  orgLayer?: string
  researchMode?: "evidence" | "hypothesis_synthesis"
}

export type VerifyFn = (input: VerifyInput) => Effect.Effect<VerifyResult>

// ---------------------------------------------------------------------------
// Extended work type with verify function
// ---------------------------------------------------------------------------

export interface WorkTypeEntry {
  def: WorkTypeDef
  verify: VerifyFn
}

// ---------------------------------------------------------------------------
// Built-in adapters
// ---------------------------------------------------------------------------

function makeWorkType(
  id: string,
  name: string,
  tools: readonly string[],
  artifactType: ArtifactType,
  description: string,
  verify: VerifyFn,
): WorkTypeEntry {
  return {
    def: { id: id as WorkTypeID, name, tools, artifactType, description },
    verify,
  }
}

// -- Coding adapter --------------------------------------------------------

interface CodingSubmission {
  testsPassed: boolean
  lintClean: boolean
  buildSucceeds: boolean
  testOutput?: string
  lintOutput?: string
  buildOutput?: string
}

const codingVerify: VerifyFn = (input) =>
  Effect.gen(function* () {
    const sub = input.submission as CodingSubmission
    const findings: string[] = []

    if (!sub.testsPassed) {
      findings.push("Tests failing — run the test suite and fix all failures")
    }
    if (!sub.lintClean) {
      findings.push("Lint errors present — run the linter and fix all issues")
    }
    if (!sub.buildSucceeds) {
      findings.push("Build failing — resolve compilation/bundling errors")
    }

    return { passed: findings.length === 0, findings }
  })

const coding = makeWorkType(
  "coding",
  "Coding",
  [TOOL.bash, TOOL.read, TOOL.write, TOOL.edit, TOOL.glob, TOOL.grep, TOOL.apply_patch, TOOL.memory, TOOL.history, TOOL.skill],
  "code",
  "Software implementation: writing, editing, testing, and debugging code in a git repository.",
  codingVerify,
)

// -- Decision/Planning adapter (PRIORITY) ----------------------------------

interface DecisionSubmission {
  question: string
  approaches: Array<{
    id: string
    title: string
    description: string
    pros: string[]
    cons: string[]
    score?: number
    rationale?: string
  }>
  recommendedId: string
  reasoning: string
}

const decisionVerify: VerifyFn = (input) =>
  Effect.gen(function* () {
    const sub = input.submission as DecisionSubmission
    const findings: string[] = []

    // Must have at least 2 approaches for multi-plan comparison
    if (!sub.approaches || sub.approaches.length < 2) {
      findings.push(
        "Decision requires at least 2 distinct approaches for comparison — generate additional options",
      )
    }

    // Each approach must have pros and cons
    for (const approach of sub.approaches ?? []) {
      if (!approach.pros || approach.pros.length === 0) {
        findings.push(`Approach "${approach.title}" has no documented pros — enumerate advantages`)
      }
      if (!approach.cons || approach.cons.length === 0) {
        findings.push(`Approach "${approach.title}" has no documented cons — enumerate disadvantages`)
      }
    }

    // Must recommend one of the approaches
    const recommendedExists = sub.approaches?.some((a) => a.id === sub.recommendedId)
    if (!recommendedExists) {
      findings.push(
        `Recommended approach "${sub.recommendedId}" not found in the generated approaches`,
      )
    }

    // Must have reasoning for the recommendation
    if (!sub.reasoning || sub.reasoning.trim().length === 0) {
      findings.push("Decision lacks reasoning — explain why the recommended approach was chosen")
    }

    // Scored approaches must have scores
    const scored = sub.approaches?.filter((a) => a.score !== undefined)
    if (scored && scored.length > 0 && scored.length < (sub.approaches?.length ?? 0)) {
      findings.push(
        "Some approaches are scored and some are not — score all approaches for consistent comparison",
      )
    }

    return { passed: findings.length === 0, findings }
  })

const decision = makeWorkType(
  "decision",
  "Decision / Planning",
  [TOOL.websearch, TOOL.webfetch, TOOL.read_doc, TOOL.memory, TOOL.history],
  "document",
  "Strategic decisions and planning: generate multiple approaches, evaluate trade-offs, and recommend the best option. Used by board roundtable and department-level planning.",
  decisionVerify,
)

// -- Research adapter ------------------------------------------------------

interface ResearchSubmission {
  question: string
  summary: string
  findings: string[]
  sources: Array<{ url?: string; title: string; relevantExcerpt: string }>
  crossValidated: boolean
}

const researchVerify: VerifyFn = (input) =>
  Effect.gen(function* () {
    const sub = input.submission as ResearchSubmission
    const findings: string[] = []

    if (input.researchMode !== "hypothesis_synthesis" && (!sub.sources || sub.sources.length === 0)) {
      findings.push("Research has no cited sources — include at least one verifiable source")
    }

    if (!sub.findings || sub.findings.length === 0) {
      findings.push("Research has no findings — document concrete discoveries")
    }

    if (input.researchMode !== "hypothesis_synthesis" && !sub.crossValidated) {
      findings.push(
        "Research is not cross-validated — verify key claims against at least two independent sources",
      )
    }

    // Check that sources have excerpts
    for (const source of sub.sources ?? []) {
      if (!source.relevantExcerpt || source.relevantExcerpt.trim().length === 0) {
        findings.push(`Source "${source.title}" lacks a relevant excerpt — include supporting text`)
      }
    }

    return { passed: findings.length === 0, findings }
  })

const research = makeWorkType(
  "research",
  "Research",
  [TOOL.websearch, TOOL.webfetch, TOOL.read_doc, TOOL.codesearch, TOOL.memory],
  "document",
  "Information gathering: web search, source analysis, and report generation with citations.",
  researchVerify,
)

// -- Non-coding adapters (structured verification) -----------------------

interface WritingSubmission {
  content: string
  sections?: string[]
  wordCount?: number
}

interface DesignSubmission {
  artifacts: Array<{ type: string; description: string }>
  constraints: string[]
  notes?: string
}

interface AnalysisSubmission {
  question: string
  dataSources: string[]
  methodology: string
  findings: string[]
  conclusions: string[]
  limitations?: string[]
}

const writingVerify: VerifyFn = (input) =>
  Effect.gen(function* () {
    const sub = input.submission as WritingSubmission
    const findings: string[] = []

    if (!sub.content || sub.content.trim().length < 100) {
      findings.push("Document content is too short — expand to at least 100 characters with substantive content")
    }

    // Check for basic structure (headings or numbered sections)
    const hasStructure = /^#{1,6}\s+/m.test(sub.content) || /^(Section|Chapter|\d+\.)/m.test(sub.content)
    if (!hasStructure) {
      findings.push("Document lacks structure — add Markdown headings, numbered sections, or clear chapter breaks")
    }

    // Check for readability (basic: average sentence length)
    const sentences = sub.content.split(/[.!?。！？]+/).filter((s: string) => s.trim().length > 0)
    if (sentences.length > 3) {
      const avgWords = sentences.reduce((sum: number, s: string) => sum + s.trim().split(/\s+/).length, 0) / sentences.length
      if (avgWords > 30) {
        findings.push("Sentences are very long (avg >30 words) — break them up for readability")
      }
    }

    return { passed: findings.length === 0, findings }
  })

const writing = makeWorkType(
  "writing",
  "Writing",
  [TOOL.websearch, TOOL.webfetch, TOOL.read_doc, TOOL.read, TOOL.memory],
  "document",
  "Document creation: technical writing, documentation, reports, and content generation.",
  writingVerify,
)

const designVerify: VerifyFn = (input) =>
  Effect.gen(function* () {
    const sub = input.submission as DesignSubmission
    const findings: string[] = []

    if (!sub.artifacts || sub.artifacts.length === 0) {
      findings.push("Design has no artifacts — describe each design output (type, description)")
    }

    // Each artifact must have a description
    for (const art of sub.artifacts ?? []) {
      if (!art.description || art.description.trim().length < 10) {
        findings.push(`Artifact "${art.type}" needs a fuller description (min 10 chars)`)
      }
    }

    if (!sub.constraints || sub.constraints.length === 0) {
      findings.push("Design constraints not documented — list technical, business, and user constraints")
    }

    return { passed: findings.length === 0, findings }
  })

const design = makeWorkType(
  "design",
  "Design",
  [TOOL.websearch, TOOL.webfetch, TOOL.read_doc, TOOL.read, TOOL.memory, TOOL.glob],
  "design",
  "Design work: architecture diagrams, UI/UX designs, system designs.",
  designVerify,
)

const analysisVerify: VerifyFn = (input) =>
  Effect.gen(function* () {
    const sub = input.submission as AnalysisSubmission
    const findings: string[] = []

    if (!sub.dataSources || sub.dataSources.length === 0) {
      findings.push("Analysis has no data sources — list the data, datasets, or inputs used")
    }

    if (!sub.methodology || sub.methodology.trim().length < 20) {
      findings.push("Methodology is missing or too brief — explain how the analysis was performed")
    }

    if (!sub.findings || sub.findings.length === 0) {
      findings.push("Analysis has no findings — document concrete discoveries or patterns")
    }

    if (!sub.conclusions || sub.conclusions.length === 0) {
      findings.push("Analysis has no conclusions — state what the findings imply")
    }

    // Findings should be substantively described
    for (const finding of sub.findings ?? []) {
      if (typeof finding === "string" && finding.trim().length < 15) {
        findings.push("Each finding should be substantively described (min ~15 chars)")
        break
      }
    }

    return { passed: findings.length === 0, findings }
  })

const analysis = makeWorkType(
  "analysis",
  "Analysis",
  [TOOL.websearch, TOOL.webfetch, TOOL.read_doc, TOOL.read, TOOL.glob, TOOL.grep, TOOL.memory],
  "analysis",
  "Data analysis: code analysis, metrics analysis, market research synthesis.",
  analysisVerify,
)

const knowledgeReadingVerify: VerifyFn = (input) =>
  Effect.succeed(
    KnowledgeReadingReceipt.safeParse(input.submission).success
      ? { passed: true, findings: [] }
      : {
          passed: false,
          findings: [
            "Knowledge reading receipt must include every structured interpretation field and source chunk span evidence",
          ],
        },
  )

const knowledgeReading = makeWorkType(
  "knowledge_reading",
  "Knowledge reading",
  [],
  "analysis",
  "Read one persisted Commons source and return a cited Interpretation without external, graph, policy, asset, belief, or skill writes.",
  knowledgeReadingVerify,
)

// ---------------------------------------------------------------------------
// Built-in registry
// ---------------------------------------------------------------------------

const BUILTIN_TYPES: readonly WorkTypeEntry[] = [
  coding,
  decision,
  research,
  writing,
  design,
  analysis,
  knowledgeReading,
]

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface Interface {
  /** Look up a work type by ID */
  readonly get: (id: WorkTypeID) => Effect.Effect<WorkTypeEntry | undefined>
  /** List all registered work types */
  readonly list: () => Effect.Effect<readonly WorkTypeEntry[]>
  /** Register a custom work type at runtime */
  readonly register: (entry: WorkTypeEntry) => Effect.Effect<void>
  /** Verify a submission against its work type's verification rules */
  readonly verify: (id: WorkTypeID, input: VerifyInput) => Effect.Effect<VerifyResult>
  /** Get only the tool IDs for a given work type */
  readonly toolsFor: (id: WorkTypeID) => Effect.Effect<readonly string[]>
  /** Decision flow helper: diverge → evaluate → converge */
  readonly decisionFlow: (question: string, context: string) => Effect.Effect<DecisionFlowGuide>
}

/** Guide for the three-phase decision flow */
export interface DecisionFlowGuide {
  /** Phase 1: Generate multiple distinct approaches */
  readonly diverge: () => Effect.Effect<DecisionDivergeGuide>
  /** Phase 2: Score and evaluate each approach */
  readonly evaluate: (approaches: DecisionDivergeResult) => Effect.Effect<DecisionEvaluateGuide>
  /** Phase 3: Recommend the best approach */
  readonly converge: (evaluated: DecisionEvaluateResult) => Effect.Effect<DecisionConvergeGuide>
}

export interface DecisionDivergeGuide {
  readonly instruction: string
  readonly minApproaches: number
  readonly question: string
  readonly context: string
}

export interface DecisionDivergeResult {
  approaches: Array<{
    id: string
    title: string
    description: string
    pros: string[]
    cons: string[]
  }>
}

export interface DecisionEvaluateGuide {
  readonly instruction: string
  readonly criteria: readonly string[]
}

export interface DecisionEvaluateResult {
  approaches: Array<{
    id: string
    title: string
    description: string
    pros: string[]
    cons: string[]
    score: number
    rationale: string
  }>
}

export interface DecisionConvergeGuide {
  readonly instruction: string
  readonly minRequirements: readonly string[]
}

export interface DecisionConvergeResult {
  question: string
  approaches: DecisionEvaluateResult["approaches"]
  recommendedId: string
  reasoning: string
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Service extends Context.Service<Service, Interface>()("@control-plane/WorkType") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = new Map<string, WorkTypeEntry>(BUILTIN_TYPES.map((e) => [e.def.id, e]))

    const get: Interface["get"] = (id) =>
      Effect.succeed(registry.get(id))

    const list: Interface["list"] = () =>
      Effect.succeed(Array.from(registry.values()))

    const register: Interface["register"] = (entry) =>
      Effect.sync(() => {
        registry.set(entry.def.id, entry)
      })

    const verify: Interface["verify"] = (id, input) =>
      Effect.gen(function* () {
        const entry = registry.get(id)
        if (!entry) {
          return { passed: false, findings: [`Unknown work type: ${id}`] }
        }
        return yield* entry.verify(input)
      })

    const toolsFor: Interface["toolsFor"] = (id) =>
      Effect.gen(function* () {
        const entry = registry.get(id)
        if (!entry) return []
        return entry.def.tools
      })

    // -- Decision flow guide ------------------------------------------------

    const EVALUATION_CRITERIA = [
      "Feasibility — can this approach be implemented with available resources?",
      "Impact — how significantly does this approach address the problem?",
      "Risk — what are the downsides and how likely are they?",
      "Effort — how much time and work does this approach require?",
      "Reversibility — how easily can this decision be changed if wrong?",
    ]

    const decisionFlow: Interface["decisionFlow"] = (question, context) =>
      Effect.succeed({
        diverge: () =>
          Effect.succeed({
            instruction: [
              `Generate at least 2 distinct approaches for: ${question}`,
              "",
              "Each approach must:",
              "- Have a clear title and description",
              "- List concrete pros (advantages)",
              "- List concrete cons (disadvantages)",
              "- Be meaningfully different from other approaches (not just variations)",
              "",
              "Context:",
              context,
            ].join("\n"),
            minApproaches: 2,
            question,
            context,
          }),

        evaluate: (divergeResult) =>
          Effect.succeed({
            instruction: [
              "Score each approach on a 0-100 scale using these criteria:",
              ...EVALUATION_CRITERIA.map((c) => `  - ${c}`),
              "",
              "For each approach provide:",
              "- A numeric score (0-100)",
              "- A rationale explaining the score",
              "",
              `Evaluating ${divergeResult.approaches.length} approaches.`,
            ].join("\n"),
            criteria: EVALUATION_CRITERIA,
          }),

        converge: (evaluated) =>
          Effect.succeed({
            instruction: [
              "From the evaluated approaches, recommend the single best option.",
              "",
              "Your recommendation must:",
              "- Reference the highest-scored approach (or justify why not)",
              "- Explain the key trade-offs that led to this choice",
              "- Acknowledge risks and mitigation strategies",
              "- Be actionable with clear next steps",
            ].join("\n"),
            minRequirements: [
              "Must select one approach as recommended",
              "Must explain why it was chosen over alternatives",
              "Must acknowledge risks",
            ],
          }),
      })

    return Service.of({ get, list, register, verify, toolsFor, decisionFlow })
  }),
)

export const defaultLayer = layer
