import { Effect } from "effect"
import { eq, or } from "@/storage"
import * as Database from "@/storage/db"
import { ConversationRunTable } from "./conversation.sql"
import { ConversationRunID } from "./schema"

function normalize() {
  return Database.transaction(
    (db) => {
      const runs = db
        .select({ id: ConversationRunTable.id, state: ConversationRunTable.state })
        .from(ConversationRunTable)
        .where(
          or(
            eq(ConversationRunTable.state, "queued"),
            eq(ConversationRunTable.state, "running"),
            eq(ConversationRunTable.state, "projecting"),
          ),
        )
        .orderBy(ConversationRunTable.time_created, ConversationRunTable.id)
        .all()
      if (runs.length === 0) return []
      const now = Date.now()
      runs
        .filter((run) => run.state !== "queued")
        .map((run) =>
          db
            .update(ConversationRunTable)
            .set({
              state: "queued",
              retryable: false,
              time_finished: null,
              time_updated: now,
            })
            .where(eq(ConversationRunTable.id, run.id))
            .run(),
        )
      return runs.map((run) => run.id)
    },
    { behavior: "immediate" },
  )
}

export function recover(): Effect.Effect<ConversationRunID[]> {
  return Effect.sync(normalize)
}

export * as ConversationRecovery from "./recovery"
