import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { withLocalApi } from "../local-api"
import { runJsonCommand } from "../output"

export const PermissionCommand = cmd({
  command: "permission",
  describe: "manage pending permissions",
  builder: (yargs: Argv) =>
    yargs.command(PermissionListCommand).command(PermissionReplyCommand).command(PermissionRejectCommand).demandCommand(),
  async handler() {},
})

const PermissionListCommand = cmd({
  command: "list",
  describe: "list pending permissions",
  async handler(args) {
    await runJsonCommand(args, "permission.list", () => withLocalApi((json) => json<unknown[]>("GET", "/permission")))
  },
})

const PermissionReplyCommand = cmd({
  command: "reply <requestID> <reply>",
  describe: "reply to a permission request",
  builder: (yargs: Argv) =>
    yargs
      .positional("requestID", {
        describe: "permission request ID",
        type: "string",
        demandOption: true,
      })
      .positional("reply", {
        describe: "once, always, or reject",
        type: "string",
        choices: ["once", "always", "reject"] as const,
        demandOption: true,
      })
      .option("message", {
        describe: "rejection/correction message",
        type: "string",
      }),
  async handler(args) {
    await runJsonCommand(args, "permission.reply", () =>
      withLocalApi((json) =>
        json<boolean>("POST", `/permission/${encodeURIComponent(args.requestID)}/reply`, {
          reply: args.reply,
          ...(args.message ? { message: args.message } : {}),
        }),
      ),
    )
  },
})

const PermissionRejectCommand = cmd({
  command: "reject <requestID>",
  describe: "reject a permission request",
  builder: (yargs: Argv) =>
    yargs
      .positional("requestID", {
        describe: "permission request ID",
        type: "string",
        demandOption: true,
      })
      .option("message", {
        describe: "rejection/correction message",
        type: "string",
      }),
  async handler(args) {
    await runJsonCommand(args, "permission.reject", () =>
      withLocalApi((json) =>
        json<boolean>("POST", `/permission/${encodeURIComponent(args.requestID)}/reply`, {
          reply: "reject",
          ...(args.message ? { message: args.message } : {}),
        }),
      ),
    )
  },
})
