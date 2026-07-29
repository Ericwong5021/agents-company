import { Context, Effect, Layer, Option } from "effect"
import { and, asc, eq } from "drizzle-orm"
import { CompanyProjectAssignmentTable } from "@/company-recruitment/company-recruitment.sql"
import { CompanyProjectTable } from "@/company-project/company-project.sql"
import { Database } from "@/storage"
import { CapabilityMaterializer } from "./capability-materializer"
import { DispatchCoordinator, type DispatchBarrierResult, type DispatchResult } from "./dispatch"
import { GraphSupervisor } from "./graph-supervisor"
import { QuiescenceService, type QuiescenceResult } from "./quiescence"
import { ReceiptProcessor, type ReceiptProcessingResult as ProcessorResult } from "./receipt-processor"
import * as ProjectActionExecutor from "./project-action-executor"

export type ReceiptProcessingResult = ProcessorResult & { dispatch?: DispatchResult }

export type RecoveryResult = {
  idempotency_key: string
  project_ids: string[]
  receipt_ids: string[]
  disabled_receipt_ids: string[]
  decision_ids: string[]
  capability_need_ids: string[]
  assignment_ids: string[]
  dispatches: DispatchResult[]
  quiescence: QuiescenceResult[]
  actions: ProjectActionExecutor.RecoveryReport
  replayed: boolean
}

export interface Interface {
  readonly processReceipt: (receipt_id: string) => Effect.Effect<ReceiptProcessingResult>
  readonly dispatchReady: (project_id: string) => Effect.Effect<DispatchResult>
  readonly checkQuiescence: (project_id: string) => Effect.Effect<QuiescenceResult>
  readonly pauseDispatch: (project_id: string, reason?: string) => Effect.Effect<DispatchBarrierResult>
  readonly resumeDispatch: (project_id: string, reason?: string) => Effect.Effect<DispatchBarrierResult>
  readonly recover: (input?: { project_id?: string }) => Effect.Effect<RecoveryResult>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/ProjectOrchestrator") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const supervisor = yield* GraphSupervisor.Service
    const materializer = yield* CapabilityMaterializer.Service
    const dispatch = yield* DispatchCoordinator.Service
    const quiescence = yield* QuiescenceService.Service
    const processor = yield* ReceiptProcessor.Service
    const actionExecutor = Option.getOrUndefined(yield* Effect.serviceOption(ProjectActionExecutor.Service))

    const processReceipt = Effect.fn("ProjectOrchestrator.processReceipt")(function* (receipt_id: string) {
      const result = yield* processor.processReceipt(receipt_id)
      if (result.processing.status === "disabled" || result.processing.mode === "shadow") return result
      return {
        ...result,
        dispatch:
          result.quiescence?.status === "completed"
            ? undefined
            : yield* dispatch.dispatchReady(result.processing.project_id),
      }
    })

    const recover = Effect.fn("ProjectOrchestrator.recover")(function* (
      input: { project_id?: string } = {},
    ) {
      const actions = actionExecutor
        ? yield* actionExecutor.recover()
        : {
            idempotency_key: "project-action-recover:v1",
            project_ids: [],
            assignment_ids: [],
            attention_ids: [],
            action_ids: [],
            applied_action_ids: [],
            rejected_action_ids: [],
            replayed: true,
          }
      const receipts = yield* supervisor.recover(input)
      const project_ids = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({ id: CompanyProjectTable.id })
            .from(CompanyProjectTable)
            .where(
              and(
                eq(CompanyProjectTable.execution_strategy, "seed_and_grow"),
                input.project_id
                  ? eq(CompanyProjectTable.id, input.project_id)
                  : undefined,
              ),
            )
            .orderBy(asc(CompanyProjectTable.created_at), asc(CompanyProjectTable.id))
            .all()
            .map((project) => project.id),
        ),
      )
      const decisions = (yield* Effect.forEach(project_ids, supervisor.listDecisions, { concurrency: 1 }))
        .flat()
        .filter((decision) => decision.status === "applied")
      const assignmentIDsBefore = new Set(
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select({ id: CompanyProjectAssignmentTable.id })
              .from(CompanyProjectAssignmentTable)
              .all()
              .map((assignment) => assignment.id),
          ),
        ),
      )
      const materializations = yield* Effect.forEach(decisions, materializer.materializeDecision, { concurrency: 1 })
      const dispatches = yield* Effect.forEach(project_ids, dispatch.dispatchReady, {
        concurrency: 1,
      })
      const quiescenceResults = yield* Effect.forEach(project_ids, quiescence.check, {
        concurrency: 1,
      })
      return {
        idempotency_key: "project-orchestrator-recover:v1",
        project_ids,
        receipt_ids: receipts.processed_receipt_ids,
        disabled_receipt_ids: receipts.disabled_receipt_ids,
        decision_ids: decisions.map((decision) => decision.id),
        capability_need_ids: [...new Set(materializations.flatMap((result) => result.capability_need_ids))].sort(),
        assignment_ids: [...new Set(materializations.flatMap((result) => result.assignment_ids))].sort(),
        dispatches,
        quiescence: quiescenceResults,
        actions,
        replayed:
          actions.replayed &&
          !receipts.processed_receipt_ids.length &&
          materializations.flatMap((result) => result.assignment_ids).every((id) => assignmentIDsBefore.has(id)) &&
          dispatches.every((result) => !result.dispatched_work_item_ids.length) &&
          quiescenceResults.every((result) => result.status !== "completed" || result.replayed),
      }
    })

    return Service.of({
      processReceipt,
      dispatchReady: dispatch.dispatchReady,
      checkQuiescence: quiescence.check,
      pauseDispatch: dispatch.pauseDispatch,
      resumeDispatch: dispatch.resumeDispatch,
      recover,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(GraphSupervisor.defaultLayer),
  Layer.provide(CapabilityMaterializer.defaultLayer),
  Layer.provide(DispatchCoordinator.defaultLayer),
  Layer.provide(QuiescenceService.defaultLayer),
  Layer.provide(ReceiptProcessor.defaultLayer),
  Layer.provide(ProjectActionExecutor.defaultLayer),
)

export * as ProjectOrchestrator from "./project-orchestrator"
