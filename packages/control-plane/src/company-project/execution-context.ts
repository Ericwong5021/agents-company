import { APICallError } from "ai"
import type { Config } from "@/config"
import { ProviderError, type Provider } from "@/provider"
import type { ProviderID } from "@/provider/schema"
import { MessageV2 } from "@/session/message-v2"
import { usable } from "@/session/overflow"
import { estimate } from "@/util/token"
import type { AcceptanceFact, ApprovalGate, Artifact, Project, WorkAttempt, WorkItem, WorkReceipt } from "./schema"

const DEFAULT_USABLE_INPUT_TOKENS = 48_000
const MAX_PROMPT_TOKENS = 96_000
const PROMPT_SHARE = 0.6
const EVIDENCE_SHARE = 0.75
const MAX_REFERENCE_SAMPLES = 64

export type TaskContextBudget = {
  usable_input_tokens: number
  prompt_token_cap: number
  evidence_token_cap: number
  source: "model" | "fallback"
}

export type TaskEvidenceBudgetDiagnostics = {
  code: "ok" | "context_budget_exceeded"
  estimator: "conservative_v1"
  usable_input_tokens: number
  prompt_token_cap: number
  evidence_token_cap: number
  estimated_tokens: number
  estimated_characters: number
  section_tokens: {
    project: number
    task: number
    assignment_context: number
    dependencies: number
    current_gates: number
    recent_failure: number
    references: number
  }
  included: {
    dependencies: number
    acceptance_facts: number
    current_gates: number
    recent_failure: number
    reference_samples: number
  }
  omitted: {
    dependencies: number
    acceptance_facts: number
    current_gates: number
    recent_failure: number
    reference_samples: number
  }
  truncated: boolean
  evidence_digest: string
}

type EvidenceReference = {
  kind: "work_item" | "work_receipt" | "acceptance_fact" | "artifact" | "approval_gate" | "work_attempt"
  id: string
  digest: string
  work_item_id?: string
}

export type TaskEvidence = {
  schema_version: 1
  project: {
    id: string
    status: string
    active_plan_version?: number
    graph_revision: number
    goal_digest: string
  }
  task: {
    id: string
    plan_id: string
    source_task_key?: string
    parent_id?: string
    title: string
    description: string
    kind: string
    work_type: string
    role: string
    capability_packs: string[]
    decision_scope: string[]
    resource_scope: string[]
    inputs: string[]
    expected_outputs: string[]
    validators: string[]
    disposition: string
    depends_on: string[]
    risk_level: string
    validation_mode: string
    acceptance_criteria: string[]
    attempt: number
    max_attempts: number
  }
  assignment_context?: unknown
  dependencies: Array<{
    work_item: {
      id: string
      title: string
      status: string
      review_status: string
      digest: string
    }
    current_acceptance_facts: Array<{
      id: string
      attempt_id: string
      artifact_id: string
      artifact_integrity_sha256: string
      criterion_id: string
      gate_id?: string
      verdict: "passed"
      authority: string
      evaluator: string
      observation: unknown
      evidence_refs: AcceptanceFact["evidence_refs"]
      evidence_sha256: string
      created_at: number
      digest: string
    }>
    latest_receipt?: {
      id: string
      attempt_id: string
      summary: string
      evidence_refs: WorkReceipt["evidence_refs"]
      artifact_refs: Array<{
        id: string
        kind: string
        title: string
        path?: string
        digest: string
      }>
      created_at: number
      digest: string
    }
  }>
  current_gates: Array<{
    id: string
    kind: string
    title: string
    summary: string
    work_item_id?: string
    resource_scope: string[]
    requested_at: number
    digest: string
  }>
  recent_failure?: {
    attempt_id: string
    ordinal: number
    failure_kind?: string
    summary?: string
    finished_at?: number
    digest: string
  }
  references: {
    inventory: Array<{
      kind: EvidenceReference["kind"]
      count: number
      digest: string
    }>
    samples: EvidenceReference[]
  }
}

