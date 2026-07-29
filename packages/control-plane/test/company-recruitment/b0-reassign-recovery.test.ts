import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"
import { writeB0Artifact } from "./b0-fixture"

type ProbeResult = {
  assignments: Array<{
    id: string
    version: number
    agent_id: string
    status: "assigned" | "active" | "released"
    supersedes_assignment_id?: string
  }>
  initialAssignmentId?: string
  secondAssignmentId?: string
  replayAssignmentId?: string
  contention?: {
    fulfilled: number
    rejected: number
  }
  currentAssignments: number
  identities: Record<string, unknown>
}

async function probe(phase: "seed", database: string, directory: string): Promise<ProbeResult>
async function probe(
  phase: "inspect",
  database: string,
  directory: string,
): Promise<{ restarts: [ProbeResult, ProbeResult] }>
async function probe(phase: "seed" | "inspect", database: string, directory: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "test/company-recruitment/b0-reassign-recovery-probe.ts",
      phase,
      directory,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key !== "AGENTCOMPANY_DB"),
        ),
        AGENTCOMPANY_DB: database,
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
  if (exitCode !== 0) throw new Error(`B0 recovery probe failed: ${stderr || stdout}`)
  return JSON.parse(stdout.trim().split("\n").at(-1)!)
}

afterEach(async () => {
  await resetDatabase()
})

describe("B0 reassign recovery", () => {
  test("b0-reassign-recovery preserves version history and one current assignment across restart and contention", async () => {
    await using tmp = await tmpdir()
    const database = path.join(tmp.path, "b0-reassign.db")
    const seeded = await probe("seed", database, tmp.path)
    expect(seeded.assignments.map((assignment) => assignment.version)).toEqual([1, 2, 3])
    expect(seeded.assignments.filter((assignment) => assignment.status === "released")).toHaveLength(2)
    expect(seeded.currentAssignments).toBe(1)
    expect(seeded.replayAssignmentId).toBe(seeded.secondAssignmentId)
    expect(seeded.contention).toEqual({ fulfilled: 1, rejected: 1 })

    const inspected = await probe("inspect", database, tmp.path)
    const [firstRestart, secondRestart] = inspected.restarts
    expect(firstRestart.assignments).toEqual(seeded.assignments)
    expect(secondRestart.assignments).toEqual(seeded.assignments)
    expect(firstRestart.currentAssignments).toBe(1)
    expect(secondRestart.currentAssignments).toBe(1)
    expect(firstRestart.identities).toEqual(seeded.identities)
    expect(secondRestart.identities).toEqual(seeded.identities)

    await writeB0Artifact("reassign-recovery", {
      schemaVersion: 1,
      history: secondRestart.assignments.map((assignment) => ({
        id: assignment.id,
        version: assignment.version,
        agentId: assignment.agent_id,
        status: assignment.status,
        supersedesAssignmentId: assignment.supersedes_assignment_id,
      })),
      contention: seeded.contention!,
      restarts: 2,
      currentAssignments: secondRestart.currentAssignments,
      identityUnchanged: true,
    })
  })
})
