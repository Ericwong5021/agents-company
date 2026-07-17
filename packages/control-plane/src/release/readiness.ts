import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import * as Database from "@/storage/db"

const durableDirectories = ["company", "memory", "projects", "sessions", "storage", "workspace"]

export type Check = {
  id: string
  status: "pass" | "warning" | "fail"
  detail: string
}

type BackupManifest = {
  version: 1
  created_at: number
  database: string
  directories: string[]
  includes_runtime_homes: boolean
}

async function exists(target: string) {
  return fs.stat(target).then(
    () => true,
    () => false,
  )
}

async function backups() {
  const root = path.join(Global.Path.data, "backups")
  if (!(await exists(root))) return []
  return (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
}

function migrations() {
  return fs
    .readdir(path.join(import.meta.dirname, "../../migration"), { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => /^\d{14}_/.test(name))
        .sort(),
    )
    .catch(() => [])
}

export async function inspect() {
  const [databaseExists, storedBackups, migrationNames] = await Promise.all([
    Database.Path === ":memory:" ? Promise.resolve(false) : exists(Database.Path),
    backups(),
    migrations(),
  ])
  const directories = await Promise.all(
    durableDirectories.map(async (name) => ({ name, exists: await exists(path.join(Global.Path.data, name)) })),
  )
  const checks: Check[] = [
    {
      id: "database",
      status: Database.Path === ":memory:" || databaseExists ? "pass" : "fail",
      detail: Database.Path === ":memory:" ? "In-memory database is active" : Database.Path,
    },
    {
      id: "migrations",
      status: migrationNames.length ? "pass" : "warning",
      detail: migrationNames.length ? `${migrationNames.length} migration directories discovered` : "Migration bundle is unavailable",
    },
    {
      id: "backup",
      status: storedBackups.length ? "pass" : "warning",
      detail: storedBackups[0] ? `Latest backup: ${storedBackups[0]}` : "No local backup has been created yet",
    },
    ...directories.map((entry) => ({
      id: `durable-directory:${entry.name}`,
      status: entry.exists ? ("pass" as const) : ("warning" as const),
      detail: entry.exists ? "Present" : "Created on first use",
    })),
  ]
  return {
    ready: checks.every((check) => check.status !== "fail"),
    database: Database.Path,
    backups: storedBackups,
    checks,
  }
}

export async function createBackup(input: { include_runtime_homes?: boolean } = {}) {
  if (Database.Path === ":memory:") throw new Error("Cannot back up an in-memory database")
  const id = new Date().toISOString().replace(/[:.]/g, "-")
  const root = path.join(Global.Path.data, "backups", id)
  const database = path.join(root, path.basename(Database.Path))
  await fs.mkdir(root, { recursive: true })
  const target = database.replace(/'/g, "''")
  Database.Client().$client.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  Database.Client().$client.exec(`VACUUM INTO '${target}'`)
  const directories = input.include_runtime_homes ? [...durableDirectories, "runs"] : durableDirectories
  await Promise.all(
    directories.map(async (name) => {
      const source = path.join(Global.Path.data, name)
      if (await exists(source)) await fs.cp(source, path.join(root, name), { recursive: true, force: false })
    }),
  )
  const manifest: BackupManifest = {
    version: 1,
    created_at: Date.now(),
    database: path.basename(Database.Path),
    directories,
    includes_runtime_homes: input.include_runtime_homes ?? false,
  }
  await Bun.write(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  return { id, path: root, manifest }
}

export * as ReleaseReadiness from "./readiness"
