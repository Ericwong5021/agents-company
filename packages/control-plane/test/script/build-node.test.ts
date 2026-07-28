import { describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dir, "../..")

describe("build-node", () => {
  test("emits a Node-importable headless server", async () => {
    const build = Bun.spawnSync({
      cmd: ["bun", "script/build-node.ts"],
      cwd: root,
      env: {
        ...process.env,
        AGENTCOMPANY_DISABLE_MODELS_FETCH: "true",
        MODELS_DEV_API_JSON: path.join(import.meta.dir, "../tool/fixtures/models-api.json"),
      },
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
        "import('./dist/node/node.js').then(async m => { const health = await m.Server.Default().app.request('/global/health'); if (health.status !== 200) process.exit(2); const root = await m.Server.Default().app.request('/'); if (root.status !== 404) process.exit(3); process.exit(0) })",
      ],
      cwd: root,
      env: { ...process.env, AGENTCOMPANY_HOME: home.path },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(probe.exitCode).toBe(0)
  }, 120_000)
})
