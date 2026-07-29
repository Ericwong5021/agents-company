import { Context, Effect, Layer } from "effect"
import { CapabilityMaterializer, type MaterializationResult } from "./capability-materializer"
import { DispatchCoordinator, type DispatchResult } from "./dispatch"
import { GraphSupervisor, type ProcessResult } from "./graph-supervisor"

export type ReceiptProcessingResult = {
  processing: ProcessResult
  materialization?: MaterializationResult
  dispatch?: DispatchResult
}

export interface Interface {
  readonly processReceipt: (receipt_id: string) => Effect.Effect<ReceiptProcessingResult>
  readonly dispatchReady: (project_id: string) => Effect.Effect<DispatchResult>
  readonly pauseDispatch: (project_id: string, reason?: string) => Effect.Effect<DispatchResult>
  readonly resumeDispatch: (project_id: string, reason?: string) => Effect.Effect<DispatchResult>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/ProjectOrchestrator") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const supervisor = yield* GraphSupervisor.Service
    const materializer = yield* CapabilityMaterializer.Service
    const dispatch = yield* DispatchCoordinator.Service

    const processReceipt = Effect.fn("ProjectOrchestrator.processReceipt")(function* (receipt_id: string) {
      const processing = yield* supervisor.processReceipt(receipt_id)
      if (processing.status === "disabled") return { processing }
      const materialization = yield* materializer.materializeDecision(processing.decision)
      if (processing.mode === "shadow") return { processing, materialization }
      return {
        processing,
        materialization,
        dispatch: yield* dispatch.dispatchReady(processing.project_id),
      }
    })

    return Service.of({
      processReceipt,
      dispatchReady: dispatch.dispatchReady,
      pauseDispatch: dispatch.pauseDispatch,
      resumeDispatch: dispatch.resumeDispatch,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(GraphSupervisor.defaultLayer),
  Layer.provide(CapabilityMaterializer.defaultLayer),
  Layer.provide(DispatchCoordinator.defaultLayer),
)

export * as ProjectOrchestrator from "./project-orchestrator"
