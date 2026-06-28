import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Session } from "../../session"
import { ClaudeImport } from "../../session/claude-import"
import { SessionID } from "../../session/schema"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Locale } from "../../util"
import { Flag } from "../../flag/flag"
import { Filesystem } from "../../util"
import { Process } from "../../util"
import { EOL } from "os"
import path from "path"
import { which } from "../../util/which"
import { AppRuntime } from "@/effect/app-runtime"
import { Provider } from "../../provider"
import { printSuccess, runJsonCommand, type JsonArgs } from "../output"
import { queryString, withLocalApi, type LocalJson } from "../local-api"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.AGENTCOMPANY_GIT_BASH_PATH) {
    const less = path.join(Flag.AGENTCOMPANY_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionCreateCommand)
      .command(SessionListCommand)
      .command(SessionGetCommand)
      .command(SessionDeleteCommand)
      .command(SessionRenameCommand)
      .command(SessionArchiveCommand)
      .command(SessionMessagesCommand)
      .command(SessionPromptCommand)
      .command(SessionCommandCommand)
      .command(SessionForkCommand)
      .command(SessionAbortCommand)
      .command(SessionShareCommand)
      .command(SessionUnshareCommand)
      .command(SessionSummarizeCommand)
      .command(SessionRevertCommand)
      .command(SessionUnrevertCommand)
      .command(SessionDiffCommand)
      .command(SessionTaskCommand)
      .command(SessionImportClaudeCommand)
      .demandCommand(),
  async handler() {},
})

const SessionCreateCommand = cmd({
  command: "create",
  describe: "create a session",
  builder: (yargs: Argv) =>
    yargs.option("title", {
      describe: "session title",
      type: "string",
    }),
  async handler(args) {
    await runJsonCommand(
      args,
      "session.create",
      () =>
        withLocalApi((json) =>
          json<Session.Info>("POST", "/session", args.title ? { title: args.title } : undefined),
        ),
      (session) => session.id,
    )
  },
})

const SessionGetCommand = cmd({
  command: "get <sessionID>",
  describe: "get a session",
  builder: (yargs: Argv) =>
    yargs.positional("sessionID", {
      describe: "session ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "session.get", () =>
      withLocalApi((json) => json<Session.Info>("GET", `/session/${encodeURIComponent(args.sessionID)}`)),
    )
  },
})

export const SessionImportClaudeCommand = cmd({
  command: "import-claude",
  describe: "import Claude Code sessions (~/.claude/projects) into agentcompany",
  builder: (yargs: Argv) =>
    yargs.option("force", {
      describe: "re-sync every session, ignoring the mtime cache",
      type: "boolean",
      default: false,
    }),
  handler: async (args) => {
    const stats = await ClaudeImport.run({ force: args.force })
    UI.println(
      `Claude import: scanned ${stats.scanned}, imported ${stats.imported}, resynced ${stats.resynced}, skipped ${stats.skipped}` +
        (stats.errors.length ? `, errors ${stats.errors.length}` : ""),
    )
    for (const err of stats.errors) UI.error(err)
  },
})

export const SessionDeleteCommand = cmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs: Argv) => {
    return yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    if (args.json) {
      await runJsonCommand(args, "session.delete", () =>
        withLocalApi((json) => json<boolean>("DELETE", `/session/${encodeURIComponent(args.sessionID)}`)),
      )
      return
    }

    await bootstrap(process.cwd(), async () => {
      const sessionID = SessionID.make(args.sessionID)
      try {
        await AppRuntime.runPromise(Session.Service.use((svc) => svc.get(sessionID)))
      } catch {
        UI.error(`Session not found: ${args.sessionID}`)
        process.exit(1)
      }
      await AppRuntime.runPromise(Session.Service.use((svc) => svc.remove(sessionID)))
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
    })
  },
})

const SessionRenameCommand = cmd({
  command: "rename <sessionID> <title>",
  describe: "rename a session",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      })
      .positional("title", {
        describe: "new title",
        type: "string",
        demandOption: true,
      }),
  async handler(args) {
    await runJsonCommand(args, "session.rename", () =>
      withLocalApi((json) =>
        json<Session.Info>("PATCH", `/session/${encodeURIComponent(args.sessionID)}`, {
          title: args.title,
        }),
      ),
    )
  },
})

const SessionArchiveCommand = cmd({
  command: "archive <sessionID>",
  describe: "archive a session",
  builder: (yargs: Argv) =>
    yargs.positional("sessionID", {
      describe: "session ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "session.archive", () =>
      withLocalApi((json) =>
        json<Session.Info>("PATCH", `/session/${encodeURIComponent(args.sessionID)}`, {
          time: { archived: Date.now() },
        }),
      ),
    )
  },
})

