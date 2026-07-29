import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "path"

test("company_project migration pins existing rows to legacy_full_plan", async () => {
  const db = new Database(":memory:")
  db.run("CREATE TABLE company_project (id text PRIMARY KEY)")
  db.run("INSERT INTO company_project (id) VALUES ('existing')")
  const sql = await Bun.file(
    path.join(import.meta.dir, "../../migration/20260729040000_company_project_seed_strategy/migration.sql"),
  ).text()
  sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .forEach((statement) => db.run(statement))
  expect(db.query("SELECT execution_strategy, seed_mode FROM company_project WHERE id = 'existing'").get()).toEqual({
    execution_strategy: "legacy_full_plan",
    seed_mode: null,
  })
  expect(() =>
    db.run(
      "INSERT INTO company_project (id, execution_strategy, seed_mode) VALUES ('invalid', 'seed_and_grow', 'invalid')",
    ),
  ).toThrow()
  db.close()
})
