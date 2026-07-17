import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AuditEvent } from "../../src/audit-event/audit-event"
import { Log } from "../../src/util"

void Log.init({ print: false })

describe("AuditEvent", () => {
  test("records events threaded by RootNeedID", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const audit = yield* AuditEvent.Service

        const event = yield* audit.record({
          rootNeedID: "need_audit_message",
          kind: "message",
          action: "request",
          actorAgentID: "dept-head",
          targetAgentID: "executor",
          subjectID: "msg-audit",
          subjectType: "agent_message",
          metadata: { depth: 2 },
        })
        const events = yield* audit.listByRootNeed("need_audit_message")

        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          rootNeedID: "need_audit_message",
          kind: "message",
          action: "request",
          actorAgentID: "dept-head",
          targetAgentID: "executor",
          subjectID: event.subjectID,
          subjectType: "agent_message",
        })
        expect(events[0].metadata).toMatchObject({ depth: 2 })
      }).pipe(Effect.provide(AuditEvent.defaultLayer)),
    )
  })
})
