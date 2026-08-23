import { spawn } from "child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { createInterface } from "readline"
import type {
  AgentRunEvent,
  AgentRunHandle,
  AgentRunResult,
  AgentRunSpec,
  AgentRuntimePort,
  RuntimeID,
  RuntimeMessage,
} from "./interface"
import { RuntimeCapabilityMatrix } from "./capability-matrix"

type CliRuntimeID = Exclude<RuntimeID, "pi">

const runtimeBinaryName = (runtime: CliRuntimeID) => runtime === "codex" ? "codex" : "claude"

function runtimeSearchPath(environment: NodeJS.ProcessEnv = process.env) {
  const home = environment.HOME || environment.USERPROFILE || os.homedir()
  return [...new Set([
    ...(environment.PATH ?? "").split(path.delimiter),
    environment.BUN_INSTALL ? path.join(environment.BUN_INSTALL, "bin") : undefined,
    environment.PNPM_HOME,
    path.join(home, ".bun", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".mise", "shims"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    ...(process.platform === "darwin" ? ["/opt/homebrew/bin"] : []),
    "/usr/local/bin",
  ].filter((item): item is string => Boolean(item)))]
    .join(path.delimiter)
}

export function findCliRuntimeBinary(runtime: CliRuntimeID, environment: NodeJS.ProcessEnv = process.env) {
  return Bun.which(runtimeBinaryName(runtime), { PATH: runtimeSearchPath(environment) }) ?? undefined
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value
  if (Array.isArray(value)) return value.map(text).find((item): item is string => Boolean(item))
  if (!value || typeof value !== "object") return
  const item = value as Record<string, unknown>
  return [item.text, item.result, item.message, item.content, item.output_text].map(text).find((item): item is string => Boolean(item))
}

export function codexPrompt(input: Pick<AgentRunSpec, "prompt" | "systemPrompt">) {
  if (!input.systemPrompt.trim()) return input.prompt
  return [
    "<agent_company_context>",
    input.systemPrompt.trim(),
    "</agent_company_context>",
    "",
    "<agent_company_task>",
    input.prompt,
    "</agent_company_task>",
  ].join("\n")
}

function signalPrompt(input: Pick<AgentRunSpec, "allowSignalPublishing">) {
  if (!input.allowSignalPublishing) return ""
  return [
    "When you reach a concrete conclusion, plan, status, risk, or intervention worth showing outside this worklog, run exactly one command:",
    "agent-company-publish-signal <conclusion|plan|status|risk|intervention> <body>",
    "Use it only for a real high-signal result. Ordinary discussion needs no signal.",
  ].join("\n")
}

export function cliCommand(input: AgentRunSpec): { binary: string; args: string[] } {
  if (input.runtime === "codex") {
    const sandbox = input.permissionMode === "read_only" ? "read-only" : input.permissionMode === "full_access" ? "danger-full-access" : "workspace-write"
    const options = [
      "--json",
      "-c",
      "approval_policy=\"never\"",
      "-c",
      "cli_auth_credentials_store=\"file\"",
      "--ignore-user-config",
    ]
    const args = input.resumeSessionID
      ? ["exec", "resume", ...options, "-c", `sandbox_mode=\"${sandbox}\"`]
      : ["exec", ...options, "--sandbox", sandbox, "--cd", input.cwd]
    if (input.model) args.push("--model", input.model.split("/").slice(1).join("/") || input.model)
    if (input.outputSchema) args.push("--output-schema", path.join(input.runtimeHome, "output-schema.json"))
    if (input.reasoningEffort) args.push("-c", `model_reasoning_effort=\"${input.reasoningEffort}\"`)
    if (input.resumeSessionID) args.push(input.resumeSessionID)
    args.push(codexPrompt({ ...input, systemPrompt: [input.systemPrompt, signalPrompt(input)].filter(Boolean).join("\n\n") }))
    return { binary: "codex", args }
  }

  const permissionMode = input.permissionMode === "read_only" ? "plan" : input.permissionMode === "full_access" ? "bypassPermissions" : "acceptEdits"
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", permissionMode]
  if (input.model) args.push("--model", input.model)
  if (input.systemPrompt) args.push("--system-prompt", input.systemPrompt)
  if (input.resumeSessionID) args.push("--resume", input.resumeSessionID)
  if (input.maxTurns) args.push("--max-turns", String(input.maxTurns))
  args.push(input.prompt)
  return { binary: "claude", args }
}

function prepareCodexHome(input: AgentRunSpec) {
  if (input.runtime !== "codex") return
  const source = path.join(
    process.env.CODEX_HOME ?? path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".codex"),
    "auth.json",
  )
  if (!existsSync(source)) return
  const target = path.join(input.runtimeHome, "auth.json")
  copyFileSync(source, target)
  chmodSync(target, 0o600)
  return target
}

