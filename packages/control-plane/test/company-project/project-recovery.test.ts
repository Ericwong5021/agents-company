import { expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { PROJECTOR_VERSION } from "../../src/company-project/work-projection"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dir, "../..")
const reportRoot = path.join(root, ".artifacts/seed-grow-a4")
const boundaries = [
  "before_recovery",
  "after_receipts",
  "after_mutations",
  "after_gates",
  "after_work_items",
  "after_projections",
] as const
const ProbeOutput = z.record(z.string(), z.unknown())

function spawnProbe(
  database: string,
  mode: "prepare" | "fault" | "recover" | "verify",
  boundary: (typeof boundaries)[number],
) {
  return Bun.spawnSync({
    cmd: [process.execPath, "test/company-project/project-recovery-probe.ts", mode, boundary],
    cwd: root,
    env: { ...process.env, AGENTCOMPANY_DB: database },
  })
}

function runProbe(
  database: string,
  mode: "prepare" | "fault" | "recover" | "verify",
  boundary: (typeof boundaries)[number],
) {
  const child = spawnProbe(database, mode, boundary)
  const stdout = child.stdout.toString()
  const stderr = child.stderr.toString()
  if (mode === "fault") {
    expect(child.exitCode).toBe(91)
    return
  }
  if (child.exitCode !== 0) throw new Error(stderr || stdout)
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .findLast((entry) => entry.startsWith("{"))
  if (!line) throw new Error(`Project recovery probe returned no JSON: ${stdout}`)
  return ProbeOutput.parse(JSON.parse(line))
}

test(
  "[a4-recovery-matrix] converges exactly once across every startup recovery boundary",
  async () => {
    await using directory = await tmpdir()
    const matrix = boundaries.map((boundary) => {
      const database = path.join(directory.path, `${boundary}.db`)
      runProbe(database, "prepare", boundary)
      runProbe(database, "fault", boundary)
      runProbe(database, "recover", boundary)
      const replay = runProbe(database, "recover", boundary)
      const verification = runProbe(database, "verify", boundary)

      expect(replay).toMatchObject({
        report: {
          receipts: { processed_receipt_ids: [] },
          mutations: {
            applied_mutation_ids: [],
            rejected_mutation_ids: [],
            unresolved_mutation_ids: [],
          },
          gates: {
            reset_gate_ids: [],
            attention_gate_ids: [],
          },
          work_items: {
            completed_work_item_ids: [],
            blocked_work_item_ids: [],
          },
        },
      })
      expect(verification).toMatchObject({
        result: "pass",
        graph_revision: 1,
        source_receipt_status: "processed",
        source_receipt_mutation_id: "mutation-a4-proposed",
        mutation_status: "applied",
        mutation_items: 1,
        mutation_dependencies: 1,
        gates: [
          { id: "gate-a4-circuit", status: "failed" },
          { id: "gate-a4-invalid-pass", status: "pending" },
          { id: "gate-a4-running", status: "pending" },
        ],
        orphan_status: "blocked",
        terminal_status: "completed",
        active_status: "running",
        claimed: {
          status: "pending",
          workflow_run_id: null,
          dispatch_claim_id: null,
        },
        claimed_workflow_status: "cancelled",
        claimed_agent_run_state: "stopped",
        projection_version: PROJECTOR_VERSION,
        projection_rebuilt: true,
        event_counts: {
          "work_receipt.processed": 1,
          "graph_mutation.applied": 1,
          "validation_gate.recovered": 2,
          "attention.requested": 1,
          "work_item.recovered": 2,
          "dispatch.claim_recovered": 1,
        },
      })
      return { boundary, verification }
    })
    const unresolvedDatabase = path.join(directory.path, "unresolved.db")
    runProbe(unresolvedDatabase, "prepare", "before_recovery")
    const unresolved = new SQLite(unresolvedDatabase)
    unresolved.exec(
      "UPDATE company_graph_mutation SET status = 'applied', applied_revision = 2 WHERE id = 'mutation-a4-proposed'; UPDATE company_work_receipt SET processed_mutation_id = 'conflicting-mutation' WHERE id = 'receipt-a4-source';",
    )
    unresolved.close()
    const blocked = spawnProbe(unresolvedDatabase, "recover", "before_recovery")
    expect(blocked.exitCode).not.toBe(0)
    expect(`${blocked.stdout.toString()}\n${blocked.stderr.toString()}`).toContain(
      "Unresolved Graph Mutations: mutation-a4-proposed",
    )

    await fs.mkdir(reportRoot, { recursive: true })
    await Bun.write(
      path.join(reportRoot, "recovery-matrix.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          result: "pass",
          scenario: "a4-recovery-matrix",
          boundaries: matrix,
          unresolved_mutation_startup: "blocked",
        },
        null,
        2,
      )}\n`,
    )
  },
  { timeout: 60_000 },
)
