import fs from "node:fs/promises"
import path from "node:path"

const app = path.resolve(import.meta.dir, "..")
const artifacts = path.join(app, ".artifacts/m1-e2e")
const home = path.join(artifacts, "home")
const repository = path.join(artifacts, "repository")
const hostname = process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"
const port = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
const uiOrigin = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}`

await fs.rm(artifacts, { recursive: true, force: true })
await fs.mkdir(repository, { recursive: true })
await Bun.write(path.join(repository, "README.md"), "# M1 E2E repository\n")

for (const command of [
  ["git", "init", "--initial-branch=main"],
  ["git", "config", "user.email", "m1-e2e@agentcompany.test"],
  ["git", "config", "user.name", "M1 E2E"],
  ["git", "add", "README.md"],
  ["git", "commit", "-m", "Initial M1 fixture"],
]) {
  const git = Bun.spawn({ cmd: command, cwd: repository, stdout: "inherit", stderr: "inherit" })
  if ((await git.exited) !== 0) throw new Error(`Fixture command failed: ${command.join(" ")}`)
}

const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !["AGENTCOMPANY_DB", "AGENTCOMPANY_SERVER_USERNAME", "AGENTCOMPANY_SERVER_PASSWORD"].includes(key),
    ),
  ),
  AGENTCOMPANY_HOME: home,
  AGENTCOMPANY_DISABLE_MODELS_FETCH: "true",
}

const child = Bun.spawn({
  cmd: ["bun", "run", "src/index.ts", "serve", "--hostname", hostname, "--port", port, "--cors", uiOrigin],
  cwd: path.resolve(app, "../opencode"),
  env,
  stdout: "inherit",
  stderr: "inherit",
})

let stopping = false
const stop = () => {
  stopping = true
  child.kill("SIGTERM")
}

process.once("SIGINT", stop)
process.once("SIGTERM", stop)

try {
  const exitCode = await child.exited
  if (!stopping) process.exitCode = exitCode
} finally {
  process.off("SIGINT", stop)
  process.off("SIGTERM", stop)
}
