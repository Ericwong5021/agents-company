import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { createPlugTask, type PlugCtx, type PlugDeps } from "../../src/cli/cmd/plug"
import { Filesystem } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

function deps(global: string, target: string | Error): PlugDeps {
  return {
    spinner: () => ({ start() {}, stop() {} }),
    log: { error() {}, info() {}, success() {} },
    resolve: async () => {
      if (target instanceof Error) throw target
      return target
    },
    readText: (file) => Filesystem.readText(file),
    write: async (file, text) => Filesystem.write(file, text),
    exists: (file) => Filesystem.exists(file),
    files: (dir, name) => [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)],
    global,
  }
}

function context(directory: string): PlugCtx {
  return { vcs: "git", worktree: directory, directory }
}

async function plugin(directory: string, options?: Record<string, unknown>) {
  const target = path.join(directory, "plugin")
  await fs.mkdir(target, { recursive: true })
  await Bun.write(
    path.join(target, "package.json"),
    JSON.stringify(
      {
        name: "acme",
        version: "1.0.0",
        exports: {
          "./server": options
            ? { import: "./server.js", config: options }
            : "./server.js",
        },
      },
      null,
      2,
    ),
  )
  await Bun.write(path.join(target, "server.js"), "export default async () => ({})\n")
  return target
}

describe("plugin.install.task", () => {
  test("writes a server plugin with export options", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, { mode: "safe" })
    const run = createPlugTask({ mod: "acme@1.2.3" }, deps(path.join(tmp.path, "global"), target))

    expect(await run(context(tmp.path))).toBe(true)
    expect(
      await Filesystem.readJson<{ plugin: unknown[] }>(
        path.join(tmp.path, ".agentcompany", "agent-company.jsonc"),
      ),
    ).toEqual({ plugin: [["acme@1.2.3", { mode: "safe" }]] })
  })

  test("preserves JSONC comments and replaces versions only with force", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path)
    const config = path.join(tmp.path, ".agentcompany", "agent-company.jsonc")
    await fs.mkdir(path.dirname(config), { recursive: true })
    await Bun.write(
      config,
      `{
  // keep this comment
  "plugin": ["acme@1.0.0", "other@1.0.0"]
}
`,
    )

    expect(await createPlugTask({ mod: "acme@2.0.0" }, deps(tmp.path, target))(context(tmp.path))).toBe(true)
    expect(parseJsonc(await Bun.file(config).text()).plugin).toEqual(["acme@1.0.0", "other@1.0.0"])

    expect(
      await createPlugTask({ mod: "acme@2.0.0", force: true }, deps(tmp.path, target))(context(tmp.path)),
    ).toBe(true)
    const text = await Bun.file(config).text()
    expect(text).toContain("// keep this comment")
    expect(parseJsonc(text).plugin).toEqual(["acme@2.0.0", "other@1.0.0"])
  })

  test("rejects packages without a server entrypoint", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "plugin")
    await fs.mkdir(target, { recursive: true })
    await Bun.write(path.join(target, "package.json"), JSON.stringify({ name: "acme", version: "1.0.0" }))

    expect(await createPlugTask({ mod: "acme" }, deps(tmp.path, target))(context(tmp.path))).toBe(false)
    expect(await Filesystem.exists(path.join(tmp.path, ".agentcompany", "agent-company.jsonc"))).toBe(false)
  })

  test("does not change config when installation fails", async () => {
    await using tmp = await tmpdir()
    expect(
      await createPlugTask({ mod: "missing" }, deps(tmp.path, new Error("install failed")))(context(tmp.path)),
    ).toBe(false)
    expect(await Filesystem.exists(path.join(tmp.path, ".agentcompany", "agent-company.jsonc"))).toBe(false)
  })
})
