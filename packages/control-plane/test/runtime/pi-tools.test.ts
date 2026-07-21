import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPiTools } from "../../src/runtime/pi/tools"
import type { AgentRunSpec } from "../../src/runtime"

const directories: string[] = []

async function workspace(permissionMode: AgentRunSpec["permissionMode"]) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentcompany-pi-tools-"))
  directories.push(cwd)
  return {
    cwd,
    spec: {
      runID: "run-tools",
      agentID: "engineer",
      runtime: "pi",
      lifecycle: "on_demand",
      permissionMode,
      cwd,
      runtimeHome: cwd,
      prompt: "work",
      systemPrompt: "",
      capabilityPacks: [],
      requiredRuntimeCapabilities: [],
    } satisfies AgentRunSpec,
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("Pi governed tools", () => {
  test("rejects path escape before reading", async () => {
    const input = await workspace("read_only")
    const read = createPiTools(input.spec, ["read"]).find((tool) => tool.name === "read")!

    await expect(read.execute("call-1", { path: "../secret.txt" }, new AbortController().signal)).rejects.toThrow(
      "outside the authorized workspace",
    )
  })

  test("does not expose write tools in read-only mode", async () => {
    const input = await workspace("read_only")

    expect(createPiTools(input.spec, ["read", "write", "edit"]).map((tool) => tool.name)).toEqual(["read"])
  })

  test("loads a skill only through an explicit tool call", async () => {
    const input = await workspace("read_only")
    const tools = createPiTools(input.spec, [], { loadSkill: async (name) => `loaded:${name}` })
    const skill = tools.find((tool) => tool.name === "skill")!

    expect(tools.map((tool) => tool.name)).toEqual(["skill"])
    await expect(skill.execute("call-skill", { name: "release-review" }, new AbortController().signal)).resolves.toMatchObject({
      content: [{ text: "loaded:release-review" }],
    })
  })

  test("exposes governance publishing only for an opted-in conversation run", async () => {
    const input = await workspace("read_only")

    expect(createPiTools(input.spec, []).map((tool) => tool.name)).not.toContain("publish_signal")
    const signal = createPiTools(input.spec, [], { publishSignal: true }).find((tool) => tool.name === "publish_signal")!
    await expect(
      signal.execute(
        "call-signal",
        { signal_type: "risk", body: "Payment verification remains incomplete." },
        new AbortController().signal,
      ),
    ).resolves.toBeDefined()
  })

  test("writes inside the authorized workspace", async () => {
    const input = await workspace("workspace_write")
    const write = createPiTools(input.spec, ["write"]).find((tool) => tool.name === "write")!

    await write.execute("call-2", { path: "src/result.txt", content: "ok\n" }, new AbortController().signal)

    expect(await Bun.file(path.join(input.cwd, "src/result.txt")).text()).toBe("ok\n")
  })

  test("rejects command flags that can spawn another executable", async () => {
    const input = await workspace("read_only")
    const bash = createPiTools(input.spec, ["bash"]).find((tool) => tool.name === "bash")!

    await expect(
      bash.execute("call-3", { command: "rg", args: ["--pre=malicious", "needle"] }, new AbortController().signal),
    ).rejects.toThrow("not allowed")
  })

  test("accepts a simple embedded command emitted by the local model", async () => {
    const input = await workspace("read_only")
    const bash = createPiTools(input.spec, ["bash"]).find((tool) => tool.name === "bash")!

    await expect(
      bash.execute("call-4", { command: "bun test", args: [] }, new AbortController().signal),
    ).resolves.toBeDefined()
  })

  test("allows bun install only for workspace-write implementation runs", async () => {
    const readOnly = await workspace("read_only")
    const readOnlyBash = createPiTools(readOnly.spec, ["bash"]).find((tool) => tool.name === "bash")!
    await expect(
      readOnlyBash.execute("call-5", { command: "bun install", args: [] }, new AbortController().signal),
    ).rejects.toThrow("not allowed")

    const writable = await workspace("workspace_write")
    await Bun.write(path.join(writable.cwd, "package.json"), '{"name":"pi-install-test","private":true}\n')
    const writableBash = createPiTools(writable.spec, ["bash"]).find((tool) => tool.name === "bash")!

    await expect(
      writableBash.execute("call-6", { command: "bun install", args: [] }, new AbortController().signal),
    ).resolves.toBeDefined()
  })

  test("terminates a timed-out command together with descendants holding output pipes", async () => {
    const input = await workspace("workspace_write")
    await Bun.write(
      path.join(input.cwd, "package.json"),
      '{"name":"pi-timeout-test","private":true,"scripts":{"dev":"bun -e \\"setInterval(() => {}, 1000)\\""}}\n',
    )
    const bash = createPiTools(input.spec, ["bash"]).find((tool) => tool.name === "bash")!

    await expect(
      bash.execute(
        "call-7",
        { command: "bun", args: ["run", "dev"], timeoutMs: 100 },
        new AbortController().signal,
      ),
    ).resolves.toBeDefined()
  })
})
