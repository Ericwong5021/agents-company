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
  test("always exposes the minimum read-only workspace tools", async () => {
    const input = await workspace("read_only")

    expect(createPiTools(input.spec, []).map((tool) => tool.name)).toEqual(["read", "glob", "grep"])
  })

  test("reads an ACL-authorized company document outside the repository cwd", async () => {
    const input = await workspace("read_only")
    const readDoc = createPiTools(input.spec, [], {
      readDoc: async (docPath) => ({ content: `content:${docPath}`, classification: "public" }),
    }).find((tool) => tool.name === "read_doc")!

    await expect(
      readDoc.execute("call-doc", { path: "public/board/projects.md" }, new AbortController().signal),
    ).resolves.toMatchObject({ content: [{ text: "content:public/board/projects.md" }] })
  })

  test("reads live company project counts instead of relying on the Markdown board", async () => {
    const input = await workspace("read_only")
    const projects = createPiTools(input.spec, [], {
      listCompanyProjects: async () => [
        { id: "project-1", title: "One", goal: "Ship one", status: "executing", updated_at: 1 },
        { id: "project-2", title: "Two", goal: "Ship two", status: "executing", updated_at: 2 },
        { id: "project-3", title: "Three", goal: "Ship three", status: "planning", updated_at: 3 },
      ],
    }).find((tool) => tool.name === "list_company_projects")!

    await expect(projects.execute("call-projects", {}, new AbortController().signal)).resolves.toMatchObject({
      content: [
        {
          text: expect.stringContaining('"executing": 2'),
        },
      ],
    })
  })

  test("rejects path escape before reading", async () => {
    const input = await workspace("read_only")
    const read = createPiTools(input.spec, ["read"]).find((tool) => tool.name === "read")!

    await expect(read.execute("call-1", { path: "../secret.txt" }, new AbortController().signal)).rejects.toThrow(
      "outside the authorized workspace",
    )
  })

  test("does not expose write tools in read-only mode", async () => {
    const input = await workspace("read_only")

    expect(createPiTools(input.spec, ["read", "write", "edit"]).map((tool) => tool.name)).toEqual([
      "read",
      "glob",
      "grep",
    ])
  })

  test("loads a skill only through an explicit tool call", async () => {
    const input = await workspace("read_only")
    const tools = createPiTools(input.spec, [], { loadSkill: async (name) => `loaded:${name}` })
    const skill = tools.find((tool) => tool.name === "skill")!

    expect(tools.map((tool) => tool.name)).toEqual(["read", "glob", "grep", "skill"])
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
        { signal_type: "plan", body: "Validate the core user path before expanding scope." },
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

  test("allows unrestricted non-shell commands only in full-access mode", async () => {
    const balanced = await workspace("workspace_write")
    const balancedBash = createPiTools(balanced.spec, ["bash"]).find((tool) => tool.name === "bash")!
    await expect(
      balancedBash.execute(
        "call-balanced-command",
        { command: "bun", args: ["-e", "process.stdout.write('blocked')"] },
        new AbortController().signal,
      ),
    ).rejects.toThrow("not allowed")

    const autonomous = await workspace("full_access")
    const autonomousBash = createPiTools(autonomous.spec, ["bash"]).find((tool) => tool.name === "bash")!
    await expect(
      autonomousBash.execute(
        "call-autonomous-command",
        { command: "bun", args: ["-e", "process.stdout.write('allowed')"] },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ content: [{ text: "allowed\nexit code: 0" }] })
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
