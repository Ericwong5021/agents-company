import { Database as SQLiteDatabase } from "bun:sqlite"
import { expect, test } from "bun:test"
import { createServer } from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import type { Config } from "../../src/config"
import { shouldAutoDistill, shouldAutoDream } from "../../src/session/auto-dream"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dir, "../..")
const legacyProjectID = "project-reflection-compatibility"
const legacySessionIDs = ["session-current-work", "session-legacy-distill", "session-legacy-dream"]
const seedWorker = `
const Database = await import("./src/storage/db.ts")
const { ProjectTable } = await import("./src/project/project.sql.ts")
const { SessionTable } = await import("./src/session/session.sql.ts")
const { AUTO_DISTILL_TITLE, AUTO_DREAM_TITLE } = await import("./src/session/auto-dream.ts")
const projectID = ${JSON.stringify(legacyProjectID)}
Database.use((db) => {
  db.insert(ProjectTable)
    .values({
      id: projectID,
      worktree: process.env.AGENTCOMPANY_LIFE_COMPAT_WORKSPACE,
      sandboxes: [],
      time_created: 1,
      time_updated: 1,
    })
    .run()
  db.insert(SessionTable)
    .values([
      {
        id: "session-current-work",
        project_id: projectID,
        slug: "current-work",
        directory: process.env.AGENTCOMPANY_LIFE_COMPAT_WORKSPACE,
        title: "Current Work",
        version: "1",
        time_created: 4_000_000_000_000,
        time_updated: 4_000_000_000_000,
      },
      {
        id: "session-legacy-dream",
        project_id: projectID,
        parent_id: "session-current-work",
        slug: "legacy-dream",
        directory: process.env.AGENTCOMPANY_LIFE_COMPAT_WORKSPACE,
        title: AUTO_DREAM_TITLE,
        version: "1",
        time_created: 1,
        time_updated: 1,
      },
      {
        id: "session-legacy-distill",
        project_id: projectID,
        parent_id: "session-current-work",
        slug: "legacy-distill",
        directory: process.env.AGENTCOMPANY_LIFE_COMPAT_WORKSPACE,
        title: AUTO_DISTILL_TITLE,
        version: "1",
        time_created: 2,
        time_updated: 2,
      },
    ])
    .run()
})
Database.close()
`

function capture(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let output = ""
  const done = (async () => {
    const reader = stream.getReader()
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      output = `${output}${decoder.decode(result.value, { stream: true })}`.slice(-24_000)
    }
    output = `${output}${decoder.decode()}`.slice(-24_000)
  })()
  return {
    done,
    read: () => output,
  }
}

async function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("Unable to allocate an isolated loopback port."))
        return
      }
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(address.port)
      })
    })
  })
}

async function compatibilityEnvironment(directory: string, database: string, workspace: string, enabled = false) {
  const home = path.join(directory, "home")
  const agentcompanyHome = path.join(directory, "agentcompany-home")
  const managedConfig = path.join(directory, "managed-config")
  const xdg = {
    data: path.join(directory, "xdg-data"),
    config: path.join(directory, "xdg-config"),
    cache: path.join(directory, "xdg-cache"),
    state: path.join(directory, "xdg-state"),
    runtime: path.join(directory, "xdg-runtime"),
  }
  await Promise.all(
    [home, agentcompanyHome, managedConfig, workspace, ...Object.values(xdg)].map((value) =>
      fs.mkdir(value, { recursive: true }),
    ),
  )
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("AGENTCOMPANY") &&
          !key.startsWith("XDG_") &&
          !["HOME", "USERPROFILE", "DATABASE_URL", "TMPDIR", "TMP", "TEMP", "AGENTS_COMPANY_CHANNEL"].includes(key),
      ),
    ),
    HOME: home,
    USERPROFILE: home,
    AGENTCOMPANY_HOME: agentcompanyHome,
    AGENTCOMPANY_DB: database,
    AGENTCOMPANY_DISABLE_CHANNEL_DB: "1",
    AGENTCOMPANY_DISABLE_CLAUDE_CODE_COMMANDS: "1",
    AGENTCOMPANY_DISABLE_CLAUDE_IMPORT: "1",
    AGENTCOMPANY_DISABLE_DEFAULT_PLUGINS: "1",
    AGENTCOMPANY_DISABLE_GIT: "1",
    AGENTCOMPANY_DISABLE_PROJECT_CONFIG: "1",
    AGENTCOMPANY_DISABLE_PROVIDER_ENV: "1",
    AGENTCOMPANY_LIFE_COMPAT_WORKSPACE: workspace,
    AGENTCOMPANY_PURE: "1",
    AGENTCOMPANY_TEST_MANAGED_CONFIG_DIR: managedConfig,
    XDG_DATA_HOME: xdg.data,
    XDG_CONFIG_HOME: xdg.config,
    XDG_CACHE_HOME: xdg.cache,
    XDG_STATE_HOME: xdg.state,
    XDG_RUNTIME_DIR: xdg.runtime,
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    ...(enabled
      ? {
          AGENTCOMPANY_CONFIG_CONTENT: JSON.stringify({
            dream: { auto: true, interval_days: 1 },
            distill: { auto: true, interval_days: 1 },
          }),
        }
      : {}),
  }
}

