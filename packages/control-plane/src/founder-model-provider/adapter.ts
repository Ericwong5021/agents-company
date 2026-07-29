import { generateObject, NoObjectGeneratedError } from "ai"
import { Effect, Layer } from "effect"
import {
  FounderBenchmarkPrediction,
  FounderShadowModelOutput,
} from "@agents-company/shared/founder-os"
import { EffectBridge } from "@/effect"
import {
  FounderModelProvider,
  FounderModelProviderError,
  type FounderBenchmarkGenerationRequest,
  type FounderShadowGenerationRequest,
} from "@/founder-os/model-provider"
import { Provider } from "@/provider"

function failure(error: unknown) {
  if (NoObjectGeneratedError.isInstance(error))
    return new FounderModelProviderError("invalid_output", error.message)
  const name = error instanceof Error ? error.name : ""
  return new FounderModelProviderError(
    name === "TimeoutError" || name === "AbortError" ? "timeout" : "unavailable",
    error instanceof Error ? error.message : "Founder model provider is unavailable",
  )
}

export const layer = Layer.effect(
  FounderModelProvider,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const bridge = yield* EffectBridge.make()
    const model = async (modelConfigRef: string) => {
      if (modelConfigRef !== "company-default-model")
        return bridge.promise(provider.resolveModelRef(modelConfigRef).pipe(
          Effect.flatMap((reference) => provider.getLanguage(reference)),
        ))
      const reference = await bridge.promise(provider.defaultModel())
      return bridge.promise(
        provider.getModel(reference.providerID, reference.modelID).pipe(
          Effect.flatMap((resolved) => provider.getLanguage(resolved)),
        ),
      )
    }
    const generateShadow = (input: FounderShadowGenerationRequest) =>
      Effect.tryPromise({
        try: async () => (
          await generateObject({
            model: await model(input.modelConfigRef),
            schema: FounderShadowModelOutput,
            temperature: 0,
            abortSignal: AbortSignal.timeout(input.timeoutMs),
            system:
              "Return one strict Founder Shadow recommendation. Use only supplied persisted context. Every principle, decision-case, and evidence reference must be copied exactly from that context. Do not speak, execute, create a gate, or claim missing facts.",
            prompt: JSON.stringify({
              snapshot: input.snapshot,
              goal: input.context.currentGoal,
              discussion: input.context.discussion,
              authorizationBoundary: input.context.authorizationBoundary,
              currentFacts: input.context.currentFacts,
              principles: input.context.principles,
              decisionCases: input.context.decisionCases,
              tasteExamples: input.context.tasteExamples,
              rubrics: input.context.rubrics,
              evidenceRefs: input.context.evidenceRefs,
              missingInformation: input.context.missingInformation,
            }),
          })
        ).object,
        catch: failure,
      })
    const generateBenchmark = (input: FounderBenchmarkGenerationRequest) =>
      Effect.tryPromise({
        try: async () => (
          await generateObject({
            model: await model(input.modelConfigRef),
            schema: FounderBenchmarkPrediction.array(),
            temperature: 0,
            abortSignal: AbortSignal.timeout(input.timeoutMs),
            system:
              "Evaluate every supplied frozen holdout case independently. Return exactly one prediction per case ID. Never invent a reference, and never infer or reproduce hidden expected labels.",
            prompt: JSON.stringify({
              snapshot: input.snapshot,
              benchmarkType: input.benchmarkType,
              cases: input.cases,
            }),
          })
        ).object,
        catch: failure,
      })
    return FounderModelProvider.of({ generateShadow, generateBenchmark })
  }),
)