export type TaskEvidenceSnapshotInput = {
  project: Project
  item: WorkItem
  work_items: readonly WorkItem[]
  artifacts: readonly Artifact[]
  gates: readonly ApprovalGate[]
  attempts: readonly WorkAttempt[]
  receipts: readonly WorkReceipt[]
  acceptance_facts: readonly AcceptanceFact[]
  assignment_context?: unknown
  budget: TaskContextBudget
}

export type ContextOverflowDiagnostic = {
  code: "context_too_large"
  source: "preflight" | "session" | "provider" | "stream"
  message: string
}

export class TaskEvidenceBudgetExceeded extends Error {
  readonly code = "context_budget_exceeded"

  constructor(readonly diagnostics: TaskEvidenceBudgetDiagnostics) {
    super("Task evidence exceeds the execution context budget")
    this.name = "TaskEvidenceBudgetExceeded"
  }
}

export class TaskPromptBudgetExceeded extends Error {
  readonly code = "context_budget_exceeded"

  constructor(
    readonly estimated_tokens: number,
    readonly prompt_token_cap: number,
  ) {
    super(`Task prompt requires ${estimated_tokens} tokens but the execution context budget allows ${prompt_token_cap}`)
    this.name = "TaskPromptBudgetExceeded"
  }
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalized(entry)]),
  )
}

function digest(value: unknown) {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(normalized(value)) ?? "undefined").digest("hex")
}

function conservativeEstimate(value: string) {
  const nonAscii = value.match(/[^\x00-\x7f]/g)?.length ?? 0
  return Math.max(estimate(value), Math.ceil(nonAscii + (value.length - nonAscii) / 4))
}

function size(value: unknown) {
  const text = JSON.stringify(value) ?? "undefined"
  return { characters: text.length, tokens: conservativeEstimate(text) }
}

function boundedText(value: string, maxCharacters: number) {
  if (value.length <= maxCharacters) return { value, truncated: false }
  const marker = `…<sha256:${digest(value)};chars:${value.length}>…`
  const retained = Math.max(0, maxCharacters - marker.length)
  const head = Math.ceil(retained / 2)
  return {
    value: `${value.slice(0, head)}${marker}${value.slice(value.length - (retained - head))}`,
    truncated: true,
  }
}

function boundedValue(value: unknown, maxCharacters: number) {
  const compact = normalized(value)
  const measured = size(compact)
  if (measured.characters <= maxCharacters) return { value: compact, truncated: false }
  return {
    value: { truncated: true, digest: digest(value), characters: measured.characters },
    truncated: true,
  }
}

function dependencyClosure(item: WorkItem, workItems: readonly WorkItem[]) {
  const byID = new Map(workItems.map((candidate) => [candidate.id, candidate]))
  const found = new Set<string>()
  const pending = [...item.depends_on].sort()
  while (pending.length) {
    const id = pending.shift()!
    if (found.has(id)) continue
    found.add(id)
    const dependency = byID.get(id)
    if (dependency) pending.push(...dependency.depends_on.filter((candidate) => !found.has(candidate)).sort())
  }
  return [...found].sort().flatMap((id) => {
    const dependency = byID.get(id)
    return dependency ? [dependency] : []
  })
}

function taskValue(item: WorkItem): TaskEvidence["task"] {
  return {
    id: item.id,
    plan_id: item.plan_id,
    source_task_key: item.source_task_key,
    parent_id: item.parent_id,
    title: item.title,
    description: item.description,
    kind: item.kind,
    work_type: item.work_type,
    role: item.role,
    capability_packs: item.capability_packs,
    decision_scope: item.decision_scope,
    resource_scope: item.resource_scope,
    inputs: item.inputs,
    expected_outputs: item.expected_outputs,
    validators: item.validators,
    disposition: item.disposition,
    depends_on: item.depends_on,
    risk_level: item.risk_level,
    validation_mode: item.validation_mode,
    acceptance_criteria: item.acceptance_criteria,
    attempt: item.attempt,
    max_attempts: item.max_attempts,
  }
}