const SessionMessagesCommand = cmd({
  command: "messages <sessionID>",
  describe: "list session messages",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      })
      .option("limit", {
        describe: "maximum number of messages",
        type: "number",
      })
      .option("before", {
        describe: "cursor for older messages",
        type: "string",
      })
      .option("agent-id", {
        describe: "message slice to read; use * for all slices",
        type: "string",
      }),
  async handler(args) {
    await runJsonCommand(args, "session.messages", () =>
      withLocalApi((json) =>
        json<unknown[]>(
          "GET",
          `/session/${encodeURIComponent(args.sessionID)}/message${queryString({
            limit: args.limit,
            before: args.before,
            agent_id: args.agentId,
          })}`,
        ),
      ),
    )
  },
})

const SessionPromptCommand = cmd({
  command: "prompt <sessionID> <message..>",
  describe: "send a prompt to a session",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      })
      .positional("message", {
        describe: "prompt text",
        type: "string",
        array: true,
        demandOption: true,
      })
      .option("model", {
        describe: "model in provider/model format",
        type: "string",
      })
      .option("agent", {
        describe: "agent name",
        type: "string",
      })
      .option("variant", {
        describe: "prompt variant",
        type: "string",
      })
      .option("async", {
        describe: "return after accepting the prompt",
        type: "boolean",
        default: false,
      }),
  async handler(args) {
    const body = {
      ...(args.model ? { model: Provider.parseModel(args.model) } : {}),
      ...(args.agent ? { agent: args.agent } : {}),
      ...(args.variant ? { variant: args.variant } : {}),
      parts: [{ type: "text" as const, text: (args.message ?? []).join(" ") }],
    }
    await runJsonCommand(args, args.async ? "session.prompt_async" : "session.prompt", () =>
      withLocalApi((json) =>
        args.async
          ? json<undefined>("POST", `/session/${encodeURIComponent(args.sessionID)}/prompt_async`, body)
          : json<unknown>("POST", `/session/${encodeURIComponent(args.sessionID)}/message`, body),
      ),
    )
  },
})

const SessionCommandCommand = cmd({
  command: "command <sessionID> <command> [arguments..]",
  describe: "run a slash command in a session",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      })
      .positional("command", {
        describe: "command name",
        type: "string",
        demandOption: true,
      })
      .positional("arguments", {
        describe: "command arguments",
        type: "string",
        array: true,
      })
      .option("model", {
        describe: "model in provider/model format",
        type: "string",
      })
      .option("agent", {
        describe: "agent name",
        type: "string",
      })
      .option("variant", {
        describe: "command variant",
        type: "string",
      }),
  async handler(args) {
    await runJsonCommand(args, "session.command", () =>
      withLocalApi((json) =>
        json<unknown>("POST", `/session/${encodeURIComponent(args.sessionID)}/command`, {
          command: args.command,
          arguments: (args.arguments ?? []).join(" "),
          ...(args.model ? { model: args.model } : {}),
          ...(args.agent ? { agent: args.agent } : {}),
          ...(args.variant ? { variant: args.variant } : {}),
        }),
      ),
    )
  },
})

const SessionForkCommand = cmd({
  command: "fork <sessionID>",
  describe: "fork a session",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      })
      .option("message-id", {
        describe: "message ID to fork from",
        type: "string",
      }),
  async handler(args) {
    await runJsonCommand(args, "session.fork", () =>
      withLocalApi((json) =>
        json<Session.Info>("POST", `/session/${encodeURIComponent(args.sessionID)}/fork`, {
          ...(args.messageId ? { messageID: args.messageId } : {}),
        }),
      ),
    )
  },
})

const SessionAbortCommand = cmd({
  command: "abort <sessionID>",
  describe: "abort active session work",
  builder: (yargs: Argv) =>
    yargs.positional("sessionID", {
      describe: "session ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "session.abort", () =>
      withLocalApi((json) => json<boolean>("POST", `/session/${encodeURIComponent(args.sessionID)}/abort`)),
    )
  },
})

const SessionShareCommand = cmd({
  command: "share <sessionID>",
  describe: "share a session",
  builder: (yargs: Argv) =>
    yargs.positional("sessionID", {
      describe: "session ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "session.share", () =>
      withLocalApi((json) => json<Session.Info>("POST", `/session/${encodeURIComponent(args.sessionID)}/share`)),
    )
  },
})

const SessionUnshareCommand = cmd({
  command: "unshare <sessionID>",
  describe: "unshare a session",
  builder: (yargs: Argv) =>
    yargs.positional("sessionID", {
      describe: "session ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "session.unshare", () =>
      withLocalApi((json) => json<Session.Info>("DELETE", `/session/${encodeURIComponent(args.sessionID)}/share`)),
    )
  },
})

const SessionSummarizeCommand = cmd({
  command: "summarize <sessionID>",
  describe: "summarize a session",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      })
      .option("model", {
        describe: "model in provider/model format",
        type: "string",
        demandOption: true,
      })
      .option("auto", {
        describe: "mark as automatic summary",
        type: "boolean",
        default: false,
      }),
  async handler(args) {
    await runJsonCommand(args, "session.summarize", () =>
      withLocalApi((json) => {
        const model = Provider.parseModel(args.model)
        return json<boolean>("POST", `/session/${encodeURIComponent(args.sessionID)}/summarize`, {
          providerID: model.providerID,
          modelID: model.modelID,
          auto: args.auto,
        })
      }),
    )
  },
})

