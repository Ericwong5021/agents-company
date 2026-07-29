import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "path"

test("Graph Supervisor migration preserves projects and resets stale receipt claims", async () => {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.run("CREATE TABLE company_project (id text PRIMARY KEY)")
  db.run(
    "CREATE TABLE company_work_receipt (id text PRIMARY KEY, project_id text NOT NULL, processing_status text NOT NULL)",
  )
  db.run("CREATE TABLE company_graph_mutation (id text PRIMARY KEY)")
  db.run("INSERT INTO company_project (id) VALUES ('project')")
  db.run(
    "INSERT INTO company_work_receipt (id, project_id, processing_status) VALUES ('receipt', 'project', 'processing')",
  )
  const sql = await Bun.file(
    path.join(import.meta.dir, "../../migration/20260729060000_company_graph_supervisor/migration.sql"),
  ).text()
  sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .forEach((statement) => db.run(statement))
  expect(
    db
      .query(
        "SELECT orchestration_state, orchestrator_version, dispatch_paused FROM company_project WHERE id = 'project'",
      )
      .get(),
  ).toEqual({
    orchestration_state: "idle",
    orchestrator_version: 1,
    dispatch_paused: 0,
  })
  expect(
    db
      .query(
        "SELECT processing_status, processing_claim_id, claimed_at, processed_decision_id FROM company_work_receipt WHERE id = 'receipt'",
      )
      .get(),
  ).toEqual({
    processing_status: "pending",
    processing_claim_id: null,
    claimed_at: null,
    processed_decision_id: null,
  })
  expect(
    db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'company_graph_decision'").get(),
  ).toEqual({ name: "company_graph_decision" })
  db.close()
})
