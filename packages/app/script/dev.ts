import path from "node:path"
import { findLocalEveServerOrigin } from "./dev-server-url"

const packageRoot = path.resolve(import.meta.dir, "..")
const upstreamRoot = packageRoot
const host = Bun.env.HOST || "127.0.0.1"
const port = Bun.env.PORT || "3210"
const workerReadyTimeoutMs = Number(Bun.env.EVE_DEV_SERVER_READY_TIMEOUT_MS || "180000")

if (!Number.isFinite(workerReadyTimeoutMs) || workerReadyTimeoutMs <= 0) {
  throw new Error("EVE_DEV_SERVER_READY_TIMEOUT_MS must be a positive number.")
}

if (Bun.argv.includes("--describe")) {
  console.log(JSON.stringify({
    host,
    port,
    sequencing: "eve-before-nuxt",
    workerReadyTimeoutMs,
  }))
  process.exit(0)
}

const worker = Bun.spawn({
  cmd: [
    "node",
    path.join(packageRoot, "node_modules/eve/bin/eve.js"),
    "dev",
    "--no-ui",
    "--port",
    "0",
  ],
  cwd: upstreamRoot,
  env: Bun.env,
  stdin: "inherit",
  stdout: "pipe",
  stderr: "pipe",
})
const ready = Promise.withResolvers<string>()
let ownsWorker = true

async function forward(
  stream: ReadableStream<Uint8Array> | null,
  write: (text: string) => void,
) {
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

async function terminate(child: Bun.Subprocess) {
  if (process.platform !== "win32") {
    child.kill()
    return
  }

  await Bun.spawn({
    cmd: ["taskkill", "/pid", child.pid.toString(), "/t", "/f"],
    stdout: "ignore",
    stderr: "ignore",
  }).exited
}

const output = [
  forward(worker.stdout, (text) => process.stdout.write(text)),
  forward(worker.stderr, (text) => process.stderr.write(text)),
]
const timeout = setTimeout(
  () => ready.reject(new Error(
    `Timed out after ${workerReadyTimeoutMs}ms waiting for the Eve development worker.`,
  )),
  workerReadyTimeoutMs,
)
const origin = await Promise.race([
  ready.promise,
  worker.exited.then((code) => {
    throw new Error(`Eve development worker exited before becoming ready (code ${code}).`)
  }),
]).finally(() => clearTimeout(timeout)).catch(async (error) => {
  if (ownsWorker) await terminate(worker)
  console.error(error)
  process.exit(1)
})

console.log(`[eve:launcher] worker ready at ${origin}; starting Nuxt on http://${host}:${port}/`)

const nuxt = Bun.spawn({
  cmd: [
    "node",
    path.join(packageRoot, "node_modules/nuxt/bin/nuxt.mjs"),
    "dev",
    "--host",
    host,
    "--port",
    port,
  ],
  cwd: packageRoot,
  env: {
    ...Bun.env,
    EVE_BASE_URL: origin,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
let stopping = false

async function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  await Promise.allSettled([terminate(nuxt), ...(ownsWorker ? [terminate(worker)] : [])])
  await Promise.allSettled(output)
  process.exit(exitCode)
}

process.once("SIGINT", () => void stop())
process.once("SIGTERM", () => void stop())

const result = await Promise.race([
  ...(ownsWorker ? [worker.exited.then((code) => ({ code, name: "Eve development worker" }))] : []),
  nuxt.exited.then((code) => ({ code, name: "Nuxt development server" })),
])

if (!stopping) {
  console.error(`${result.name} exited unexpectedly with code ${result.code}.`)
  await stop(result.code || 1)
}
