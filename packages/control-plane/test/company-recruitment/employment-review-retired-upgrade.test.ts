import { Database as SQLiteDatabase } from "bun:sqlite"
import { expect, test } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import fs from "node:fs/promises"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

const controlPlaneRoot = path.resolve(import.meta.dir, "../..")
const migrationRoot = path.join(controlPlaneRoot, "migration")
const legacyMigration = "20260728020000_employment_review_retired"

const migrations = readdirSync(migrationRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    sql: readFileSync(path.join(migrationRoot, entry.name, "migration.sql"), "utf8"),
    timestamp: Number(entry.name.split("_")[0]),
    name: entry.name,
  }))
  .sort((left, right) => left.timestamp - right.timestamp)

test("upgrades a retired employment review into a readable auditable snapshot", async () => {
  const directory = await fs.mkdtemp(
    path.join(process.env.AGENTCOMPANY_TEST_TMPDIR_ROOT!, "employment-review-retired-upgrade-"),
  )
  const databasePath = path.join(directory, "legacy.db")
  const sqlite = new SQLiteDatabase(databasePath)
  sqlite.run("PRAGMA foreign_keys = ON")
  migrate(
    drizzle({ client: sqlite }),
    migrations.filter((entry) => entry.name <= legacyMigration),
  )
  sqlite.run(
    "INSERT INTO company (id, name, data_version, default_provider_id, default_model_id, bootstrap_request_id, bootstrap_input_path, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["cmp_retired", "Legacy Company", 1, "test", "test-model", "bootstrap-retired", "/tmp/legacy", 1, 1],
  )
  sqlite.run(
    "INSERT INTO company_agent (id, company_id, role_key, lifecycle, name, preferred_runtime, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["agent-retired", "cmp_retired", "legacy-role", "archived", "Legacy Agent", "pi", 1, 1],
  )
  sqlite.run(
    "INSERT INTO company_employment_review (id, company_id, agent_id, status, selected_project_count, successful_project_count, average_quality_score, average_reliability_score, recurring_need_count, rationale, decision_note, time_decided, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "review-retired",
      "cmp_retired",
      "agent-retired",
      "retired",
      1,
      0,
      0,
      0,
      0,
      "Legacy temporary agent retired without delivery evidence.",
      "Original retirement decision.",
      2,
      1,
      2,
    ],
  )
  sqlite.close()

  const child = Bun.spawn(
    [process.execPath, "run", "test/company-recruitment/employment-review-retired-upgrade-probe.ts", "cmp_retired"],
    {
      cwd: controlPlaneRoot,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "AGENTCOMPANY_DB")),
        AGENTCOMPANY_DB: databasePath,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await fs.rm(directory, { recursive: true, force: true })
  if (exitCode !== 0) throw new Error(stderr || stdout)
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!)

  expect(result.snapshotReview).toEqual({
    id: "review-retired",
    company_id: "cmp_retired",
    agent_id: "agent-retired",
    status: "retired",
    selected_project_count: 1,
    successful_project_count: 0,
    average_quality_score: 0,
    average_reliability_score: 0,
    recurring_need_count: 0,
    rationale: "Legacy temporary agent retired without delivery evidence.",
    decision_note: "Original retirement decision.",
    time_decided: 2,
    time_created: 1,
    time_updated: 2,
  })
  expect(result.rawReview).toEqual({
    id: "review-retired",
    status: "retired",
    rationale: "Legacy temporary agent retired without delivery evidence.",
    decision_note: "Original retirement decision.",
    time_decided: 2,
    time_created: 1,
    time_updated: 2,
  })
})
