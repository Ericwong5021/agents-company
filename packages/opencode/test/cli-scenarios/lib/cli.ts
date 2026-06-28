import path from "path"
import { mkdir } from "fs/promises"

export type CliEnvelope<T = unknown> =
  | {
      ok: true
      type: string
      data: T
    }
  | {
      ok: false
      type: string
      error: {
        code: string
        message: string
        details?: unknown
      }
    }

export type CliRun = {
  args: string[]
  exitCode: number
  stdout: string
  stderr: string
  json?: CliEnvelope
  ndjson: unknown[]
}

export type CliOptions = {
  cwd?: string
  env?: Record<string, string | undefined>
  artifactDir?: string
  expectExitCode?: number
  timeoutMs?: number
}

export const packageRoot = path.resolve(import.meta.dir, "../../..")
const cliEntry = path.join(packageRoot, "src/index.ts")

export async function runCli(args: string[], options: CliOptions = {}): Promise<CliRun> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000)
  const proc = Bun.spawn([process.execPath, "run", cliEntry, ...(options.cwd ? ["--cwd", options.cwd] : []), ...args], {
    cwd: packageRoot,
    env: {
      ...process.env,
      AGENTCOMPANY_DISABLE_CLAUDE_IMPORT: "1",
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
    signal: controller.signal,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout))

  if (options.artifactDir) await writeArtifacts(options.artifactDir, args, stdout, stderr)

  const result = {
    args,
    exitCode,
    stdout,
    stderr,
    json: parseJson(stdout),
    ndjson: parseNdjson(stdout),
  }

  if (exitCode !== (options.expectExitCode ?? 0)) {
    throw new Error(
      [
        `agents ${args.join(" ")} exited with ${exitCode}`,
        stderr.trim() ? `stderr:\n${stderr}` : "",
        stdout.trim() ? `stdout:\n${stdout}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
  }

  return result
}

export function jsonOf<T>(run: CliRun) {
  if (!run.json) throw new Error(`Expected JSON output from: agents ${run.args.join(" ")}\n${run.stdout}`)
  return run.json as CliEnvelope<T>
}

function parseJson(stdout: string) {
  const text = stdout.trim()
  if (!text) return undefined
  try {
    return JSON.parse(text) as CliEnvelope
  } catch {
    return undefined
  }
}

function parseNdjson(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown
      } catch {
        return undefined
      }
    })
    .filter((value): value is unknown => value !== undefined)
}

async function writeArtifacts(artifactDir: string, args: string[], stdout: string, stderr: string) {
  await mkdir(artifactDir, { recursive: true })
  const name = `${Date.now()}-${args.join("-").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120)}`
  await Promise.all([Bun.write(path.join(artifactDir, `${name}.stdout.txt`), stdout), Bun.write(path.join(artifactDir, `${name}.stderr.txt`), stderr)])
}
