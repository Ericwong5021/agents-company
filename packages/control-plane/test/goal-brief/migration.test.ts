import { describe, expect, test } from "bun:test"
import { Database as SqliteDatabase } from "bun:sqlite"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

async function fixture(withCharter: boolean) {
  const directory = await fs.mkdtemp(path.join(process.env.TEMP ?? "/tmp", "agentcompany-experience-migration-"))
  const database = new SqliteDatabase(path.join(directory, "experience.db"))
  database.exec(
    [
      "PRAGMA foreign_keys = ON;",
      "CREATE TABLE company_project (id text PRIMARY KEY NOT NULL);",
      "CREATE TABLE thread (id text PRIMARY KEY NOT NULL, agent_id text NOT NULL, kind text NOT NULL, status text NOT NULL, session_id text, description text, budget_tokens integer, spent_tokens integer DEFAULT 0, time_started integer, time_completed integer, time_created integer NOT NULL, time_updated integer NOT NULL);",
      withCharter
        ? "CREATE TABLE company_project_charter (project_id text PRIMARY KEY NOT NULL, title text NOT NULL, FOREIGN KEY (project_id) REFERENCES company_project(id) ON DELETE CASCADE);"
        : "",
      "INSERT INTO company_project (id) VALUES ('project-existing');",
      "INSERT INTO thread (id, agent_id, kind, status, session_id, description, budget_tokens, spent_tokens, time_started, time_created, time_updated) VALUES ('thread-life-ambient', 'agent-existing', 'ambient', 'paused', 'session-existing', 'Historical Life reflection context', 4096, 1024, 80, 80, 100);",
      withCharter
        ? "INSERT INTO company_project_charter (project_id, title) VALUES ('project-existing', 'Existing Charter');"
        : "",
    ].join("\n"),
  )
  return {
    database,
    [Symbol.asyncDispose]: async () => {
      database.close()
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

async function migration() {
  return Bun.file(
    path.resolve(import.meta.dir, "../../migration/20260725000000_experience_projection/migration.sql"),
  ).text()
}

async function idempotencyMigration() {
  return Bun.file(
    path.resolve(import.meta.dir, "../../migration/20260725010000_goal_brief_idempotency/migration.sql"),
  ).text()
}

async function generationVersionMigration() {
  return Bun.file(
    path.resolve(import.meta.dir, "../../migration/20260725020000_goal_brief_generation_version/migration.sql"),
  ).text()
}

function rowsHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

describe("Experience projection migration", () => {
  test("persists one request binding and cascades it with the generated Brief", async () => {
    await using database = await fixture(false)
    database.database.exec(await migration())
    database.database.exec(await idempotencyMigration())
    database.database.exec(await generationVersionMigration())
    expect(
      (
        database.database.query("PRAGMA table_info('goal_brief_generation_request')").all() as {
          name: string
          notnull: number
          pk: number
        }[]
      ).map((column) => ({
        name: column.name,
        notnull: column.notnull,
        pk: column.pk,
      })),
    ).toEqual([
      { name: "request_id", notnull: 1, pk: 1 },
      { name: "payload_hash", notnull: 1, pk: 0 },
      { name: "owner_token", notnull: 1, pk: 0 },
      { name: "lease_expires_at", notnull: 1, pk: 0 },
      { name: "brief_id", notnull: 0, pk: 0 },
      { name: "created_at", notnull: 1, pk: 0 },
      { name: "updated_at", notnull: 1, pk: 0 },
      { name: "brief_version", notnull: 0, pk: 0 },
    ])
    database.database.exec(
      [
        "INSERT INTO goal_brief (id, project_id, created_at, updated_at) VALUES ('brief-idempotent', 'project-existing', 100, 100);",
        "INSERT INTO goal_brief_version (brief_id, version, goal, deliverables_json, acceptance_criteria_json, constraints_json, non_goals_json, assumptions_json, open_questions_json, risk_level, recommended_plan_json, approval_mode, source, source_refs_json, created_at) VALUES ('brief-idempotent', 1, 'Goal', '[]', '[]', '[]', '[]', '[]', '[]', 'low', '{}', 'balanced', 'system_suggestion', '[]', 100);",
        "INSERT INTO goal_brief_generation_request (request_id, payload_hash, owner_token, lease_expires_at, brief_id, brief_version, created_at, updated_at) VALUES ('request-idempotent', 'hash-one', 'owner-one', 130, 'brief-idempotent', 1, 100, 100);",
        "INSERT INTO goal_brief_generation_request (request_id, payload_hash, owner_token, lease_expires_at, brief_id, created_at, updated_at) VALUES ('request-lease', 'hash-lease', 'owner-leader', 110, NULL, 100, 100);",
      ].join("\n"),
    )

    expect(() =>
      database.database.exec(
        "INSERT INTO goal_brief_generation_request (request_id, payload_hash, owner_token, lease_expires_at, created_at, updated_at) VALUES ('request-idempotent', 'hash-two', 'owner-two', 230, 200, 200);",
      ),
    ).toThrow()
    expect(
      database.database
        .query(
          "SELECT request_id, payload_hash, owner_token, lease_expires_at, brief_id, brief_version FROM goal_brief_generation_request WHERE request_id = 'request-idempotent'",
        )
        .all(),
    ).toEqual([
      {
        request_id: "request-idempotent",
        payload_hash: "hash-one",
        owner_token: "owner-one",
        lease_expires_at: 130,
        brief_id: "brief-idempotent",
        brief_version: 1,
      },
    ])

    database.database.exec(
      "UPDATE goal_brief_generation_request SET owner_token = 'owner-follower', lease_expires_at = 139, updated_at = 109 WHERE request_id = 'request-lease' AND payload_hash = 'hash-lease' AND brief_id IS NULL AND lease_expires_at <= 109;",
    )
    expect(
      database.database
        .query(
          "SELECT owner_token, lease_expires_at FROM goal_brief_generation_request WHERE request_id = 'request-lease'",
        )
        .get(),
    ).toEqual({ owner_token: "owner-leader", lease_expires_at: 110 })
    database.database.exec(
      "UPDATE goal_brief_generation_request SET owner_token = 'owner-takeover', lease_expires_at = 140, updated_at = 110 WHERE request_id = 'request-lease' AND payload_hash = 'hash-lease' AND brief_id IS NULL AND lease_expires_at <= 110;",
    )
    expect(
      database.database
        .query(
          "SELECT owner_token, lease_expires_at, updated_at FROM goal_brief_generation_request WHERE request_id = 'request-lease'",
        )
        .get(),
    ).toEqual({ owner_token: "owner-takeover", lease_expires_at: 140, updated_at: 110 })

    database.database.exec("DELETE FROM goal_brief WHERE id = 'brief-idempotent';")
    expect(
      database.database
        .query("SELECT request_id FROM goal_brief_generation_request WHERE request_id = 'request-idempotent'")
        .all(),
    ).toEqual([])
  })

  test("upgrades an already-applied idempotency table and binds completed requests to version one", async () => {
    await using database = await fixture(false)
    database.database.exec(await migration())
    database.database.exec(await idempotencyMigration())
    database.database.exec(
      [
        "INSERT INTO goal_brief (id, project_id, created_at, updated_at) VALUES ('brief-upgrade', 'project-existing', 100, 200);",
        "INSERT INTO goal_brief_version (brief_id, version, goal, deliverables_json, acceptance_criteria_json, constraints_json, non_goals_json, assumptions_json, open_questions_json, risk_level, recommended_plan_json, approval_mode, source, source_refs_json, created_at) VALUES ('brief-upgrade', 1, 'Original', '[]', '[]', '[]', '[]', '[]', '[]', 'low', '{}', 'balanced', 'system_suggestion', '[]', 100);",
        "INSERT INTO goal_brief_version (brief_id, version, goal, deliverables_json, acceptance_criteria_json, constraints_json, non_goals_json, assumptions_json, open_questions_json, risk_level, recommended_plan_json, approval_mode, source, source_refs_json, created_at) VALUES ('brief-upgrade', 2, 'Updated', '[]', '[]', '[]', '[]', '[]', '[]', 'low', '{}', 'balanced', 'user_confirmation', '[]', 200);",
        "INSERT INTO goal_brief_generation_request (request_id, payload_hash, owner_token, lease_expires_at, brief_id, created_at, updated_at) VALUES ('request-upgrade', 'hash-upgrade', 'owner-upgrade', 130, 'brief-upgrade', 100, 100);",
      ].join("\n"),
    )

    database.database.exec(await generationVersionMigration())

    expect(
      database.database
        .query(
          "SELECT request_id, brief_id, brief_version FROM goal_brief_generation_request WHERE request_id = 'request-upgrade'",
        )
        .get(),
    ).toEqual({
      request_id: "request-upgrade",
      brief_id: "brief-upgrade",
      brief_version: 1,
    })
  })

  test("upgrades a pre-Charter project database and enforces projection lifecycle", async () => {
    await using database = await fixture(false)
    database.database.exec(await migration())
    database.database.exec(
      [
        "INSERT INTO goal_brief (id, project_id, created_at, updated_at) VALUES ('brief-1', 'project-existing', 100, 100);",
        "INSERT INTO goal_brief_version (brief_id, version, goal, deliverables_json, acceptance_criteria_json, constraints_json, non_goals_json, assumptions_json, open_questions_json, risk_level, recommended_plan_json, approval_mode, source, source_refs_json, created_at) VALUES ('brief-1', 1, 'Goal', '[]', '[]', '[]', '[]', '[]', '[]', 'low', '{}', 'balanced', 'user_input', '[]', 100);",
        "INSERT INTO company_work_projection (project_id, projector_version, source_watermark, projection_json, updated_at) VALUES ('project-existing', 1, 'watermark', '{}', 100);",
        "DELETE FROM company_project WHERE id = 'project-existing';",
      ].join("\n"),
    )

    expect(database.database.query("SELECT project_id FROM goal_brief WHERE id = 'brief-1'").get()).toEqual({
      project_id: null,
    })
    expect(database.database.query("SELECT project_id FROM company_work_projection").all()).toEqual([])
    expect(database.database.query("SELECT version FROM goal_brief_version").all()).toEqual([{ version: 1 }])
  })

  test("upgrades a database with an existing Charter without rewriting it", async () => {
    await using database = await fixture(true)
    const before = database.database.query("SELECT * FROM company_project_charter").all()
    database.database.exec(await migration())

    expect(database.database.query("SELECT * FROM company_project_charter").all()).toEqual(before)
    expect(database.database.query("SELECT id FROM goal_brief").all()).toEqual([])
    expect(database.database.query("SELECT project_id FROM company_work_projection").all()).toEqual([])
  })

  test("preserves historical Life ambient rows byte-for-byte", async () => {
    await using database = await fixture(true)
    const before = database.database.query("SELECT * FROM thread ORDER BY id").all()
    const beforeHash = rowsHash(before)

    database.database.exec(await migration())

    const after = database.database.query("SELECT * FROM thread ORDER BY id").all()
    expect(after).toEqual(before)
    expect(rowsHash(after)).toBe(beforeHash)
    expect(after).toEqual([
      expect.objectContaining({
        id: "thread-life-ambient",
        kind: "ambient",
        description: "Historical Life reflection context",
      }),
    ])
  })

  test("supports forward-compatible binary rollback without changing legacy schemas or rows", async () => {
    await using database = await fixture(true)
    const schemaQuery =
      "SELECT type, name, sql FROM sqlite_master WHERE name IN ('company_project', 'company_project_charter', 'thread') ORDER BY name"
    const legacyQuery =
      "SELECT p.id, c.title, t.kind, t.description FROM company_project p LEFT JOIN company_project_charter c ON c.project_id = p.id CROSS JOIN thread t WHERE t.id = 'thread-life-ambient'"
    const beforeSchema = database.database.query(schemaQuery).all()
    const beforeRows = database.database.query(legacyQuery).all()
    const sql = await migration()

    expect(
      sql
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean)
        .every((statement) => statement.startsWith("CREATE ")),
    ).toBe(true)
    database.database.exec(sql)

    expect(database.database.query(schemaQuery).all()).toEqual(beforeSchema)
    expect(database.database.query(legacyQuery).all()).toEqual(beforeRows)
    expect(rowsHash(database.database.query(schemaQuery).all())).toBe(rowsHash(beforeSchema))
    expect(rowsHash(database.database.query(legacyQuery).all())).toBe(rowsHash(beforeRows))
  })
})