function references(input: TaskEvidenceSnapshotInput) {
  return [
    ...input.work_items
      .filter((item) => item.id !== input.item.id)
      .map((item) => ({ kind: "work_item" as const, id: item.id, work_item_id: item.id, digest: digest(item) })),
    ...input.receipts.map((receipt) => ({
      kind: "work_receipt" as const,
      id: receipt.id,
      work_item_id: receipt.work_item_id,
      digest: digest(receipt),
    })),
    ...input.acceptance_facts.map((fact) => ({
      kind: "acceptance_fact" as const,
      id: fact.id,
      work_item_id: fact.work_item_id,
      digest: digest(fact),
    })),
    ...input.artifacts.map((artifact) => ({
      kind: "artifact" as const,
      id: artifact.id,
      work_item_id: artifact.work_item_id,
      digest: digest(artifact),
    })),
    ...input.gates.map((gate) => ({
      kind: "approval_gate" as const,
      id: gate.id,
      work_item_id: gate.work_item_id,
      digest: digest(gate),
    })),
    ...input.attempts.map((attempt) => ({
      kind: "work_attempt" as const,
      id: attempt.id,
      work_item_id: attempt.work_item_id,
      digest: digest(attempt),
    })),
  ].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
}

function inventory(all: EvidenceReference[]) {
  return (
    ["work_item", "work_receipt", "acceptance_fact", "artifact", "approval_gate", "work_attempt"] as const
  ).flatMap((kind) => {
    const entries = all.filter((reference) => reference.kind === kind)
    return entries.length ? [{ kind, count: entries.length, digest: digest(entries) }] : []
  })
}

function diagnostics(
  evidence: TaskEvidence,
  budget: TaskContextBudget,
  totals: {
    dependencies: number
    acceptance_facts: number
    gates: number
    recent_failure: number
    reference_samples: number
  },
  truncated: boolean,
  code: TaskEvidenceBudgetDiagnostics["code"] = "ok",
): TaskEvidenceBudgetDiagnostics {
  const measured = size(evidence)
  return {
    code,
    estimator: "conservative_v1",
    usable_input_tokens: budget.usable_input_tokens,
    prompt_token_cap: budget.prompt_token_cap,
    evidence_token_cap: budget.evidence_token_cap,
    estimated_tokens: measured.tokens,
    estimated_characters: measured.characters,
    section_tokens: {
      project: size(evidence.project).tokens,
      task: size(evidence.task).tokens,
      assignment_context: size(evidence.assignment_context ?? null).tokens,
      dependencies: size(evidence.dependencies).tokens,
      current_gates: size(evidence.current_gates).tokens,
      recent_failure: size(evidence.recent_failure ?? null).tokens,
      references: size(evidence.references).tokens,
    },
    included: {
      dependencies: evidence.dependencies.length,
      acceptance_facts: evidence.dependencies.reduce(
        (count, dependency) => count + dependency.current_acceptance_facts.length,
        0,
      ),
      current_gates: evidence.current_gates.length,
      recent_failure: evidence.recent_failure ? 1 : 0,
      reference_samples: evidence.references.samples.length,
    },
    omitted: {
      dependencies: Math.max(0, totals.dependencies - evidence.dependencies.length),
      acceptance_facts: Math.max(
        0,
        totals.acceptance_facts -
          evidence.dependencies.reduce((count, dependency) => count + dependency.current_acceptance_facts.length, 0),
      ),
      current_gates: Math.max(0, totals.gates - evidence.current_gates.length),
      recent_failure: Math.max(0, totals.recent_failure - (evidence.recent_failure ? 1 : 0)),
      reference_samples: Math.max(0, totals.reference_samples - evidence.references.samples.length),
    },
    truncated,
    evidence_digest: digest(evidence),
  }
}

