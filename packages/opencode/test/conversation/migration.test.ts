import { describe, expect, test } from "bun:test"
import { Database as SqliteDatabase } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"

async function fixture() {
  const directory = await fs.mkdtemp(path.join(process.env.TEMP ?? "/tmp", "agentcompany-m2-migration-"))
  const database = new SqliteDatabase(path.join(directory, "conversation.db"))
  database.exec(
    [
      "PRAGMA foreign_keys = ON;",
      "CREATE TABLE project (id text PRIMARY KEY NOT NULL);",
      "CREATE TABLE session (id text PRIMARY KEY NOT NULL);",
      "CREATE TABLE message (id text PRIMARY KEY NOT NULL, session_id text NOT NULL REFERENCES session(id));",
      "CREATE TABLE company (id text PRIMARY KEY NOT NULL, time_created integer NOT NULL);",
      "CREATE TABLE company_agent (id text PRIMARY KEY NOT NULL, company_id text REFERENCES company(id));",
      "CREATE TABLE group_session (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES project(id), title text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);",
      "CREATE TABLE group_message (id text PRIMARY KEY NOT NULL, group_session_id text NOT NULL REFERENCES group_session(id) ON DELETE CASCADE, round_num integer NOT NULL, role text NOT NULL, company_agent_id text, session_id text, content text NOT NULL, status_summary text, time_created integer NOT NULL, time_updated integer NOT NULL);",
      "INSERT INTO company (id, time_created) VALUES ('cmp_local', 100);",
      "INSERT INTO company_agent (id, company_id) VALUES ('board-ceo', 'cmp_local'), ('board-cto', 'cmp_local'), ('board-product-lead', 'cmp_local');",
      "INSERT INTO project (id) VALUES ('project-1');",
      "INSERT INTO group_session (id, project_id, title, time_created, time_updated) VALUES ('ses_group', 'project-1', 'Existing group', 100, 100);",
      "INSERT INTO group_message (id, group_session_id, round_num, role, content, time_created, time_updated) VALUES ('msg_group', 'ses_group', 0, 'user', 'Existing message', 100, 100);",
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
  return Bun.file(path.resolve(import.meta.dir, "../../migration/20260714000000_m2_conversation/migration.sql")).text()
}

describe("M2 conversation migration", () => {
  test("backfills one company and board channel without changing old group-session rows", async () => {
    await using database = await fixture()
    const sql = await migration()
    database.database.exec(sql)

    expect(database.database.query("SELECT id, kind FROM channel ORDER BY id").all()).toEqual([
      { id: "chn_board", kind: "board" },
      { id: "chn_company", kind: "company" },
    ])
    expect(database.database.query("SELECT channel_id, principal_kind, principal_id FROM channel_member ORDER BY channel_id, principal_id").all()).toHaveLength(8)
    expect(database.database.query("SELECT context_policy FROM group_session WHERE id = 'ses_group'").get()).toEqual({
      context_policy: null,
    })
    expect(database.database.query("SELECT external_message_id, runtime_message_id FROM group_message WHERE id = 'msg_group'").get()).toEqual({
      external_message_id: null,
      runtime_message_id: null,
    })

    database.database.exec(
      sql
        .split("--> statement-breakpoint")
        .filter((statement) => statement.trim().startsWith("INSERT INTO channel"))
        .join(";"),
    )
    expect(database.database.query("SELECT id FROM channel").all()).toHaveLength(2)
    expect(database.database.query("SELECT channel_id FROM channel_member").all()).toHaveLength(8)
  })

  test("enforces singleton channel uniqueness and channel-member foreign keys", async () => {
    await using database = await fixture()
    database.database.exec(await migration())

    expect(() =>
      database.database.exec(
        "INSERT INTO channel (id, company_id, kind, title, retention_days, time_created, time_updated) VALUES ('chn_second-board', 'cmp_local', 'board', 'Another board', 0, 100, 100);",
      ),
    ).toThrow()
    expect(() =>
      database.database.exec(
        "INSERT INTO channel_member (channel_id, principal_kind, principal_id, role, time_joined, time_created, time_updated) VALUES ('chn_missing', 'user', 'usr_local', 'member', 100, 100, 100);",
      ),
    ).toThrow()
  })
})
