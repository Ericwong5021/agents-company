import path from "node:path"
import { mkdirSync, rmSync, symlinkSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { Database } from "bun:sqlite"
import { findLocalEveServerOrigin } from "./dev-server-url"

const packageRoot = path.resolve(import.meta.dir, "..")
const upstreamRoot = packageRoot
const defaultNuxtBuildDirectory = path.join(packageRoot, ".nuxt")
const configuredNuxtBuildDirectory = Bun.env.AGENT_COMPANY_WEBUI_BUILD_DIR
  ? path.resolve(packageRoot, Bun.env.AGENT_COMPANY_WEBUI_BUILD_DIR)
  : defaultNuxtBuildDirectory
const host = Bun.env.HOST || "127.0.0.1"
const port = Bun.env.PORT || "3210"
const workerReadyTimeoutMs = Number(Bun.env.EVE_DEV_SERVER_READY_TIMEOUT_MS || "180000")
const lockTimeoutMs = Number(Bun.env.AGENT_COMPANY_NUXT_LOCK_TIMEOUT_MS || "300000")
const nodePath = (
  await Promise.all(
    [
      ...new Set(
        (Bun.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((directory) => path.join(directory, process.platform === "win32" ? "node.exe" : "node")),
      ),
    ].map(async (candidate) => {
      if (!(await Bun.file(candidate).exists())) return undefined
      const result = Bun.spawnSync([candidate, "--version"], { stdout: "pipe", stderr: "ignore" })
      if (result.exitCode === 0 && Number(result.stdout.toString().match(/^v(\d+)/)?.[1]) >= 24) return candidate
      return undefined
    }),
  )
).find((candidate) => candidate !== undefined)

if (!Number.isFinite(workerReadyTimeoutMs) || workerReadyTimeoutMs <= 0) {
  throw new Error("EVE_DEV_SERVER_READY_TIMEOUT_MS must be a positive number.")
}
if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs <= 0) {
  throw new Error("AGENT_COMPANY_NUXT_LOCK_TIMEOUT_MS must be a positive number.")
}
if (!nodePath) throw new Error("Agent Company WebUI requires Node.js >=24 on PATH.")

if (Bun.argv.includes("--describe")) {
  console.log(
    JSON.stringify({
      host,
      port,
      sequencing: "nuxt-prepare-before-eve-before-nuxt",
      workerReadyTimeoutMs,
    }),
  )
  process.exit(0)
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "EPERM"
  }
}

function lockIsBusy(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("database is locked") ||
      ("code" in error && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_RECOVERY")))
  )
}

const externalOwnerPid = Bun.env.AGENT_COMPANY_NUXT_EXTERNAL_OWNER_PID
  ? Number(Bun.env.AGENT_COMPANY_NUXT_EXTERNAL_OWNER_PID)
  : undefined
if (externalOwnerPid !== undefined && (!Number.isSafeInteger(externalOwnerPid) || externalOwnerPid <= 0)) {
  throw new Error("AGENT_COMPANY_NUXT_EXTERNAL_OWNER_PID must identify a live parent process.")
}

mkdirSync(path.join(packageRoot, ".nuxt-locks"), { recursive: true })
const coordinator = new Database(path.join(packageRoot, ".nuxt-locks/nuxt-coordinator-lock.sqlite"))
coordinator.exec("PRAGMA busy_timeout = 250")
const lockDeadline = Date.now() + lockTimeoutMs

for (;;) {
  if (externalOwnerPid !== undefined && !processIsAlive(externalOwnerPid)) {
    coordinator.close()
    throw new Error(`Nuxt external owner exited before the coordinator lock was acquired: ${externalOwnerPid}.`)
  }
  try {
    coordinator.exec("BEGIN EXCLUSIVE")
    break
  } catch (error) {
    if (!lockIsBusy(error)) {
      coordinator.close()
      throw error
    }
    if (Date.now() >= lockDeadline) {
      coordinator.close()
      throw new Error("Timed out waiting for the shared Nuxt coordinator lock.")
    }
    await Bun.sleep(100)
  }
}

let coordinatorReleased = false
function releaseCoordinator() {
  if (coordinatorReleased) return
  coordinatorReleased = true
  coordinator.exec("ROLLBACK")
  coordinator.close()
}

process.once("exit", releaseCoordinator)

async function terminate(child: Bun.Subprocess) {
  if (child.exitCode !== null) return
  if (process.platform === "win32") {
    await Bun.spawn({
      cmd: ["taskkill", "/pid", child.pid.toString(), "/t", "/f"],
      stdout: "ignore",
      stderr: "ignore",
    }).exited
  } else {
    child.kill("SIGTERM")
    const graceful = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
    if (!graceful && child.exitCode === null) child.kill("SIGKILL")
  }
  await child.exited
}

const children = new Set<Bun.Subprocess>()
const output: Promise<unknown>[] = []
let stopping = false
let ownerMonitor: ReturnType<typeof setInterval> | undefined

