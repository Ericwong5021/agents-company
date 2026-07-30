#!/usr/bin/env bun

const root = import.meta.dir + "/.."
const controlPlanePort = process.env.AGENT_COMPANY_DEV_CONTROL_PLANE_PORT ?? "4097"
const controlPlaneUrl = `http://127.0.0.1:${controlPlanePort}`
const webPort = process.env.PORT ?? "3210"
const webUrl = `http://127.0.0.1:${webPort}`
const localAuthSecret = `${crypto.randomUUID()}${crypto.randomUUID()}`
const localInternalSecret = `${crypto.randomUUID()}${crypto.randomUUID()}`

const services = [
  // Shared backend for the canonical Nuxt/Eve WebUI. dev:all owns port 4097 by default.
  {
    name: "control-plane",
    command: [
      process.execPath,
      "run",
      "--cwd",
      "packages/control-plane",
      "script/dev.ts",
      "serve",
      "--port",
      controlPlanePort,
    ],
    env: {},
  },
  // Canonical frontend: Agent Company's Eve/Nuxt application on http://127.0.0.1:3210.
  {
    name: "web",
    command: [process.execPath, "run", "dev:web"],
    env: {
      AGENT_COMPANY_CONTROL_PLANE_URL: controlPlaneUrl,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? localAuthSecret,
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? webUrl,
      INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET ?? localInternalSecret,
    },
  },
]

if (process.argv.includes("--describe")) {
  console.log(JSON.stringify(services.map((service) => ({ name: service.name, command: service.command }))))
  process.exit(0)
}

const processes = services.map((service) => ({
  ...service,
  process: Bun.spawn({
    cmd: service.command,
    cwd: root,
    env: { ...process.env, ...service.env },
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  }),
}))

async function forward(stream: ReadableStream<Uint8Array> | null, name: string, write: (line: string) => void) {
  if (!stream) return

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let remainder = ""

  for (;;) {
    const result = await reader.read()
    if (result.done) break

    const lines = (remainder + decoder.decode(result.value, { stream: true })).split(/\r?\n/)
    remainder = lines.pop() ?? ""
    lines.filter(Boolean).forEach((line) => write(`[${name}] ${line}\n`))
  }

  const line = remainder + decoder.decode()
  if (line) write(`[${name}] ${line}\n`)
}

const output = processes.flatMap(({ name, process: child }) => [
  forward(child.stdout, name, (line) => process.stdout.write(line)),
  forward(child.stderr, name, (line) => process.stderr.write(line)),
])

let stopping = false
function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  processes.forEach(({ process: child }) => {
    if (process.platform === "win32") {
      void Bun.spawn({
        cmd: ["taskkill", "/pid", child.pid.toString(), "/t", "/f"],
        stdout: "ignore",
        stderr: "ignore",
      }).exited
      return
    }
    child.kill()
  })
  void Promise.allSettled(output).then(() => process.exit(exitCode))
}

process.once("SIGINT", () => stop())
process.once("SIGTERM", () => stop())

console.log(`Starting ${services.map((service) => service.name).join(" + ")}. Press Ctrl+C to stop all services.`)

const result = await Promise.race(processes.map(({ name, process }) => process.exited.then((code) => ({ code, name }))))
if (!stopping) {
  console.error(`[${result.name}] exited unexpectedly with code ${result.code ?? 1}; stopping remaining services.`)
  stop(result.code ?? 1)
}
