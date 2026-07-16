import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { queryString, withLocalApi } from "../local-api"
import { runJsonCommand } from "../output"

function values(input: string | string[] | undefined) {
  if (input === undefined) return undefined
  return Array.isArray(input) ? input : [input]
}

function body(args: {
  id?: string
  name?: string
  description?: string
  systemPrompt?: string
  instruct?: string
  model?: string
  color?: string
  icon?: string
  orgLayer?: string
  department?: string
  reportsTo?: string
  responsibility?: string | string[]
}) {
  return {
    ...(args.id ? { id: args.id } : {}),
    ...(args.name ? { name: args.name } : {}),
    ...(args.description ? { description: args.description } : {}),
    ...(args.systemPrompt ? { system_prompt: args.systemPrompt } : {}),
    ...(args.instruct ? { instruct: args.instruct } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.color ? { color: args.color } : {}),
    ...(args.icon ? { icon: args.icon } : {}),
    ...(args.orgLayer ? { org_layer: args.orgLayer } : {}),
    ...(args.department ? { department: args.department } : {}),
    ...(args.reportsTo ? { reports_to: args.reportsTo } : {}),
    ...(args.responsibility ? { responsibilities: values(args.responsibility) } : {}),
  }
}

function editOptions(yargs: Argv) {
  return yargs
    .option("name", { type: "string", describe: "agent display name" })
    .option("description", { type: "string", describe: "agent description" })
    .option("system-prompt", { type: "string", describe: "system prompt" })
    .option("instruct", { type: "string", describe: "instruction text" })
    .option("model", { type: "string", describe: "model in provider/model format" })
    .option("color", { type: "string", describe: "agent color" })
    .option("icon", { type: "string", describe: "agent icon" })
    .option("org-layer", {
      type: "string",
      describe: "organization layer",
      choices: ["board", "department", "project", "execution", "tool"] as const,
    })
    .option("department", { type: "string", describe: "department name" })
    .option("reports-to", { type: "string", describe: "manager agent id" })
    .option("responsibility", {
      type: "string",
      array: true,
      describe: "agent responsibility; can be repeated",
    })
}

export const CompanyAgentCommand = cmd({
  command: "company-agent",
  describe: "manage company agents",
  builder: (yargs: Argv) =>
    yargs
      .command(CompanyAgentListCommand)
      .command(CompanyAgentGetCommand)
      .command(CompanyAgentCreateCommand)
      .command(CompanyAgentUpdateCommand)
      .command(CompanyAgentDeleteCommand)
      .command(CompanyAgentTemplatesCommand)
      .command(CompanyAgentSearchCommand)
      .demandCommand(),
  async handler() {},
})

const CompanyAgentListCommand = cmd({
  command: "list",
  describe: "list company agents",
  async handler(args) {
    await runJsonCommand(args, "company-agent.list", () =>
      withLocalApi((json) => json<unknown[]>("GET", "/company-agent")),
    )
  },
})

const CompanyAgentGetCommand = cmd({
  command: "get <id>",
  describe: "get a company agent",
  builder: (yargs: Argv) =>
    yargs.positional("id", {
      describe: "company agent ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "company-agent.get", () =>
      withLocalApi((json) => json<unknown>("GET", `/company-agent/${encodeURIComponent(args.id)}`)),
    )
  },
})

const CompanyAgentCreateCommand = cmd({
  command: "create <id> <name>",
  describe: "create a company agent",
  builder: (yargs: Argv) =>
    editOptions(
      yargs
        .positional("id", {
          describe: "company agent ID",
          type: "string",
          demandOption: true,
        })
        .positional("name", {
          describe: "company agent name",
          type: "string",
          demandOption: true,
        }),
    ),
  async handler(args) {
    await runJsonCommand(args, "company-agent.create", () =>
      withLocalApi((json) => json<unknown>("POST", "/company-agent", body(args))),
    )
  },
})

const CompanyAgentUpdateCommand = cmd({
  command: "update <id>",
  describe: "update a company agent",
  builder: (yargs: Argv) =>
    editOptions(
      yargs.positional("id", {
        describe: "company agent ID",
        type: "string",
        demandOption: true,
      }),
    ),
  async handler(args) {
    await runJsonCommand(args, "company-agent.update", () =>
      withLocalApi((json) => json<unknown>("PATCH", `/company-agent/${encodeURIComponent(String(args.id))}`, body(args))),
    )
  },
})

const CompanyAgentDeleteCommand = cmd({
  command: "delete <id>",
  describe: "delete a company agent",
  builder: (yargs: Argv) =>
    yargs.positional("id", {
      describe: "company agent ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "company-agent.delete", () =>
      withLocalApi((json) => json<boolean>("DELETE", `/company-agent/${encodeURIComponent(args.id)}`)),
    )
  },
})

const CompanyAgentTemplatesCommand = cmd({
  command: "templates [division] [slug]",
  describe: "list or get company agent templates",
  builder: (yargs: Argv) =>
    yargs
      .positional("division", {
        describe: "template division",
        type: "string",
      })
      .positional("slug", {
        describe: "template slug",
        type: "string",
      }),
  async handler(args) {
    await runJsonCommand(args, "company-agent.templates", () =>
      withLocalApi((json) =>
        json<unknown>(
          "GET",
          args.division
            ? `/company-agent/templates/${encodeURIComponent(args.division)}${args.slug ? `/${encodeURIComponent(args.slug)}` : ""}`
            : "/company-agent/templates",
        ),
      ),
    )
  },
})

const CompanyAgentSearchCommand = cmd({
  command: "search [query]",
  describe: "search company agent templates",
  builder: (yargs: Argv) =>
    yargs
      .positional("query", {
        describe: "search query",
        type: "string",
      })
      .option("division", {
        describe: "template division",
        type: "string",
      })
      .option("limit", {
        describe: "maximum number of templates",
        type: "number",
        default: 50,
      }),
  async handler(args) {
    await runJsonCommand(args, "company-agent.search", () =>
      withLocalApi((json) =>
        json<unknown[]>(
          "GET",
          `/company-agent/templates/search${queryString({
            q: args.query ?? "",
            division: args.division,
            limit: args.limit,
          })}`,
        ),
      ),
    )
  },
})
