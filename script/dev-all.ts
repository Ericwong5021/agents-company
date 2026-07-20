#!/usr/bin/env bun

const root = import.meta.dir + "/.."
const services = [
  { name: "control-plane", command: [process.execPath, "run", "dev"] },
  { name: "web", command: [process.execPath, "run", "dev:web"] },
]

const processes = services.map((service) => ({
  ...service,
  process: Bun.spawn({
    cmd: service.command,
    cwd: root,
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
