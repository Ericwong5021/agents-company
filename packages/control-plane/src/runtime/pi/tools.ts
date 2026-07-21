import path from "node:path"
import { mkdir, realpath, stat } from "node:fs/promises"
import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Type } from "@earendil-works/pi-ai"
import type { AgentRunSpec } from "../interface"

const MAX_OUTPUT_BYTES = 100 * 1024
const writeTools = new Set(["write", "edit"])

function text(content: string) {
  const output = Buffer.byteLength(content) > MAX_OUTPUT_BYTES ? `${content.slice(0, MAX_OUTPUT_BYTES)}\n…(truncated)` : content
  return { content: [{ type: "text" as const, text: output }], details: {} }
}

function contains(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function existingAncestor(target: string): Promise<string> {
  if (await stat(target).then(() => true, () => false)) return target
  const parent = path.dirname(target)
  if (parent === target) return target
  return existingAncestor(parent)
}

function guard(root: string) {
  const resolvedRoot = path.resolve(root)
  return async (requested: string, write = false) => {
    const resolved = path.resolve(resolvedRoot, requested)
    if (!contains(resolvedRoot, resolved)) throw new Error(`Path is outside the authorized workspace: ${requested}`)
    const canonicalRoot = await realpath(resolvedRoot)
    const canonicalTarget = await realpath(write ? await existingAncestor(resolved) : resolved)
    if (!contains(canonicalRoot, canonicalTarget)) throw new Error(`Path is outside the authorized workspace: ${requested}`)
    return resolved
  }
}

function normalizeCommand(command: string, args: string[]) {
  const tokens = command.trim().split(/\s+/)
  if (tokens.length === 1) return { command: tokens[0]!, args }
  if (args.length > 0 || /[\0\r\n'"\\]/.test(command)) return
  return { command: tokens[0]!, args: tokens.slice(1) }
}

function allowedCommand(command: string, args: string[], permissionMode: AgentRunSpec["permissionMode"]) {
  if (args.some((arg) => /(^|--)(pre|hostname-bin|ext-diff|textconv|script-shell|preload|eval|require)(=|$)/i.test(arg))) {
    return false
  }
  if (command === "rg") return true
  if (command === "git") return ["diff", "status", "show", "log", "ls-files", "rev-parse"].includes(args[0] ?? "")
  if (command === "bun") {
    if (args[0] === "install") return permissionMode === "workspace_write"
    if (["test", "typecheck"].includes(args[0] ?? "")) return true
    return args[0] === "run" && /^(test|build|lint|typecheck|check|verify|start|dev)(:|$)/.test(args[1] ?? "")
  }
  if (["npm", "pnpm", "yarn"].includes(command)) {
    if (args[0] === "test") return true
    return args[0] === "run" && /^(test|build|lint|typecheck|check|verify|start|dev)(:|$)/.test(args[1] ?? "")
  }
  return false
}

function safeEnvironment() {
  const allowed = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "CI",
    "NODE_ENV",
  ])
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) => allowed.has(name.toUpperCase()) && value !== undefined))
}

export type PiSkillLoader = (name: string) => Promise<string>