async function seedLegacyLifeDatabase(environment: Record<string, string>, database: string) {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", seedWorker],
    cwd: root,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout || `Legacy Life seed worker exited with ${exitCode}.`)
  expect(await Bun.file(database).exists()).toBe(true)
}

function legacyTableBytes(database: string) {
  const sqlite = new SQLiteDatabase(database, { readonly: true, strict: true })
  try {
    sqlite.exec("PRAGMA query_only = ON")
    const encode = (row: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(Object.entries(row)))
    return {
      project: sqlite
        .query("SELECT rowid AS __rowid, * FROM project WHERE id = ? ORDER BY id")
        .all(legacyProjectID)
        .map((row) => encode(row as Record<string, unknown>)),
      session: sqlite
        .query("SELECT rowid AS __rowid, * FROM session WHERE project_id = ? ORDER BY id")
        .all(legacyProjectID)
        .map((row) => encode(row as Record<string, unknown>)),
    }
  } finally {
    sqlite.close()
  }
}

function expectLegacyTablesEqual(
  actual: ReturnType<typeof legacyTableBytes>,
  expected: ReturnType<typeof legacyTableBytes>,
) {
  expect(actual.project).toHaveLength(1)
  expect(actual.session).toHaveLength(3)
  expect(actual.project).toEqual(expected.project)
  expect(actual.session).toEqual(expected.session)
}

async function stopProcess(process: ReturnType<typeof Bun.spawn>, drained: Promise<unknown>) {
  if (process.exitCode === null) process.kill("SIGTERM")
  const graceful = await Promise.race([process.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
  if (!graceful && process.exitCode === null) process.kill("SIGKILL")
  await process.exited
  await drained
}

async function waitForHealth(process: ReturnType<typeof Bun.spawn>, output: () => string, url: string) {
  const deadline = Date.now() + 45_000
  for (;;) {
    const response = await fetch(`${url}/global/health`).catch(() => null)
    if (response?.ok) return response
    if (process.exitCode !== null) throw new Error(`Control Plane exited during startup.\n${output()}`)
    if (Date.now() >= deadline) throw new Error(`Control Plane startup timed out.\n${output()}`)
    await Bun.sleep(100)
  }
}

async function getJson(url: string, output: () => string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} returned ${response.status}.\n${output()}`)
  return response.json() as Promise<unknown>
}

async function runControlPlane(
  workspace: string,
  environment: Record<string, string>,
  database: string,
  expectedEnabled: boolean,
) {
  const port = await availablePort()
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      "--conditions=browser",
      path.join(root, "src/index.ts"),
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    cwd: workspace,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = capture(child.stdout)
  const stderr = capture(child.stderr)
  const output = () => `${stdout.read()}\n${stderr.read()}`.trim()
  const url = `http://127.0.0.1:${port}`
  try {
    const health = (await waitForHealth(child, output, url).then((response) => response.json())) as Record<
      string,
      unknown
    >
    const directory = `directory=${encodeURIComponent(workspace)}`
    const config = (await getJson(`${url}/config?${directory}`, output)) as Record<string, unknown>
    const sessions = (await getJson(`${url}/experimental/session?${directory}`, output)) as Record<string, unknown>[]
    const readiness = (await getJson(`${url}/global/readiness`, output)) as Record<string, unknown>
    expect(health.healthy).toBe(true)
    expect((config.dream as { auto?: boolean } | undefined)?.auto ?? false).toBe(expectedEnabled)
    expect((config.distill as { auto?: boolean } | undefined)?.auto ?? false).toBe(expectedEnabled)
    expect(sessions.map((session) => session.id).sort()).toEqual(legacySessionIDs)
    expect(readiness.ready).toBe(true)
    expect(readiness.database).toBe(database)
  } finally {
    await stopProcess(child, Promise.all([stdout.done, stderr.done]))
  }
}

test("automatic reflection workflows default off", async () => {
  expect(await Effect.runPromise(shouldAutoDream({} as Config.Info))).toBe(false)
  expect(await Effect.runPromise(shouldAutoDream({ dream: { auto: false } } as Config.Info))).toBe(false)
  expect(await Effect.runPromise(shouldAutoDistill({} as Config.Info))).toBe(false)
  expect(await Effect.runPromise(shouldAutoDistill({ distill: { auto: false } } as Config.Info))).toBe(false)
})

test(
  "real Control Plane cold starts preserve legacy Life tables with default-off and explicit-enable configuration",
  async () => {
    await using directory = await tmpdir()
    const database = path.join(directory.path, "legacy-life.db")
    const workspace = path.join(directory.path, "workspace")
    const disabledEnvironment = await compatibilityEnvironment(directory.path, database, workspace)
    await seedLegacyLifeDatabase(disabledEnvironment, database)
    const seeded = legacyTableBytes(database)
    expectLegacyTablesEqual(seeded, seeded)

    await runControlPlane(workspace, disabledEnvironment, database, false)
    expectLegacyTablesEqual(legacyTableBytes(database), seeded)

    await runControlPlane(
      workspace,
      await compatibilityEnvironment(directory.path, database, workspace, true),
      database,
      true,
    )
    expectLegacyTablesEqual(legacyTableBytes(database), seeded)
  },
  { timeout: 120_000 },
)
