import type { Argv } from "yargs"
import { EOL } from "os"
import { cmd } from "./cmd"
import { withLocalApi } from "../local-api"
import { runJsonCommand } from "../output"

export const GroupCommand = cmd({
  command: "group",
  describe: "manage group sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(GroupListCommand)
      .command(GroupCreateCommand)
      .command(GroupGetCommand)
      .command(GroupMessagesCommand)
      .command(GroupChatCommand)
      .command(GroupStatusCommand)
      .command(GroupInterruptCommand)
      .command(GroupDeleteCommand)
      .command(GroupTranscriptCommand)
      .demandCommand(),
  async handler() {},
})

const GroupListCommand = cmd({
  command: "list",
  describe: "list group sessions",
  async handler(args) {
    await runJsonCommand(args, "group.list", () => withLocalApi((json) => json<unknown[]>("GET", "/group-session")))
  },
})

const GroupCreateCommand = cmd({
  command: "create <title>",
  describe: "create a group session",
  builder: (yargs: Argv) =>
    yargs
      .positional("title", {
        describe: "group title",
        type: "string",
        demandOption: true,
      })
      .option("agent", {
        describe: "company agent ID; can be repeated",
        type: "string",
        array: true,
        demandOption: true,
      }),
  async handler(args) {
    await runJsonCommand(args, "group.create", () =>
      withLocalApi((json) =>
        json<unknown>("POST", "/group-session", {
          title: args.title,
          agentIDs: args.agent,
        }),
      ),
    )
  },
})

const GroupGetCommand = cmd({
  command: "get <id>",
  describe: "get a group session",
  builder: (yargs: Argv) =>
    yargs.positional("id", {
      describe: "group session ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "group.get", () =>
      withLocalApi((json) => json<unknown>("GET", `/group-session/${encodeURIComponent(args.id)}`)),
    )
  },
})

const GroupMessagesCommand = cmd({
  command: "messages <id>",
  describe: "list group messages",
  builder: (yargs: Argv) =>
    yargs.positional("id", {
      describe: "group session ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "group.messages", () =>
      withLocalApi((json) => json<unknown[]>("GET", `/group-session/${encodeURIComponent(args.id)}/messages`)),
    )
  },
})

const GroupChatCommand = cmd({
  command: "chat <id> <message..>",
  describe: "send a message to a group session",
  builder: (yargs: Argv) =>
    yargs
      .positional("id", {
        describe: "group session ID",
        type: "string",
        demandOption: true,
      })
      .positional("message", {
        describe: "message text",
        type: "string",
        array: true,
        demandOption: true,
      }),
  async handler(args) {
    await runJsonCommand(args, "group.chat", () =>
      withLocalApi((json) =>
        json<unknown>("POST", `/group-session/${encodeURIComponent(args.id)}/chat`, {
          text: (args.message ?? []).join(" "),
        }),
      ),
    )
  },
})

const GroupStatusCommand = cmd({
  command: "status <id>",
  describe: "get group busy status",
  builder: (yargs: Argv) =>
    yargs.positional("id", {
      describe: "group session ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "group.status", () =>
      withLocalApi((json) => json<unknown>("GET", `/group-session/${encodeURIComponent(args.id)}/status`)),
    )
  },
})

const GroupInterruptCommand = cmd({
  command: "interrupt <id>",
  describe: "interrupt group agents",
  builder: (yargs: Argv) =>
    yargs.positional("id", {
      describe: "group session ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "group.interrupt", () =>
      withLocalApi((json) => json<boolean>("POST", `/group-session/${encodeURIComponent(args.id)}/interrupt`)),
    )
  },
})

const GroupDeleteCommand = cmd({
  command: "delete <id>",
  describe: "delete a group session",
  builder: (yargs: Argv) =>
    yargs.positional("id", {
      describe: "group session ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "group.delete", () =>
      withLocalApi((json) => json<boolean>("DELETE", `/group-session/${encodeURIComponent(args.id)}`)),
    )
  },
})

const GroupTranscriptCommand = cmd({
  command: "transcript <id>",
  describe: "print group transcript",
  builder: (yargs: Argv) =>
    yargs.positional("id", {
      describe: "group session ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(
      args,
      "group.transcript",
      () => withLocalApi((json) => json<unknown[]>("GET", `/group-session/${encodeURIComponent(args.id)}/messages`)),
      (messages) => messages.map((message) => JSON.stringify(message)).join(EOL),
    )
  },
})