export function defaultTaskContextBudget(): TaskContextBudget {
  const prompt_token_cap = Math.min(MAX_PROMPT_TOKENS, Math.floor(DEFAULT_USABLE_INPUT_TOKENS * PROMPT_SHARE))
  return {
    usable_input_tokens: DEFAULT_USABLE_INPUT_TOKENS,
    prompt_token_cap,
    evidence_token_cap: Math.floor(prompt_token_cap * EVIDENCE_SHARE),
    source: "fallback",
  }
}

export function taskContextBudget(input: { cfg: Config.Info; model: Provider.Model }): TaskContextBudget {
  const modelUsable = usable(input)
  if (!modelUsable) return defaultTaskContextBudget()
  const prompt_token_cap = Math.min(MAX_PROMPT_TOKENS, Math.floor(modelUsable * PROMPT_SHARE))
  return {
    usable_input_tokens: modelUsable,
    prompt_token_cap,
    evidence_token_cap: Math.floor(prompt_token_cap * EVIDENCE_SHARE),
    source: "model",
  }
}

export function assertTaskPromptBudget(input: { prompt: string; budget: TaskContextBudget }) {
  const tokens = conservativeEstimate(input.prompt)
  if (tokens > input.budget.prompt_token_cap) throw new TaskPromptBudgetExceeded(tokens, input.budget.prompt_token_cap)
  return tokens
}

function latestReceipt(item: WorkItem, receipts: readonly WorkReceipt[]) {
  return receipts
    .filter(
      (candidate) =>
        candidate.work_item_id === item.id &&
        candidate.outcome === "completed" &&
        candidate.processing_status === "processed",
    )
    .sort(
      (left, right) =>
        (right.processed_at ?? right.created_at) - (left.processed_at ?? left.created_at) ||
        right.id.localeCompare(left.id),
    )[0]
}

function currentAcceptanceFacts(
  item: WorkItem,
  receipt: WorkReceipt | undefined,
  facts: readonly AcceptanceFact[],
) {
  const superseded = new Set(facts.flatMap((fact) => (fact.supersedes_fact_id ? [fact.supersedes_fact_id] : [])))
  const active = facts
    .filter(
      (fact) =>
        fact.work_item_id === item.id &&
        fact.verdict === "passed" &&
        !superseded.has(fact.id) &&
        (!receipt || (fact.attempt_id === receipt.attempt_id && receipt.artifact_ids.includes(fact.artifact_id))),
    )
    .sort((left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id))
  if (receipt || !active.length) return active
  return active.filter(
    (fact) => fact.attempt_id === active[0]!.attempt_id && fact.artifact_id === active[0]!.artifact_id,
  )
}

