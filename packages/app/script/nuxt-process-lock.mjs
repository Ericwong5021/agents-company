import path from "node:path"
import process from "node:process"
import { mkdirSync, rmSync, symlinkSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { isMainThread } from "node:worker_threads"

const mode = process.env.AGENT_COMPANY_NUXT_LOCK_MODE
if (mode !== "direct" && mode !== "dev" && mode !== "worker") {
  throw new Error("AGENT_COMPANY_NUXT_LOCK_MODE must be direct, dev, or worker.")
}

const timeoutMs = Number(process.env.AGENT_COMPANY_NUXT_LOCK_TIMEOUT_MS || "300000")
const lockNames = !isMainThread ? [] : mode === "direct" ? ["coordinator", "worker"] : ["worker"]
const watchedPids = [
  Number(process.env.AGENT_COMPANY_NUXT_WRAPPER_PID),
  ...(process.env.AGENT_COMPANY_NUXT_EXTERNAL_OWNER_PID
    ? [Number(process.env.AGENT_COMPANY_NUXT_EXTERNAL_OWNER_PID)]
    : []),
]
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("AGENT_COMPANY_NUXT_LOCK_TIMEOUT_MS must be a positive number.")
}
if (watchedPids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
  throw new Error("Nuxt lock owner PIDs must identify live parent processes.")
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "EPERM"
  }
}

function lockIsBusy(error) {
  return (
    error &&
    typeof error === "object" &&
    (("errcode" in error && error.errcode === 5) ||
      ("errstr" in error && error.errstr === "database is locked"))
  )
}

const databases = []

for (const lockName of lockNames) {
  mkdirSync(path.resolve(import.meta.dirname, "../.nuxt-locks"), { recursive: true })
  const database = new DatabaseSync(
    path.resolve(import.meta.dirname, `../.nuxt-locks/nuxt-${lockName}-lock.sqlite`),
  )
  database.exec("PRAGMA busy_timeout = 250")
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (!watchedPids.every(processIsAlive)) {
      database.close()
      throw new Error(`Nuxt owner exited before the ${lockName} lock was acquired: ${watchedPids.join(", ")}.`)
    }
    try {
      database.exec("BEGIN EXCLUSIVE")
      databases.push(database)
      break
    } catch (error) {
      if (!lockIsBusy(error)) {
        database.close()
        throw error
      }
      if (Date.now() >= deadline) {
        database.close()
        throw new Error(`Timed out waiting for the shared Nuxt ${lockName} lock.`)
      }
      await delay(100)
    }
  }
}

const packageRoot = path.resolve(import.meta.dirname, "..")
const defaultNuxtBuildDirectory = path.join(packageRoot, ".nuxt")
const configuredNuxtBuildDirectory = process.env.AGENT_COMPANY_WEBUI_BUILD_DIR
  ? path.resolve(packageRoot, process.env.AGENT_COMPANY_WEBUI_BUILD_DIR)
  : defaultNuxtBuildDirectory
const ownsCustomBuildLink =
  isMainThread && mode === "direct" && configuredNuxtBuildDirectory !== defaultNuxtBuildDirectory

if (ownsCustomBuildLink) {
  mkdirSync(configuredNuxtBuildDirectory, { recursive: true })
  rmSync(defaultNuxtBuildDirectory, { recursive: true, force: true })
  symlinkSync(
    configuredNuxtBuildDirectory,
    defaultNuxtBuildDirectory,
    process.platform === "win32" ? "junction" : "dir",
  )
}

let released = false
function release() {
  if (released) return
  released = true
  if (ownsCustomBuildLink) {
    rmSync(defaultNuxtBuildDirectory, { recursive: true, force: true })
    mkdirSync(defaultNuxtBuildDirectory, { recursive: true })
  }
  for (const database of databases.reverse()) {
    database.exec("ROLLBACK")
    database.close()
  }
}

if (isMainThread) {
  const monitor = setInterval(() => {
    if (watchedPids.every(processIsAlive)) return
    clearInterval(monitor)
    process.kill(process.pid, "SIGTERM")
  }, 250)
  monitor.unref()

  process.once("exit", release)
}
