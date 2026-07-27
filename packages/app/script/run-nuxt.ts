import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const command = Bun.argv[2]
if (command !== "build" && command !== "prepare" && command !== "typecheck") {
  throw new Error("run-nuxt.ts accepts only build, prepare, or typecheck.")
}

const exitCode = await (async () => {
  const child = Bun.spawn(
    [
      "node",
      "--import",
      pathToFileURL(path.join(import.meta.dir, "nuxt-process-lock.mjs")).href,
      fileURLToPath(new URL("./bin/nuxt.mjs", import.meta.resolve("nuxt/package.json"))),
      command,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...Bun.env,
        BETTER_AUTH_SECRET: Bun.env.BETTER_AUTH_SECRET || `${crypto.randomUUID()}${crypto.randomUUID()}`,
        BETTER_AUTH_URL: Bun.env.BETTER_AUTH_URL || "http://127.0.0.1:3210",
        INTERNAL_API_SECRET: Bun.env.INTERNAL_API_SECRET || `${crypto.randomUUID()}${crypto.randomUUID()}`,
        NODE_OPTIONS: "--max-old-space-size=8192",
        AGENT_COMPANY_NUXT_WRAPPER_PID: String(process.pid),
        AGENT_COMPANY_NUXT_LOCK_MODE: "direct",
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  let interruptedExitCode: number | undefined
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  const stop = (signal: "SIGINT" | "SIGTERM", code: number) => {
    interruptedExitCode ??= code
    if (child.exitCode !== null) return
    child.kill(signal)
    forceTimer ??= setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL")
    }, 10_000)
  }
  process.once("SIGINT", () => stop("SIGINT", 130))
  process.once("SIGTERM", () => stop("SIGTERM", 143))
  const childExitCode = await child.exited
  if (forceTimer) clearTimeout(forceTimer)
  return interruptedExitCode ?? childExitCode
})()

process.exit(exitCode)
