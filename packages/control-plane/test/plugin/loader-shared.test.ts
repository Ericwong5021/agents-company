import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Plugin } from "../../src/plugin"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => Instance.disposeAll())

async function load(directory: string) {
  return Instance.provide({
    directory,
    fn: async () =>
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        yield* plugin.list()
      }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
  })
}

describe("plugin.loader.shared", () => {
  test("loads a file plugin function export", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const file = path.join(directory, "plugin.ts")
        const mark = path.join(directory, "called.txt")
        await Bun.write(file, `export default async () => { await Bun.write(${JSON.stringify(mark)}, "called"); return {} }\n`)
        await Bun.write(
          path.join(directory, "agent-company.json"),
          JSON.stringify({ plugin: [pathToFileURL(file).href] }, null, 2),
        )
        return { mark }
      },
    })

    await load(tmp.path)
    expect(await fs.readFile(tmp.extra.mark, "utf8")).toBe("called")
  })

  test("loads a v1 server plugin object", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const file = path.join(directory, "plugin.ts")
        const mark = path.join(directory, "called.txt")
        await Bun.write(
          file,
          `export default { id: "demo", server: async () => { await Bun.write(${JSON.stringify(mark)}, "server"); return {} } }\n`,
        )
        await Bun.write(
          path.join(directory, "agent-company.json"),
          JSON.stringify({ plugin: [pathToFileURL(file).href] }, null, 2),
        )
        return { mark }
      },
    })

    await load(tmp.path)
    expect(await fs.readFile(tmp.extra.mark, "utf8")).toBe("server")
  })

  test("skips an invalid server plugin without executing it", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const file = path.join(directory, "plugin.ts")
        await Bun.write(file, "export default { id: 'invalid', server: true }\n")
        await Bun.write(
          path.join(directory, "agent-company.json"),
          JSON.stringify({ plugin: [pathToFileURL(file).href] }, null, 2),
        )
      },
    })

    await expect(load(tmp.path)).resolves.toBeUndefined()
  })
})
