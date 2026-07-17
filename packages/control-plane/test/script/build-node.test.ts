import { describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dir, "../..")

describe("build-node", () => {
  test("emits a Node-importable server and embedded index", async () => {
    const build = Bun.spawnSync({
      cmd: ["bun", "script/build-node.ts"],
      cwd: root,
      env: { ...process.env, AGENTCOMPANY_DISABLE_MODELS_FETCH: "true" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(build.exitCode).toBe(0)

    await using home = await tmpdir()
    const probe = Bun.spawnSync({
      cmd: [
        "node",
        "--input-type=module",
        "-e",
        "import('./dist/node/node.js').then(async m => { const r = await m.Server.Default().app.request('/'); if (r.status !== 200) process.exit(2); if (!r.headers.get('content-security-policy')?.includes(\"object-src 'none'\")) process.exit(3) })",
      ],
      cwd: root,
      env: { ...process.env, AGENTCOMPANY_HOME: home.path },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(probe.exitCode).toBe(0)
  }, 120_000)
})
