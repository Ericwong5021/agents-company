import { Context, Effect, Layer } from "effect"
import { Database } from "../storage"
import { ReputationTable, ReputationHistoryTable } from "./reputation.sql"
import { ReputationInfo, ReputationHistoryInfo, UpdateInput } from "./schema"
import { eq } from "drizzle-orm"
import { Identifier } from "../id/id"

const DEFAULT_SCORE = 0

export interface Interface {
  readonly get: (agentID: string) => Effect.Effect<ReputationInfo>
  readonly update: (input: UpdateInput) => Effect.Effect<ReputationInfo>
  readonly getHistory: (agentID: string) => Effect.Effect<ReputationHistoryInfo[]>
  readonly updateFromAdmission: (
    agentID: string,
    passed: boolean,
    findings: { severity: "blocker" | "warning" | "info" }[],
    taskRating: "company" | "project" | "individual",
  ) => Effect.Effect<ReputationInfo>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/Reputation") {}

const fromRow = (row: typeof ReputationTable.$inferSelect): ReputationInfo => ({
  id: row.id,
  agentID: row.agentID,
  score: row.score,
  time: {
    created: row.time_created,
    updated: row.time_updated,
  },
})

const historyFromRow = (row: typeof ReputationHistoryTable.$inferSelect): ReputationHistoryInfo => ({
  id: row.id,
  reputationID: row.reputationID,
  scoreChange: row.scoreChange,
  reason: row.reason,
  taskID: row.taskID ?? undefined,
  metadata: row.metadata ?? undefined,
  time: {
    created: row.time_created,
    updated: row.time_updated,
  },
})

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const get = Effect.fn("Reputation.get")(function* (agentID: string) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(ReputationTable)
            .where(eq(ReputationTable.agentID, agentID))
            .get(),
        ),
      )
      if (row) return fromRow(row)

      const now = Date.now()
      const id = Identifier.ascending("reputation")
      yield* Effect.sync(() =>
        Database.use((db) =>
          db.insert(ReputationTable).values({
            id,
            agentID,
            score: DEFAULT_SCORE,
            time_created: now,
            time_updated: now,
          }),
        ),
      )
      return {
        id,
        agentID,
        score: DEFAULT_SCORE,
        time: { created: now, updated: now },
      }
    })

    const update = Effect.fn("Reputation.update")(function* (input: UpdateInput) {
      const info = yield* get(input.agentID)
      const now = Date.now()
      const historyID = Identifier.ascending("reputation")

      yield* Effect.sync(() =>
        Database.use((db) =>
          db.insert(ReputationHistoryTable).values({
            id: historyID,
            reputationID: info.id,
            scoreChange: input.scoreChange,
            reason: input.reason,
            taskID: input.taskID ?? null,
            metadata: input.metadata ?? null,
            time_created: now,
            time_updated: now,
          }),
        ),
      )

      const newScore = info.score + input.scoreChange
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(ReputationTable)
            .set({ score: newScore, time_updated: now })
            .where(eq(ReputationTable.id, info.id)),
        ),
      )

      return { ...info, score: newScore, time: { ...info.time, updated: now } }
    })

    const getHistory = Effect.fn("Reputation.getHistory")(function* (agentID: string) {
      const info = yield* get(agentID)
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(ReputationHistoryTable)
            .where(eq(ReputationHistoryTable.reputationID, info.id))
            .orderBy(ReputationHistoryTable.time_created)
            .all(),
        ),
      )
      return rows.map(historyFromRow)
    })

    const updateFromAdmission = Effect.fn("Reputation.updateFromAdmission")(
      function* (
        agentID: string,
        passed: boolean,
        findings: { severity: "blocker" | "warning" | "info" }[],
        taskRating: "company" | "project" | "individual",
      ) {
        // Scoring rules based on design doc:
        // - Pass: +10 base, multiplied by task rating weight
        // - Fail: -5 base, multiplied by task rating weight
        // - Blocker findings: -5 each
        // - Warning findings: -2 each
        // - Info findings: 0
        const ratingWeight = taskRating === "company" ? 2 : taskRating === "project" ? 1.5 : 1
        let scoreChange = 0

        if (passed) {
          scoreChange += 10 * ratingWeight
        } else {
          scoreChange -= 5 * ratingWeight
        }

        for (const f of findings) {
          if (f.severity === "blocker") scoreChange -= 5
          else if (f.severity === "warning") scoreChange -= 2
        }

        const reason = passed ? "admission_pass" : "admission_fail"

        return yield* update({ agentID, scoreChange, reason })
      },
    )

    return { get, update, getHistory, updateFromAdmission }
  }),
)

export const defaultLayer = layer
