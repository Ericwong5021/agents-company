import { Context, Effect, Layer } from "effect"
import type { RolloutShadowEvaluation } from "@agents-company/shared/rollout"
import { CompanyValidationGate } from "@/company-project/validation-gate"
import { CapabilityMaterializer, type MaterializationResult } from "./capability-materializer"
import { GraphSupervisor, type ProcessResult } from "./graph-supervisor"
import { QuiescenceService, type QuiescenceResult } from "./quiescence"

export type ReceiptProcessingResult = {
  processing: ProcessResult
  materialization?: MaterializationResult
  quiescence?: QuiescenceResult
}

export interface Interface {
  readonly processReceipt: (receipt_id: string) => Effect.Effect<ReceiptProcessingResult>
  readonly shadowLegacy: (project_id: string) => Effect.Effect<RolloutShadowEvaluation[]>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/ReceiptProcessor") {}

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const supervisor = yield* GraphSupervisor.Service
    const materializer = yield* CapabilityMaterializer.Service
    const quiescence = yield* QuiescenceService.Service
    const validation = yield* CompanyValidationGate.Service
    const processReceipt = Effect.fn("ReceiptProcessor.processReceipt")(function* (receipt_id: string) {
      const processing = yield* supervisor.processReceipt(receipt_id)
      if (processing.status === "disabled") return { processing }
      if (processing.mode === "active") yield* validation.evaluateProjectPending(processing.project_id)
      return {
        processing,
        materialization: yield* materializer.materializeDecision(processing.decision),
        quiescence: yield* quiescence.check(processing.project_id),
      }
    })
    return Service.of({ processReceipt, shadowLegacy: supervisor.shadowLegacy })
  }),
)

export const layer = serviceLayer.pipe(Layer.provide(CompanyValidationGate.defaultLayer))

export const defaultLayer = layer.pipe(
  Layer.provide(GraphSupervisor.defaultLayer),
  Layer.provide(CapabilityMaterializer.defaultLayer),
  Layer.provide(QuiescenceService.defaultLayer),
)

export * as ReceiptProcessor from "./receipt-processor"
