import type { Argv } from "yargs"
import path from "path"
import { rename, rm } from "fs/promises"
import { Flock } from "@agents-company/shared/util/flock"
import { Global } from "../../global"
import { Filesystem } from "../../util"
import { cmd } from "./cmd"
import { runJsonCommand } from "../output"

const filePath = path.join(Global.Path.state, "kv.json")
const lock = `tui-kv:${filePath}`

export const SettingsCommand = cmd({
  command: "settings",
  describe: "manage persisted TUI settings",
  builder: (yargs: Argv) =>
    yargs
      .command(SettingsListCommand)
      .command(SettingsGetCommand)
      .command(SettingsSetCommand)
      .command(SettingsDeleteCommand)
      .demandCommand(),
  async handler() {},
})

const SettingsListCommand = cmd({
  command: "list",
  describe: "list settings",
  async handler(args) {
    await runJsonCommand(args, "settings.list", () => readStore())
  },
})

const SettingsGetCommand = cmd({
  command: "get <key>",
  describe: "get a setting",
  builder: (yargs: Argv) =>
    yargs.positional("key", {
      describe: "setting key",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "settings.get", async () => (await readStore())[args.key])
  },
})

const SettingsSetCommand = cmd({
  command: "set <key> <value>",
  describe: "set a setting",
  builder: (yargs: Argv) =>
    yargs
      .positional("key", {
        describe: "setting key",
        type: "string",
        demandOption: true,
      })
      .positional("value", {
        describe: "setting value",
        type: "string",
        demandOption: true,
      })
      .option("string", {
        describe: "store value as a string instead of parsing JSON",
        type: "boolean",
        default: false,
      }),
  async handler(args) {
    await runJsonCommand(args, "settings.set", async () => {
      const store = await readStore()
      const next = {
        ...store,
        [args.key]: args.string ? args.value : parseValue(args.value),
      }
      await writeStore(next)
      return next[args.key]
    })
  },
})

const SettingsDeleteCommand = cmd({
  command: "delete <key>",
  describe: "delete a setting",
  builder: (yargs: Argv) =>
    yargs.positional("key", {
      describe: "setting key",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await runJsonCommand(args, "settings.delete", async () => {
      const store = await readStore()
      const next = { ...store }
      delete next[args.key]
      await writeStore(next)
      return true
    })
  },
})

async function readStore() {
  return Flock.withLock(lock, async () => {
    if (!(await Filesystem.exists(filePath))) return {} as Record<string, unknown>
    return Filesystem.readJson<Record<string, unknown>>(filePath)
  })
}

async function writeStore(store: Record<string, unknown>) {
  return Flock.withLock(lock, async () => {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    return Filesystem.writeJson(tempPath, store)
      .then(() => rename(tempPath, filePath))
      .catch(async (error) => {
        await rm(tempPath, { force: true }).catch(() => undefined)
        throw error
      })
  })
}

function parseValue(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}
