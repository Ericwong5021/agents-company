import { Context, Effect } from "effect"
import type {
  FounderBenchmarkCase,
  FounderContextProjection,
  FounderShadowEvidenceRef,
  GovernanceAssetScope,
} from "@agents-company/shared/founder-os"

export class FounderModelProviderError extends Error {
  constructor(
    readonly reason: "unavailable" | "timeout" | "invalid_output",
    message: string,
  ) {
    super(message)
    this.name = "FounderModelProviderError"
  }
}

export type FounderShadowGenerationRequest = {
  companyId: string
  modelConfigRef: string
  snapshot: { id: string; checksum: string }
  context: FounderContextProjection
  timeoutMs: number
}

export type FounderBenchmarkGenerationRequest = {
  companyId: string
  modelConfigRef: string
  snapshot: { id: string; checksum: string }
  benchmarkType: "founder_decision" | "taste"
  cases: Array<{
    id: string
    sourceAsset: FounderBenchmarkCase["sourceAsset"]
    scope: GovernanceAssetScope
    content: string
    tags: string[]
    evidenceRefs: FounderShadowEvidenceRef[]
  }>
  timeoutMs: number
}

export interface FounderModelProviderShape {
  readonly generateShadow: (
    input: FounderShadowGenerationRequest,
  ) => Effect.Effect<unknown, FounderModelProviderError>
  readonly generateBenchmark: (
    input: FounderBenchmarkGenerationRequest,
  ) => Effect.Effect<unknown, FounderModelProviderError>
}

export class FounderModelProvider extends Context.Service<
  FounderModelProvider,
  FounderModelProviderShape
>()("@control-plane/FounderModelProvider") {}