const SessionRevertCommand = cmd({
  command: "revert <sessionID> <messageID>",
  describe: "revert a message",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      })
      .positional("messageID", {
        describe: "message ID",
        type: "string",
        demandOption: true,
      })
      .option("part-id", {
        describe: "part ID",
        type: "string",
      }),
  async handler(args) {
    await runJsonCommand(args, "session.revert", () =>
      withLocalApi((json) =>
        json<Session.Info>("POST", `/session/${encodeURIComponent(args.sessionID)}/revert`, {
          messageID: args.messageID,
          ...(args.partId ? { partID: args.partId } : {}),
        }),
      ),
    )
  },
})

const SessionUnrevertCommand = cmd({
  command: "unrevert <sessionID>",
  describe: "restore reverted messages",
  builder: (yargs: Argv) =>
    yargs.positional("sessionID", {
      describe: "session ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "session.unrevert", () =>
      withLocalApi((json) => json<Session.Info>("POST", `/session/${encodeURIComponent(args.sessionID)}/unrevert`)),
    )
  },
})

const SessionDiffCommand = cmd({
  command: "diff <sessionID> [messageID]",
  describe: "show file diff for a message",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      })
      .positional("messageID", {
        describe: "message ID",
        type: "string",
      }),
  async handler(args) {
    await runJsonCommand(args, "session.diff", () =>
      withLocalApi(async (json) => {
        const messageID = args.messageID ?? (await latestMessageID(json, args.sessionID))
        return json<unknown[]>(
          "GET",
          `/session/${encodeURIComponent(args.sessionID)}/diff${queryString({ messageID })}`,
        )
      }),
    )
  },
})

const SessionTaskCommand = cmd({
  command: "task <action> <sessionID> [taskID]",
  describe: "manage session tasks",
  builder: (yargs: Argv) =>
    yargs
      .positional("action", {
        describe: "task action",
        type: "string",
        choices: ["list", "create", "done", "abandon", "events"],
        demandOption: true,
      })
      .positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      })
      .positional("taskID", {
        describe: "task ID",
        type: "string",
      })
      .option("summary", {
        describe: "task summary or event summary",
        type: "string",
      })
      .option("owner", {
        describe: "task owner",
        type: "string",
      })
      .option("parent-id", {
        describe: "parent task ID",
        type: "string",
      }),
  async handler(args) {
    await runJsonCommand(args, `session.task.${args.action}`, () =>
      withLocalApi((json) => {
        const sessionPath = `/session/${encodeURIComponent(args.sessionID)}/task`
        if (args.action === "list") return json<unknown[]>("GET", sessionPath)
        if (args.action === "create") {
          return json<unknown>("POST", sessionPath, {
            summary: args.summary ?? "CLI task",
            ...(args.owner ? { owner: args.owner } : {}),
            ...(args.parentId ? { parent_id: args.parentId } : {}),
          })
        }
        if (!args.taskID) throw new Error(`taskID is required for ${args.action}`)
        const taskPath = `${sessionPath}/${encodeURIComponent(args.taskID)}`
        if (args.action === "events") return json<unknown[]>("GET", `${taskPath}/events`)
        return json<unknown>("POST", `${taskPath}/${args.action}`, {
          ...(args.summary ? { event_summary: args.summary } : {}),
        })
      }),
    )
  },
})

export const SessionListCommand = cmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs: Argv) => {
    return yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessions = [...Session.list({ roots: true, limit: args.maxCount })]

      if (args.json) {
        printSuccess(args as JsonArgs, "session.list", formatSessionData(sessions))
        return
      }

      if (sessions.length === 0) {
        return
      }

      let output: string
      if (args.format === "json") {
        output = formatSessionJSON(sessions)
      } else {
        output = formatSessionTable(sessions)
      }

      const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

      if (shouldPaginate) {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      } else {
        console.log(output)
      }
    })
  },
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  return JSON.stringify(formatSessionData(sessions), null, 2)
}

function formatSessionData(sessions: Session.Info[]) {
  return sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function messageInfoID(value: unknown) {
  if (!isRecord(value)) return
  if (!isRecord(value.info)) return
  return typeof value.info.id === "string" ? value.info.id : undefined
}

async function latestMessageID(json: LocalJson, sessionID: string) {
  const messages = await json<unknown[]>(
    "GET",
    `/session/${encodeURIComponent(sessionID)}/message${queryString({ agent_id: "*" })}`,
  )
  const latest = messages
    .map(messageInfoID)
    .filter((id): id is string => id !== undefined)
    .at(-1)
  if (!latest) throw new Error("messageID is required because the session has no messages")
  return latest
}