function prepareOutputSchema(input: AgentRunSpec) {
  if (input.runtime !== "codex" || !input.outputSchema) return
  const target = path.join(input.runtimeHome, "output-schema.json")
  const strict = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strict)
    if (!value || typeof value !== "object") return value
    const schema = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strict(item)]))
    if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
      schema.required = Object.keys(schema.properties)
      schema.additionalProperties = false
    }
    return schema
  }
  writeFileSync(target, JSON.stringify(strict(input.outputSchema)))
  return target
}

function prepareSignalPublisher(input: AgentRunSpec) {
  if (input.runtime !== "codex" || !input.allowSignalPublishing) return
  const directory = path.join(input.runtimeHome, "bin")
  const target = path.join(directory, "agent-company-publish-signal")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(
    target,
    [
      "#!/usr/bin/env bun",
      "const [, , signal_type, ...parts] = Bun.argv",
      "const body = parts.join(\" \").trim()",
      "const types = new Set([\"conclusion\", \"plan\", \"status\", \"risk\", \"intervention\"])",
      "if (!types.has(signal_type) || !body) process.exit(2)",
      "process.stdout.write([\"AGENT_COMPANY_SIGNAL\", signal_type, Buffer.from(body).toString(\"base64\")].join(\"\\t\"))",
    ].join("\n"),
  )
  chmodSync(target, 0o700)
}

function publishedSignal(value: unknown) {
  const line = text(value)?.split(/\r?\n/).find((item) => item.trim().startsWith("AGENT_COMPANY_SIGNAL\t"))?.trim()
  if (!line) return
  const [, signal_type, encoded] = line.split("\t")
  const body = encoded ? Buffer.from(encoded, "base64").toString().trim() : ""
  if (!signal_type || !body || !["conclusion", "plan", "status", "risk", "intervention"].includes(signal_type)) return
  return { signal_type, body }
}

function environment(input: AgentRunSpec, binary: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: input.runtimeHome,
    USERPROFILE: input.runtimeHome,
    ...(input.runtime === "codex" ? { CODEX_HOME: input.runtimeHome } : {}),
    PATH: [
      ...(input.runtime === "codex" ? [path.join(input.runtimeHome, "bin")] : []),
      path.dirname(binary),
      runtimeSearchPath(),
    ].join(path.delimiter),
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }
}

