import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { and, count, eq } from "drizzle-orm"
import { Effect } from "effect"
import { CompanyAttention } from "../../src/company-project"
import {
  CompanyAttentionTable,
  CompanyProjectActionTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
} from "../../src/company-project/company-project.sql"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"

function seedProject(id = "project-attention") {
  const now = Date.now()
  Database.use((db) =>
    db
      .insert(CompanyProjectTable)
      .values({
        id,
        goal: "Resolve material issues",
        title: "Attention project",
        status: "executing",
        output_dir: "/tmp/project-attention",
        graph_revision: 3,
        created_at: now,
        updated_at: now,
      })
      .run(),
  )
  return id
}

function use<T>(fn: (service: CompanyAttention.Interface) => Effect.Effect<T>) {
  return Effect.runPromise(
    CompanyAttention.Service.use(fn).pipe(Effect.provide(CompanyAttention.defaultLayer)),
  )
}

beforeEach(resetDatabase)
afterEach(resetDatabase)

describe.serial("CompanyAttention", () => {
  test.serial("opens only material user interruptions and closes them idempotently", async () => {
    const project_id = seedProject()
    const internal = await use((service) =>
      service.open({
        project_id,
        idempotency_key: "attention-internal",
        issue: {
          issue_kind: "runtime_transient",
          risk: "medium",
          materiality: "internal",
        },
        title: "Transient runtime error",
        summary: "Automatic recovery is allowed",
        source_refs: [{ kind: "project", id: project_id }],
      }),
    )
    expect(internal).toBeUndefined()
    expect(await use((service) => service.list({ project_id }))).toEqual([])

    const opened = await use((service) =>
      service.open({
        project_id,
        idempotency_key: "attention-permission",
        issue: {
          issue_kind: "permission_required",
          risk: "high",
          materiality: "permission",
        },
        title: "Permission required",
        summary: "A protected resource needs authorization",
        required_decision: "Approve or stop",
        source_refs: [
          { kind: "work_item", id: "work-2", version: 2 },
          { kind: "project", id: project_id },
          { kind: "project", id: project_id },
        ],
      }),
    )
    expect(opened?.replayed).toBe(false)
    expect(opened?.record).toMatchObject({
      route: "approval_gate",
      material: true,
      interrupts_user: true,
      allowed_actions: ["resolve_blocker", "stop_work"],
      status: "open",
      version: 1,
      source_refs: [
        { kind: "project", id: project_id },
        { kind: "work_item", id: "work-2", version: 2 },
      ],
    })

    const replayed = await use((service) =>
      service.open({
        project_id,
        idempotency_key: "attention-permission",
        issue: {
          issue_kind: "permission_required",
          risk: "high",
          materiality: "permission",
        },
        title: "Permission required",
        summary: "A protected resource needs authorization",
        required_decision: "Approve or stop",
        source_refs: [
          { kind: "project", id: project_id },
          { kind: "work_item", id: "work-2", version: 2 },
        ],
      }),
    )
    expect(replayed).toEqual({ record: opened!.record, replayed: true })
    await expect(
      use((service) =>
        service.open({
          project_id,
          idempotency_key: "attention-permission",
          issue: {
            issue_kind: "permission_required",
            risk: "high",
            materiality: "permission",
          },
          title: "Changed title",
          summary: "A protected resource needs authorization",
          required_decision: "Approve or stop",
          source_refs: [{ kind: "project", id: project_id }],
        }),
      ),
    ).rejects.toThrow("different facts")

    const closed = await use((service) =>
      service.close({
        id: opened!.record.id,
        expected_version: 1,
        resolution: "Permission granted",
      }),
    )
    expect(closed).toMatchObject({
      replayed: false,
      record: { status: "resolved", resolution: "Permission granted", version: 2 },
    })
    expect(
      await use((service) =>
        service.close({
          id: opened!.record.id,
          expected_version: 1,
          resolution: "Permission granted",
        }),
      ),
    ).toEqual({ record: closed.record, replayed: true })
    await expect(
      use((service) =>
        service.close({
          id: opened!.record.id,
          expected_version: 2,
          resolution: "Stopped instead",
        }),
      ),
    ).rejects.toThrow("different facts")

    expect(
      Database.use((db) =>
        db
          .select({ value: count() })
          .from(CompanyAttentionTable)
          .where(eq(CompanyAttentionTable.project_id, project_id))
          .get(),
      )?.value,
    ).toBe(1)
    expect(
      Database.use((db) =>
        db
          .select({ type: CompanyProjectEventTable.type, value: count() })
          .from(CompanyProjectEventTable)
          .where(eq(CompanyProjectEventTable.project_id, project_id))
          .groupBy(CompanyProjectEventTable.type)
          .all(),
      ),
    ).toEqual([
      { type: "attention.closed", value: 1 },
      { type: "attention.opened", value: 1 },
    ])
  })

  test.serial("requests, claims, applies, rejects, and replays actions without runtime effects", async () => {
    const project_id = seedProject()
    const requested = await use((service) =>
      service.requestAction({
        project_id,
        action: "resolve_blocker",
        idempotency_key: "action-resolve",
        payload: { answer: "approved", nested: { b: 2, a: 1 } },
        expected_revision: 3,
      }),
    )
    expect(requested).toMatchObject({ replayed: false, record: { status: "requested" } })
    expect(
      await use((service) =>
        service.requestAction({
          project_id,
          action: "resolve_blocker",
          idempotency_key: "action-resolve",
          payload: { nested: { a: 1, b: 2 }, answer: "approved" },
          expected_revision: 3,
        }),
      ),
    ).toEqual({ record: requested.record, replayed: true })
    await expect(
      use((service) =>
        service.requestAction({
          project_id,
          action: "resolve_blocker",
          idempotency_key: "action-resolve",
          payload: { answer: "rejected" },
          expected_revision: 3,
        }),
      ),
    ).rejects.toThrow("different facts")

    const claimed = await use((service) => service.claimAction(requested.record.id))
    expect(claimed).toMatchObject({ replayed: false, record: { status: "claimed" } })
    expect(await use((service) => service.claimAction(requested.record.id))).toEqual({
      record: claimed.record,
      replayed: true,
    })

    const applied = await use((service) =>
      service.applyAction({ id: requested.record.id, result: { version: 2, ok: true } }),
    )
    expect(applied).toMatchObject({ replayed: false, record: { status: "applied" } })
    expect(
      await use((service) =>
        service.applyAction({ id: requested.record.id, result: { ok: true, version: 2 } }),
      ),
    ).toEqual({ record: applied.record, replayed: true })
    await expect(
      use((service) =>
        service.applyAction({ id: requested.record.id, result: { ok: false, version: 2 } }),
      ),
    ).rejects.toThrow("different facts")
    expect(
      await use((service) =>
        service.replayAction({ project_id, idempotency_key: "action-resolve" }),
      ),
    ).toEqual(applied.record)

    const rejectedRequest = await use((service) =>
      service.requestAction({
        project_id,
        action: "stop_work",
        idempotency_key: "action-stop",
        payload: { reason: "unsafe" },
      }),
    )
    const rejected = await use((service) =>
      service.rejectAction({ id: rejectedRequest.record.id, error: "policy_rejected" }),
    )
    expect(rejected).toMatchObject({ replayed: false, record: { status: "rejected" } })
    expect(
      await use((service) =>
        service.rejectAction({ id: rejectedRequest.record.id, error: "policy_rejected" }),
      ),
    ).toEqual({ record: rejected.record, replayed: true })
    await expect(
      use((service) =>
        service.rejectAction({ id: rejectedRequest.record.id, error: "different_error" }),
      ),
    ).rejects.toThrow("different facts")

    const staleRequest = await use((service) =>
      service.requestAction({
        project_id,
        action: "retry",
        idempotency_key: "action-stale",
        payload: { work_item_id: "work-stale" },
        expected_revision: 2,
      }),
    )
    expect(await use((service) => service.claimAction(staleRequest.record.id))).toMatchObject({
      replayed: false,
      record: { status: "rejected", error: "project_revision_conflict" },
    })
    expect(
      Database.use((db) =>
        db
          .select({ value: count() })
          .from(CompanyProjectActionTable)
          .where(eq(CompanyProjectActionTable.project_id, project_id))
          .get(),
      )?.value,
    ).toBe(3)
    expect(
      Database.use((db) =>
        db
          .select({ value: count() })
          .from(CompanyProjectEventTable)
          .where(
            and(
              eq(CompanyProjectEventTable.project_id, project_id),
              eq(CompanyProjectEventTable.type, "project_action.applied"),
            ),
          )
          .get(),
      )?.value,
    ).toBe(1)
  })
})