export function createPiTools(
  spec: AgentRunSpec,
  allowedToolIDs: readonly string[],
  options: { loadSkill?: PiSkillLoader; publishSignal?: boolean } = {},
): AgentTool[] {
  const resolve = guard(spec.cwd)
  const tools: AgentTool[] = [
    {
      name: "read",
      label: "Read file",
      description: "Read a UTF-8 text file inside the authorized workspace.",
      parameters: Type.Object({
        path: Type.String({ description: "Workspace-relative file path" }),
        offset: Type.Optional(Type.Number({ minimum: 1 })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 4000 })),
      }),
      execute: async (_callID, raw) => {
        const input = raw as { path: string; offset?: number; limit?: number }
        const lines = (await Bun.file(await resolve(input.path)).text()).split("\n")
        const offset = input.offset ?? 1
        return text(lines.slice(offset - 1, offset - 1 + (input.limit ?? 2000)).map((line, index) => `${offset + index}: ${line}`).join("\n"))
      },
    },
    {
      name: "glob",
      label: "Find files",
      description: "Find files by glob pattern inside the authorized workspace.",
      parameters: Type.Object({ pattern: Type.String() }),
      execute: async (_callID, raw) => {
        const input = raw as { pattern: string }
        const matches: string[] = []
        for await (const item of new Bun.Glob(input.pattern).scan({ cwd: spec.cwd, onlyFiles: true })) {
          await resolve(item)
          matches.push(item)
          if (matches.length === 1000) break
        }
        return text(matches.sort().join("\n"))
      },
    },
    {
      name: "grep",
      label: "Search files",
      description: "Search UTF-8 workspace files for a literal string.",
      parameters: Type.Object({ query: Type.String(), pattern: Type.Optional(Type.String()) }),
      execute: async (_callID, raw) => {
        const input = raw as { query: string; pattern?: string }
        const matches: string[] = []
        for await (const item of new Bun.Glob(input.pattern ?? "**/*").scan({ cwd: spec.cwd, onlyFiles: true })) {
          const file = Bun.file(await resolve(item))
          if (file.size > 1024 * 1024) continue
          const lines = (await file.text()).split("\n")
          lines.forEach((line, index) => {
            if (matches.length < 500 && line.includes(input.query)) matches.push(`${item}:${index + 1}:${line}`)
          })
          if (matches.length === 500) break
        }
        return text(matches.join("\n"))
      },
    },
    {
      name: "write",
      label: "Write file",
      description: "Create or replace a UTF-8 file inside the authorized workspace.",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_callID, raw) => {
        const input = raw as { path: string; content: string }
        const file = await resolve(input.path, true)
        await mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, input.content)
        return text(`Wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}`)
      },
    },
    {
      name: "edit",
      label: "Edit file",
      description: "Replace one exact text occurrence in a workspace file.",
      parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
      execute: async (_callID, raw) => {
        const input = raw as { path: string; oldText: string; newText: string }
        const file = await resolve(input.path, true)
        const content = await Bun.file(file).text()
        const first = content.indexOf(input.oldText)
        if (first < 0) throw new Error("oldText was not found")
        if (content.indexOf(input.oldText, first + input.oldText.length) >= 0) throw new Error("oldText is not unique")
        await Bun.write(file, `${content.slice(0, first)}${input.newText}${content.slice(first + input.oldText.length)}`)
        return text(`Edited ${input.path}`)
      },
    },
    {
      name: "bash",
      label: "Run verification command",
      description:
        "Run a non-shell repository command. Put the executable in command and arguments in args. Supported commands: rg; read-only git; package-manager checks, start/dev scripts, and bun install for workspace-write runs.",
      parameters: Type.Object({
        command: Type.String(),
        args: Type.Array(Type.String(), { maxItems: 100 }),
        timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 30 * 60_000 })),
      }),
      execute: async (_callID, raw, signal) => {
        const input = raw as { command: string; args: string[]; timeoutMs?: number }
        const invocation = normalizeCommand(input.command, input.args)
        if (!invocation || !allowedCommand(invocation.command, invocation.args, spec.permissionMode)) {
          throw new Error(`Command is not allowed by the Control Plane: ${input.command}`)
        }
        const executable = Bun.which(invocation.command)
        if (!executable) throw new Error(`Command is not installed: ${invocation.command}`)
        const child = Bun.spawn([executable, ...invocation.args], {
          cwd: spec.cwd,
          env: safeEnvironment(),
          stdout: "pipe",
          stderr: "pipe",
          signal,
          detached: process.platform !== "win32",
        })
        const timeout = setTimeout(() => {
          if (process.platform === "win32") return child.kill()
          try {
            process.kill(-child.pid, "SIGTERM")
          } catch {
            child.kill()
          }
        }, input.timeoutMs ?? 10 * 60_000)
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]).finally(() => clearTimeout(timeout))
        return text([stdout, stderr, `exit code: ${exitCode}`].filter(Boolean).join("\n"))
      },
    },
    ...(options.loadSkill
      ? [
          {
            name: "skill",
            label: "Load skill",
            description:
              "Load one available professional skill when it is relevant to the current task. Loading a skill does not grant additional permissions.",
            parameters: Type.Object({ name: Type.String({ description: "The skill name from Available Skills" }) }),
            execute: async (_callID: string, raw: unknown) => {
              const input = raw as { name: string }
              return text(await options.loadSkill!(input.name))
            },
          } satisfies AgentTool,
        ]
      : []),
    ...(options.publishSignal
      ? [
          {
            name: "publish_signal",
            label: "Publish governance signal",
            description:
              "Publish a concise conclusion, plan, risk, status, or intervention when you have actually reached one. A plan means the team has a concrete direction that the owner may choose to turn into a project; do not use it merely to end a conversation.",
            parameters: Type.Object({
              signal_type: Type.Union([
                Type.Literal("conclusion"),
                Type.Literal("plan"),
                Type.Literal("status"),
                Type.Literal("risk"),
                Type.Literal("intervention"),
              ]),
              body: Type.String({ minLength: 1 }),
            }),
            execute: async (_callID: string, raw: unknown) => {
              const input = raw as { signal_type: string; body: string }
              return text(`Recorded ${input.signal_type} signal: ${input.body}`)
            },
          } satisfies AgentTool,
        ]
      : []),
  ]
  const allowed = new Set([
    ...allowedToolIDs,
    ...(options.loadSkill ? ["skill"] : []),
    ...(options.publishSignal ? ["publish_signal"] : []),
  ])
  return tools.filter((tool) => allowed.has(tool.name) && (spec.permissionMode !== "read_only" || !writeTools.has(tool.name)))
}