async function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  if (ownerMonitor) clearInterval(ownerMonitor)
  await Promise.allSettled([...children].map(terminate))
  await Promise.allSettled(output)
  process.exit(exitCode)
}

process.once("SIGINT", () => void stop(130))
process.once("SIGTERM", () => void stop(143))
if (externalOwnerPid !== undefined) {
  ownerMonitor = setInterval(() => {
    if (processIsAlive(externalOwnerPid)) return
    void stop(143)
  }, 250)
  ownerMonitor.unref()
}

const nuxtEnvironment = {
  ...Bun.env,
  AGENT_COMPANY_NUXT_WRAPPER_PID: String(process.pid),
  AGENT_COMPANY_NUXT_LOCK_MODE: "dev",
  NODE_OPTIONS: [
    Bun.env.NODE_OPTIONS,
    `--import=${pathToFileURL(path.join(packageRoot, "script/nuxt-process-lock.mjs")).href}`,
  ]
    .filter(Boolean)
    .join(" "),
}
const monitorEnvironment = {
  ...Bun.env,
  AGENT_COMPANY_PROCESS_OWNER_PID: String(process.pid),
  NODE_OPTIONS: [
    Bun.env.NODE_OPTIONS,
    `--import=${pathToFileURL(path.join(packageRoot, "script/process-owner-monitor.mjs")).href}`,
  ]
    .filter(Boolean)
    .join(" "),
}
const preparation = Bun.spawn({
  cmd: [nodePath, path.join(packageRoot, "node_modules/nuxt/bin/nuxt.mjs"), "prepare"],
  cwd: packageRoot,
  env: {
    ...nuxtEnvironment,
    AGENT_COMPANY_NUXT_LOCK_MODE: "worker",
  },
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
})
children.add(preparation)
const preparationExitCode = await preparation.exited
children.delete(preparation)
if (preparationExitCode !== 0) {
  console.error(`Nuxt preparation exited unexpectedly with code ${preparationExitCode}.`)
  await stop(preparationExitCode || 1)
}

if (configuredNuxtBuildDirectory !== defaultNuxtBuildDirectory) {
  rmSync(defaultNuxtBuildDirectory, { recursive: true, force: true })
  symlinkSync(
    configuredNuxtBuildDirectory,
    defaultNuxtBuildDirectory,
    process.platform === "win32" ? "junction" : "dir",
  )
  process.once("exit", () => {
    rmSync(defaultNuxtBuildDirectory, { recursive: true, force: true })
    mkdirSync(defaultNuxtBuildDirectory, { recursive: true })
  })
}

const worker = Bun.spawn({
  cmd: [nodePath, path.join(packageRoot, "node_modules/eve/bin/eve.js"), "dev", "--no-ui", "--port", "0"],
  cwd: upstreamRoot,
  env: monitorEnvironment,
  stdin: "inherit",
  stdout: "pipe",
  stderr: "pipe",
})
children.add(worker)
const ready = Promise.withResolvers<string>()
let ownsWorker = true

async function forward(stream: ReadableStream<Uint8Array> | null, write: (text: string) => void) {
  if (!stream) return

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let observed = ""

  for (;;) {
    const result = await reader.read()
    if (result.done) break

    const text = decoder.decode(result.value, { stream: true })
    write(text)
    if (text.includes("A dev server is already running for this eve agent.")) ownsWorker = false
    observed = `${observed}${text}`.slice(-4096)
    const origin = findLocalEveServerOrigin(observed)
    if (origin) ready.resolve(origin)
  }

  const final = decoder.decode()
  if (final) write(final)
}

output.push(
  forward(worker.stdout, (text) => process.stdout.write(text)),
  forward(worker.stderr, (text) => process.stderr.write(text)),
)
const timeout = setTimeout(
  () => ready.reject(new Error(`Timed out after ${workerReadyTimeoutMs}ms waiting for the Eve development worker.`)),
  workerReadyTimeoutMs,
)
const origin = await Promise.race([
  ready.promise,
  worker.exited.then((code) => {
    throw new Error(`Eve development worker exited before becoming ready (code ${code}).`)
  }),
])
  .finally(() => clearTimeout(timeout))
  .catch(async (error) => {
    console.error(error)
    await stop(1)
    throw error
  })

console.log(`[eve:launcher] worker ready at ${origin}; starting Nuxt on http://${host}:${port}/`)

const nuxt = Bun.spawn({
  cmd: [
    nodePath,
    path.join(packageRoot, "node_modules/nuxt/bin/nuxt.mjs"),
    "dev",
    "--no-fork",
    "--host",
    host,
    "--port",
    port,
  ],
  cwd: packageRoot,
  env: {
    ...nuxtEnvironment,
    EVE_BASE_URL: origin,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
children.add(nuxt)

const result = await Promise.race([
  ...(ownsWorker ? [worker.exited.then((code) => ({ code, name: "Eve development worker" }))] : []),
  nuxt.exited.then((code) => ({ code, name: "Nuxt development server" })),
])

if (!stopping) {
  console.error(`${result.name} exited unexpectedly with code ${result.code}.`)
  await stop(result.code || 1)
}
