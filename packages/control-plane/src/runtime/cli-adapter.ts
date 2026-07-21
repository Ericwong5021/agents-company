import { spawn } from "child_process"
import { createInterface } from "readline"
import type {
  AgentRunEvent,
  AgentRunHandle,
  AgentRunResult,
  AgentRunSpec,
  AgentRuntimePort,
  RuntimeCapabilities,
  RuntimeID,
  RuntimeMessage,
} from "./interface"

type CliRuntimeID = Exclude<RuntimeID, "pi">

const capabilities: Record<CliRuntimeID, RuntimeCapabilities> = {
  "claude-code": {
    resume: true,
    interrupt: true,
    liveInput: false,
    structuredEvents: true,
    toolCalls: true,
    structuredOutput: true,
    workspaceRead: true,
    workspaceWrite: true,
    approvals: true,
    reasoningEffort: false,
    subagents: true,
    usageAccounting: true,
    dynamicSkills: false,
    governanceSignals: false,
  },
  codex: {
    resume: true,
    interrupt: true,
    liveInput: false,
    structuredEvents: true,
    toolCalls: true,
    structuredOutput: true,
    workspaceRead: true,
    workspaceWrite: true,
    approvals: true,
    reasoningEffort: true,
    subagents: true,
    usageAccounting: true,
    dynamicSkills: false,
    governanceSignals: false,
  },
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value
  if (Array.isArray(value)) return value.map(text).find((item): item is string => Boolean(item))
  const item = record(value)
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

export function cliCommand(input: AgentRunSpec): { binary: string; args: string[] } {
  if (input.runtime === "codex") {
    const sandbox = input.permissionMode === "read_only" ? "read-only" : input.permissionMode === "full_access" ? "danger-full-access" : "workspace-write"
    const args = input.resumeSessionID
      ? ["exec", "resume", "--json", "-c", `sandbox_mode=\"${sandbox}\"`, "-c", "approval_policy=\"never\""]
      : ["exec", "--json", "--sandbox", sandbox, "--ask-for-approval", "never", "--cd", input.cwd]
    if (input.model) args.push("--model", input.model)
    if (input.reasoningEffort) args.push("-c", `model_reasoning_effort=\"${input.reasoningEffort}\"`)
    if (input.resumeSessionID) args.push(input.resumeSessionID)
    args.push(codexPrompt(input))
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

function environment(input: AgentRunSpec): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: input.runtimeHome,
    USERPROFILE: input.runtimeHome,
    ...(input.runtime === "codex" ? { CODEX_HOME: input.runtimeHome } : {}),
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }
}

function start(input: AgentRunSpec, onEvent: (event: AgentRunEvent) => void): AgentRunHandle {
  const startedAt = Date.now()
  const processCommand = cliCommand(input)
  const child = spawn(processCommand.binary, processCommand.args, {
    cwd: input.cwd,
    env: environment(input),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  let sequence = 0
  let sessionID: string | undefined
  let content = ""
  let settled = false
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
    const result = { runID: input.runID, runtime: input.runtime, content, exitCode, sessionID, startedAt, finishedAt: Date.now() }
    emit(exitCode === 0 ? "completed" : "failed", { exitCode, sessionID, content })
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
    return capabilities[this.runtime]
  }

  async discover() {
    const binary = this.runtime === "codex" ? "codex" : "claude"
    const available = Boolean(Bun.which(binary))
    const version = available
      ? await (async () => {
          const process = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "ignore" })
          const output = (await new Response(process.stdout).text()).trim()
          return (await process.exited) === 0 ? output : undefined
        })()
      : undefined
    return {
      runtime: this.runtime,
      available,
      version,
      authenticated: undefined,
      reason: available ? undefined : `${binary} executable was not found`,
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
