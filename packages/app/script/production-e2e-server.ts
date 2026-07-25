import fs from "node:fs/promises"
import path from "node:path"

const packageRoot = import.meta.dir.replace(/[\\/]script$/, "")
await fs.mkdir(path.join(packageRoot, ".artifacts"), { recursive: true })
const temporaryRoot = await fs.mkdtemp(path.join(packageRoot, ".artifacts/production-e2e-"))
const env = {
  ...Bun.env,
  AGENT_COMPANY_WEBUI_DATA_DIR: Bun.env.AGENT_COMPANY_WEBUI_DATA_DIR || path.join(temporaryRoot, "data"),
  AGENT_COMPANY_WEBUI_BUILD_DIR: Bun.env.AGENT_COMPANY_WEBUI_BUILD_DIR || path.join(temporaryRoot, "build"),
  AGENT_COMPANY_WEBUI_OUTPUT_DIR: Bun.env.AGENT_COMPANY_WEBUI_OUTPUT_DIR || path.join(temporaryRoot, "output"),
}

async function terminate(child: Bun.Subprocess, signal: "SIGINT" | "SIGTERM" = "SIGTERM") {
  if (child.exitCode !== null) return
  child.kill(signal)
  const graceful = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
  if (!graceful && child.exitCode === null) child.kill("SIGKILL")
  await child.exited
}

const children = new Set<Bun.Subprocess>()
let interruptedExitCode: number | undefined

async function stop(signal: "SIGINT" | "SIGTERM", code: number) {
  interruptedExitCode ??= code
  await Promise.allSettled([...children].map((child) => terminate(child, signal)))
}

process.once("SIGINT", () => void stop("SIGINT", 130))
process.once("SIGTERM", () => void stop("SIGTERM", 143))

async function run(command: string[]) {
  const child = Bun.spawn(command, {
    cwd: packageRoot,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  children.add(child)
  const exitCode = await child.exited
  children.delete(child)
  return exitCode
}

const exitCode = await (async () => {
  try {
    const linkerCode = await run(["bun", "./script/link-eve-dependencies.ts"])
    if (interruptedExitCode !== undefined) return interruptedExitCode
    if (linkerCode !== 0) return linkerCode

    const buildCode = await run(["bun", "./script/run-nuxt.ts", "build"])
    if (interruptedExitCode !== undefined) return interruptedExitCode
    if (buildCode !== 0) return buildCode

    const nativePackage = {
      "darwin-arm64": "@libsql/darwin-arm64",
      "darwin-x64": "@libsql/darwin-x64",
      "linux-x64": "@libsql/linux-x64-gnu",
      "win32-x64": "@libsql/win32-x64-msvc",
    }[`${process.platform}-${process.arch}`]
    if (
      !nativePackage ||
      !(await Bun.file(
        path.join(env.AGENT_COMPANY_WEBUI_OUTPUT_DIR, "server/node_modules", nativePackage, "package.json"),
      ).exists())
    ) {
      console.error(`Production output is missing the libsql native package for ${process.platform}-${process.arch}`)
      return 1
    }

    return await run(["bun", "./script/preview.ts"])
  } finally {
    await Promise.allSettled([...children].map((child) => terminate(child)))
    await fs.rm(temporaryRoot, { recursive: true, force: true })
  }
})()

process.exit(interruptedExitCode ?? exitCode)
