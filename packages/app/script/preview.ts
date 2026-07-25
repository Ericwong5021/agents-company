import path from "node:path"

const port = Bun.env.PORT || "3210"
const host = Bun.env.HOST || "127.0.0.1"
const baseURL = Bun.env.BETTER_AUTH_URL || `http://${host}:${port}`
const server = Bun.spawn(["node", path.join(Bun.env.AGENT_COMPANY_WEBUI_OUTPUT_DIR || ".output", "server/index.mjs")], {
  cwd: import.meta.dir.replace(/[\\/]script$/, ""),
  env: {
    ...process.env,
    BETTER_AUTH_URL: baseURL,
    HOST: host,
    PORT: port,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

console.log(`Agent Company preview: ${baseURL}`)
let interruptedExitCode: number | undefined
let forceTimer: ReturnType<typeof setTimeout> | undefined
const stop = (signal: "SIGINT" | "SIGTERM", code: number) => {
  interruptedExitCode ??= code
  if (server.exitCode !== null) return
  server.kill(signal)
  forceTimer ??= setTimeout(() => {
    if (server.exitCode === null) server.kill("SIGKILL")
  }, 10_000)
}
process.once("SIGINT", () => stop("SIGINT", 130))
process.once("SIGTERM", () => stop("SIGTERM", 143))
const serverExitCode = await server.exited
if (forceTimer) clearTimeout(forceTimer)
process.exit(interruptedExitCode ?? serverExitCode)
