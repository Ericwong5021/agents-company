import process from "node:process"
import { isMainThread } from "node:worker_threads"

if (isMainThread) {
  const ownerPid = Number(process.env.AGENT_COMPANY_PROCESS_OWNER_PID)
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    throw new Error("AGENT_COMPANY_PROCESS_OWNER_PID must identify a live parent process.")
  }

  function processIsAlive() {
    try {
      process.kill(ownerPid, 0)
      return true
    } catch (error) {
      return error && typeof error === "object" && "code" in error && error.code === "EPERM"
    }
  }

  if (!processIsAlive()) {
    throw new Error(`Process owner exited before startup: ${ownerPid}.`)
  }

  const monitor = setInterval(() => {
    if (processIsAlive()) return
    clearInterval(monitor)
    process.kill(process.pid, "SIGTERM")
  }, 250)
  monitor.unref()
}