export function taskEvidenceSnapshot(input: TaskEvidenceSnapshotInput) {
  const dependencies = dependencyClosure(input.item, input.work_items)
  const dependencyEvidence = dependencies.map((dependency) => {
    const receipt = latestReceipt(dependency, input.receipts)
    return {
      dependency,
      receipt,
      facts: currentAcceptanceFacts(dependency, receipt, input.acceptance_facts),
    }
  })
  const dependencyIDs = new Set(dependencies.map((dependency) => dependency.id))
  const currentGates = input.gates
    .filter(
      (gate) =>
        gate.status === "pending" &&
        (!gate.work_item_id || gate.work_item_id === input.item.id || dependencyIDs.has(gate.work_item_id)),
    )
    .sort((left, right) => left.requested_at - right.requested_at || left.id.localeCompare(right.id))
  const recentFailure = input.attempts
    .filter((attempt) => attempt.work_item_id === input.item.id && ["failed", "stopped"].includes(attempt.status))
    .sort(
      (left, right) =>
        (right.finished_at ?? right.started_at) - (left.finished_at ?? left.started_at) || right.id.localeCompare(left.id),
    )[0]
  const allReferences = references(input)
  const assignmentContext =
    input.assignment_context === undefined ? undefined : boundedValue(input.assignment_context, 12_000)
  const evidence: TaskEvidence = {
    schema_version: 1,
    project: {
      id: input.project.id,
      status: input.project.status,
      active_plan_version: input.project.active_plan_version,
      graph_revision: input.project.graph_revision,
      goal_digest: digest(input.project.goal),
    },
    task: taskValue(input.item),
    ...(assignmentContext ? { assignment_context: assignmentContext.value } : {}),
    dependencies: [],
    current_gates: [],
    references: { inventory: inventory(allReferences), samples: [] },
  }
  const totals = {
    dependencies: dependencies.length,
    acceptance_facts: dependencyEvidence.reduce((count, dependency) => count + dependency.facts.length, 0),
    gates: currentGates.length,
    recent_failure: recentFailure ? 1 : 0,
    reference_samples: allReferences.length,
  }
  const required = diagnostics(evidence, input.budget, totals, false)
  if (required.estimated_tokens > input.budget.evidence_token_cap)
    throw new TaskEvidenceBudgetExceeded({ ...required, code: "context_budget_exceeded", truncated: true })

  const includedReferences = new Set<string>()
  const truncations: boolean[] = [Boolean(assignmentContext?.truncated)]
  dependencyEvidence.forEach(({ dependency, receipt, facts: acceptanceFacts }) => {
    const summary = receipt ? boundedText(receipt.summary, 4_000) : undefined
    const artifactRefs = receipt
      ? receipt.artifact_ids.slice(0, 32).flatMap((id) => {
          const artifact = input.artifacts.find((candidate) => candidate.id === id)
          return artifact
            ? [
                {
                  id: artifact.id,
                  kind: artifact.kind,
                  title: boundedText(artifact.title, 500).value,
                  path: artifact.path,
                  digest: digest(artifact),
                },
              ]
            : [{ id, kind: "unknown", title: "Referenced artifact", digest: digest(id) }]
        })
      : []
    const candidate: TaskEvidence["dependencies"][number] = {
      work_item: {
        id: dependency.id,
        title: boundedText(dependency.title, 500).value,
        status: dependency.status,
        review_status: dependency.review_status,
        digest: digest(dependency),
      },
      current_acceptance_facts: [],
      ...(receipt
        ? {
            latest_receipt: {
              id: receipt.id,
              attempt_id: receipt.attempt_id,
              summary: summary!.value,
              evidence_refs: receipt.evidence_refs.slice(0, 32),
              artifact_refs: artifactRefs,
              created_at: receipt.processed_at ?? receipt.created_at,
              digest: digest(receipt),
            },
          }
        : {}),
    }
    evidence.dependencies.push(candidate)
    if (size(evidence).tokens > input.budget.evidence_token_cap) {
      delete candidate.latest_receipt
      if (size(evidence).tokens > input.budget.evidence_token_cap) {
        evidence.dependencies.pop()
        return
      }
    }
    includedReferences.add(`work_item:${dependency.id}`)
    if (candidate.latest_receipt) {
      includedReferences.add(`work_receipt:${candidate.latest_receipt.id}`)
      artifactRefs.forEach((artifact) => includedReferences.add(`artifact:${artifact.id}`))
    }
    acceptanceFacts.slice(0, 24).some((fact) => {
      const observation = boundedValue(fact.observation, 4_000)
      candidate.current_acceptance_facts.push({
        id: fact.id,
        attempt_id: fact.attempt_id,
        artifact_id: fact.artifact_id,
        artifact_integrity_sha256: fact.artifact_integrity_sha256,
        criterion_id: fact.criterion_id,
        gate_id: fact.gate_id,
        verdict: "passed",
        authority: fact.authority,
        evaluator: fact.evaluator,
        observation: observation.value,
        evidence_refs: fact.evidence_refs.slice(0, 32),
        evidence_sha256: fact.evidence_sha256,
        created_at: fact.created_at,
        digest: digest(fact),
      })
      if (size(evidence).tokens > input.budget.evidence_token_cap) {
        candidate.current_acceptance_facts.pop()
        return true
      }
      includedReferences.add(`acceptance_fact:${fact.id}`)
      includedReferences.add(`artifact:${fact.artifact_id}`)
      truncations.push(observation.truncated || fact.evidence_refs.length > 32)
      return false
    })
    truncations.push(
      Boolean(
        summary?.truncated ||
          (receipt &&
            (receipt.evidence_refs.length > 32 || receipt.artifact_ids.length > artifactRefs.length)) ||
          acceptanceFacts.length > 24,
      ),
    )
  })

  currentGates.reverse().forEach((gate) => {
    const summary = boundedText(gate.summary, 2_000)
    evidence.current_gates.push({
      id: gate.id,
      kind: gate.kind,
      title: boundedText(gate.title, 500).value,
      summary: summary.value,
      work_item_id: gate.work_item_id,
      resource_scope: gate.resource_scope.slice(0, 32),
      requested_at: gate.requested_at,
      digest: digest(gate),
    })
    if (size(evidence).tokens > input.budget.evidence_token_cap) {
      evidence.current_gates.pop()
      return
    }
    includedReferences.add(`approval_gate:${gate.id}`)
    truncations.push(summary.truncated || gate.resource_scope.length > 32)
  })

  if (recentFailure) {
    const summary = recentFailure.safe_summary ? boundedText(recentFailure.safe_summary, 4_000) : undefined
    evidence.recent_failure = {
      attempt_id: recentFailure.id,
      ordinal: recentFailure.ordinal,
      failure_kind: recentFailure.failure_kind,
      summary: summary?.value,
      finished_at: recentFailure.finished_at,
      digest: digest(recentFailure),
    }
    if (size(evidence).tokens > input.budget.evidence_token_cap) delete evidence.recent_failure
    else {
      includedReferences.add(`work_attempt:${recentFailure.id}`)
      truncations.push(Boolean(summary?.truncated))
    }
  }

  const remainingReferences = allReferences.filter(
    (reference) => !includedReferences.has(`${reference.kind}:${reference.id}`),
  )
  remainingReferences
    .slice(0, MAX_REFERENCE_SAMPLES)
    .some((reference) => {
      evidence.references.samples.push(reference)
      if (size(evidence).tokens <= input.budget.evidence_token_cap) return false
      evidence.references.samples.pop()
      return true
    })

  const resultDiagnostics = diagnostics(
    evidence,
    input.budget,
    { ...totals, reference_samples: remainingReferences.length },
    truncations.some(Boolean) ||
      evidence.dependencies.length < totals.dependencies ||
      evidence.dependencies.reduce((count, dependency) => count + dependency.current_acceptance_facts.length, 0) <
        totals.acceptance_facts ||
      evidence.current_gates.length < totals.gates ||
      (evidence.recent_failure ? 1 : 0) < totals.recent_failure ||
      evidence.references.samples.length < remainingReferences.length,
  )
  return { evidence, diagnostics: resultDiagnostics }
}

export function contextOverflowDiagnostic(input: {
  error: unknown
  provider_id?: ProviderID
}): ContextOverflowDiagnostic | undefined {
  if (input.error instanceof TaskEvidenceBudgetExceeded)
    return { code: "context_too_large", source: "preflight", message: input.error.message }
  if (input.error instanceof TaskPromptBudgetExceeded)
    return { code: "context_too_large", source: "preflight", message: input.error.message }
  if (MessageV2.ContextOverflowError.isInstance(input.error))
    return { code: "context_too_large", source: "session", message: input.error.data.message }
  if (input.provider_id && APICallError.isInstance(input.error)) {
    const parsed = ProviderError.parseAPICallError({ providerID: input.provider_id, error: input.error })
    if (parsed.type === "context_overflow")
      return { code: "context_too_large", source: "provider", message: parsed.message }
  }
  const parsed = ProviderError.parseStreamError(input.error)
  if (parsed?.type === "context_overflow")
    return { code: "context_too_large", source: "stream", message: parsed.message }
  return undefined
}
