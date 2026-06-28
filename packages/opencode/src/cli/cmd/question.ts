import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { withLocalApi } from "../local-api"
import { runJsonCommand } from "../output"

export const QuestionCommand = cmd({
  command: "question",
  describe: "manage pending questions",
  builder: (yargs: Argv) =>
    yargs
      .command(QuestionListCommand)
      .command(QuestionReplyCommand)
      .command(QuestionRejectCommand)
      .command(QuestionNeverAskCommand)
      .demandCommand(),
  async handler() {},
})

const QuestionListCommand = cmd({
  command: "list",
  describe: "list pending questions",
  async handler(args) {
    await runJsonCommand(args, "question.list", () => withLocalApi((json) => json<unknown[]>("GET", "/question")))
  },
})

const QuestionReplyCommand = cmd({
  command: "reply <requestID>",
  describe: "reply to a question request",
  builder: (yargs: Argv) =>
    yargs
      .positional("requestID", {
        describe: "question request ID",
        type: "string",
        demandOption: true,
      })
      .option("answers", {
        describe: "JSON array of answer arrays",
        type: "string",
        demandOption: true,
      }),
  async handler(args) {
    await runJsonCommand(args, "question.reply", () =>
      withLocalApi((json) =>
        json<boolean>("POST", `/question/${encodeURIComponent(args.requestID)}/reply`, {
          answers: JSON.parse(args.answers),
        }),
      ),
    )
  },
})

const QuestionRejectCommand = cmd({
  command: "reject <requestID>",
  describe: "reject a question request",
  builder: (yargs: Argv) =>
    yargs.positional("requestID", {
      describe: "question request ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "question.reject", () =>
      withLocalApi((json) => json<boolean>("POST", `/question/${encodeURIComponent(args.requestID)}/reject`)),
    )
  },
})

const QuestionNeverAskCommand = cmd({
  command: "never-ask [enabled]",
  describe: "get or set never-ask state",
  builder: (yargs: Argv) =>
    yargs.positional("enabled", {
      describe: "true or false",
      type: "boolean",
    }),
  async handler(args) {
    await runJsonCommand(args, "question.never-ask", () =>
      withLocalApi((json) =>
        args.enabled === undefined
          ? json<boolean>("GET", "/question/never-ask")
          : json<boolean>("POST", "/question/never-ask", { enabled: args.enabled }),
      ),
    )
  },
})
