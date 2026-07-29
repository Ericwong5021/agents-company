import { and, asc, desc, eq } from "drizzle-orm"
import z from "zod"
import { FounderYellowRollbackRecord, FounderYellowSummary } from "@agents-company/shared/founder-os"
import type { TxOrDb } from "@/storage/db"
import { FounderYellowEventTable, FounderYellowRunTable } from "./yellow.sql"
import { FounderCorrectionTable } from "./decision-ledger.sql"

const RollbackEventData = z
  .object({
    rollbackId: z.string().trim().min(1),
    trigger: z.enum(["failure_condition", "human_decision"]),
    handlerId: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    result: z.string().nullable().optional(),
  })
  .catchall(z.unknown())

function rollbackRecords(db: TxOrDb, runId: string) {
  const events = db
    .select()
    .from(FounderYellowEventTable)
    .where(and(
      eq(FounderYellowEventTable.run_id, runId),
      eq(FounderYellowEventTable.type, "rollback_requested"),
    ))
    .orderBy(asc(FounderYellowEventTable.created_at), asc(FounderYellowEventTable.id))
    .all()
  return events.map((event) => {
    const data = RollbackEventData.parse(JSON.parse(event.data_json))
    const result = db
      .select()
      .from(FounderYellowEventTable)
      .where(eq(FounderYellowEventTable.run_id, runId))
      .orderBy(desc(FounderYellowEventTable.created_at), desc(FounderYellowEventTable.id))
      .all()
      .find((candidate) => {
        if (!["rollback_completed", "rollback_failed"].includes(candidate.type)) return false
        return RollbackEventData.parse(JSON.parse(candidate.data_json)).rollbackId === data.rollbackId
      })
    const resultData = result ? RollbackEventData.parse(JSON.parse(result.data_json)) : undefined
    return FounderYellowRollbackRecord.parse({
      id: data.rollbackId,
      trigger: data.trigger,
      handlerId: data.handlerId,
      status: result?.type === "rollback_completed"
        ? "completed"
        : result?.type === "rollback_failed"
          ? "failed"
          : "requested",
      reason: data.reason,
      result: resultData?.result ?? null,
      actorKind: event.actor_kind,
      actorId: event.actor_id,
      createdAt: event.created_at,
    })
  })
}

export function yellowSummaryFromRow(db: TxOrDb, row: typeof FounderYellowRunTable.$inferSelect) {
  return FounderYellowSummary.parse({
    schemaVersion: 1,
    runId: row.id,
    status: row.status,
    actionType: row.action_type,
    decisionId: row.decision_id,
    governanceRef: row.governance_ref,
    mutationId: row.mutation_id,
    workItemIds: JSON.parse(row.work_item_ids_json),
    receiptIds: JSON.parse(row.receipt_ids_json),
    outcomeIds: JSON.parse(row.outcome_ids_json),
    cost: {
      unit: row.cost_unit,
      limit: row.cost_limit,
      actual: row.actual_cost,
    },
    checkpointId: row.checkpoint_id,
    rollbackHandlerId: row.rollback_handler_id,
    rollbacks: rollbackRecords(db, row.id),
    overrideIds: db
      .select({ id: FounderCorrectionTable.id })
      .from(FounderCorrectionTable)
      .where(and(
        eq(FounderCorrectionTable.decision_id, row.decision_id),
        eq(FounderCorrectionTable.kind, "override"),
      ))
      .orderBy(asc(FounderCorrectionTable.created_at), asc(FounderCorrectionTable.id))
      .all()
      .map((override) => override.id),
    circuitBreakerOpen: Boolean(
      db
        .select({ id: FounderYellowEventTable.id })
        .from(FounderYellowEventTable)
        .where(and(
          eq(FounderYellowEventTable.company_id, row.company_id),
          eq(FounderYellowEventTable.type, "circuit_opened"),
        ))
        .get(),
    ),
    failClosedReasons: JSON.parse(row.fail_closed_reasons_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export function yellowSummaryForDecision(db: TxOrDb, decisionId: string) {
  const row = db
    .select()
    .from(FounderYellowRunTable)
    .where(eq(FounderYellowRunTable.decision_id, decisionId))
    .orderBy(desc(FounderYellowRunTable.created_at), desc(FounderYellowRunTable.id))
    .get()
  return row ? yellowSummaryFromRow(db, row) : null
}