function start(input: AgentRunSpec, onEvent: (event: AgentRunEvent) => void): AgentRunHandle {
  const startedAt = Date.now()
  const temporaryCredential = prepareCodexHome(input)
  const temporaryOutputSchema = prepareOutputSchema(input)
  prepareSignalPublisher(input)
  const processCommand = cliCommand(input)
  const binary = findCliRuntimeBinary(input.runtime)
  if (!binary) throw new Error(`${runtimeBinaryName(input.runtime)} executable was not found`)
  const child = spawn(binary, processCommand.args, {
    cwd: input.cwd,
    env: environment(input, binary),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  let sequence = 0
  let sessionID: string | undefined
  let content = ""
  let settled = false
  let interrupted = false
  let resolveCompletion!: (result: AgentRunResult) => void
  const completion = new Promise<AgentRunResult>((resolve) => {
    resolveCompletion = resolve
  })
  const emit = (type: AgentRunEvent["type"], payload: Record<string, unknown>) => {
    onEvent({ runID: input.runID, sequence: sequence++, type, payload, time: Date.now() })
  }
  const complete = (exitCode: number) => {
    if (settled) return
    settled = true
    if (temporaryCredential) rmSync(temporaryCredential, { force: true })
    if (temporaryOutputSchema) rmSync(temporaryOutputSchema, { force: true })
    const normalizedExitCode = interrupted ? 130 : exitCode
    const result = { runID: input.runID, runtime: input.runtime, content, exitCode: normalizedExitCode, sessionID, startedAt, finishedAt: Date.now() }
    emit(normalizedExitCode === 0 ? "completed" : "failed", { exitCode: normalizedExitCode, sessionID, content, interrupted })
    resolveCompletion(result)
  }

  emit("started", { pid: child.pid, runtime: input.runtime, cwd: input.cwd, permissionMode: input.permissionMode })

  if (child.stdout) {
    const lines = createInterface({ input: child.stdout })
    lines.on("line", (line) => {
      const parsed = (() => {
        try {
          return JSON.parse(line) as unknown
        } catch {
          return undefined
        }
      })()
      if (!parsed) return
      const event = record(parsed)
      emit("runtime", event)
      const type = text(event.type)
      const item = record(event.item)
      if ((type === "item.started" || type === "item.completed") && text(item.type) === "command_execution") {
        const rawCommand = text(item.command) ?? ""
        const shellCommand = rawCommand.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/)?.[1]
        const command = shellCommand && shellCommand[0] === shellCommand.at(-1) && ['"', "'"].includes(shellCommand[0]!)
          ? shellCommand.slice(1, -1)
          : shellCommand ?? rawCommand
        const toolCallID = text(item.id) ?? `command-${sequence}`
        emit("tool", {
          piEvent: "tool",
          toolCallID,
          toolName: "bash",
          ...(type === "item.started"
            ? { args: { command, args: [] } }
            : { result: `exit code: ${Number(item.exit_code ?? 0)}\n${text(item.aggregated_output) ?? ""}`, isError: item.status !== "completed" }),
        })
        const signal = type === "item.completed" && /^agent-company-publish-signal\s+/.test(command.trim())
          ? publishedSignal(item.aggregated_output)
          : undefined
        if (signal) {
          emit("tool", {
            piEvent: "tool",
            toolCallID,
            toolName: "publish_signal",
            args: signal,
            result: `Recorded ${signal.signal_type} signal`,
            isError: false,
          })
        }
      }
      const candidateSession = text(event.session_id) ?? text(event.thread_id)
      if (candidateSession && candidateSession !== sessionID) {
        sessionID = candidateSession
        emit("session", { sessionID })
      }
      if (input.runtime === "claude-code" && type === "result") content = text(event.result) ?? content
      if (input.runtime === "codex" && type === "item.completed") content = text(event.item) ?? content
      if (input.runtime === "codex" && type === "turn.completed" && !content) content = text(event) ?? content
    })
  }

  if (child.stderr) {
    child.stderr.on("data", (value: Buffer) => emit("stderr", { text: value.toString() }))
  }

  child.on("error", (error) => {
    emit("failed", { message: error.message })
    complete(1)
  })
  child.on("close", (code) => complete(code ?? 1))

  return {
    completion,
    interrupt() {
      if (child.exitCode !== null) return
      interrupted = true
      child.kill("SIGTERM")
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL")
      }, 5_000)
      timer.unref()
    },
  }
}

class CliRuntimeAdapter implements AgentRuntimePort {
  private readonly active = new Map<string, AgentRunHandle>()

  constructor(readonly runtime: CliRuntimeID) {}

  capabilities() {
    return RuntimeCapabilityMatrix[this.runtime]
  }

  async discover() {
    const name = runtimeBinaryName(this.runtime)
    const binary = findCliRuntimeBinary(this.runtime)
    const version = binary
      ? await (async () => {
          const child = Bun.spawn([binary, "--version"], {
            env: { ...process.env, PATH: runtimeSearchPath() },
            stdout: "pipe",
            stderr: "ignore",
          })
          const output = (await new Response(child.stdout).text()).trim()
          return (await child.exited) === 0 ? output : undefined
        })()
      : undefined
    return {
      runtime: this.runtime,
      available: Boolean(binary),
      version,
      authenticated: undefined,
      reason: binary ? undefined : `${name} executable was not found`,
    }
  }

  start(input: AgentRunSpec, onEvent: (event: AgentRunEvent) => void): AgentRunHandle {
    if (input.runtime !== this.runtime) throw new Error(`Runtime adapter ${this.runtime} cannot start ${input.runtime}`)
    if (input.lifecycle === "idle_cached" && !this.capabilities().resume) {
      throw new Error(`Runtime ${this.runtime} does not support idle_cached lifecycle`)
    }
    if (input.resumeSessionID && !this.capabilities().resume) {
      throw new Error(`Runtime ${this.runtime} does not support session resume`)
    }
    const handle = start(input, onEvent)
    this.active.set(input.runID, handle)
    void handle.completion.finally(() => this.active.delete(input.runID))
    return handle
  }

  resume(input: AgentRunSpec, onEvent: (event: AgentRunEvent) => void) {
    if (!input.resumeSessionID) throw new Error(`Runtime ${this.runtime} resume requires a session id`)
    return this.start(input, onEvent)
  }

  async deliver(_message: RuntimeMessage) {
    throw new Error(`Runtime ${this.runtime} does not support live input through the CLI compatibility adapter`)
  }

  async interrupt(runID: string) {
    const handle = this.active.get(runID)
    if (!handle) return false
    handle.interrupt()
    return true
  }

  stop(runID: string) {
    return this.interrupt(runID)
  }
}

export function createCliRuntimeAdapter(runtime: CliRuntimeID): AgentRuntimePort {
  return new CliRuntimeAdapter(runtime)
}
