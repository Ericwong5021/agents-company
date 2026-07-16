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
})
