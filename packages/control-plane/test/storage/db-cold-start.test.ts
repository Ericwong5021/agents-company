import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dir, "../..")
const worker = `
const Database = await import("./src/storage/db.ts")
Database.Client().run("SELECT 1")
const journalMode = Database.Client().$client.query("PRAGMA journal_mode").get()
if (journalMode?.journal_mode !== "wal") process.exit(1)
Database.close()
`

async function coldStart(database: string) {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", worker],
    cwd: root,
    env: { ...process.env, AGENTCOMPANY_DB: database },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe.serial("Database.Client cold start", () => {
  test(
    "opens the same migrated WAL database from two processes",
    async () => {
      await using directory = await tmpdir()
      const database = path.join(directory.path, "cold-start.db")
      expect((await coldStart(database)).exitCode).toBe(0)

      for (let attempt = 0; attempt < 30; attempt++) {
        await fs.rm(database + "-shm", { force: true })
        expect(
          (await Promise.all([coldStart(database), coldStart(database)])).filter((result) => result.exitCode !== 0),
        ).toEqual([])
      }
    },
    { timeout: 60_000 },
  )
})
