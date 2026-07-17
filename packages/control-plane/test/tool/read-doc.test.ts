import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config"
import { emptyConsoleState } from "../../src/config/console-state"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "../../src/tool"
import { ReadDocTool } from "../../src/tool/read-doc"
import { Tool } from "../../src/tool"
import { FrontMatter, ReadDoc, Workspace } from "../../src/workspace"
import type { OrgStructure } from "../../src/workspace/clearance"
import { addEdge, addGroupMember, clearEdges, clearGroups } from "../../src/workspace/relationships"
import { tmpdir } from "../fixture/fixture"

const org = {
  departments: {
    research: {
      clearance: "internal",
      roles: {
        analyst: { clearance: "internal" },
        owner: { clearance: "internal" },
      },
    },
    board: {
      clearance: "restricted",
      roles: {
        executive: { clearance: "restricted" },
      },
    },
  },
  agents: {
    reader: { department: "research", role: "analyst" },
    owner: { department: "research", role: "owner" },
    exec: { department: "board", role: "executive" },
  },
} satisfies OrgStructure

const configLayer = Layer.succeed(
  Config.Service,
  Config.Service.of({
    get: () => Effect.succeed({ org } as Config.Info),
    getGlobal: () => Effect.succeed({} as Config.Info),
    getConsoleState: () => Effect.succeed(emptyConsoleState),
    update: () => Effect.void,
    updateGlobal: (config) => Effect.succeed(config),
    invalidate: () => Effect.void,
    directories: () => Effect.succeed([]),
    waitForDependencies: () => Effect.void,
  }),
)

const toolLayer = Layer.mergeAll(configLayer, Agent.defaultLayer, Truncate.defaultLayer)

const ctx = (agent: string): Tool.Context => ({
  sessionID: SessionID.make("ses_read_doc"),
  messageID: MessageID.make(""),
  callID: "",
  agent,
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

function workspacePath(docPath: string) {
  return path.join(Workspace.workspaceRoot(), ...docPath.split("/"))
}

function writeDoc(docPath: string, frontMatter: Parameters<typeof FrontMatter.stringifyFrontMatter>[0], body: string) {
  return Effect.promise(async () => {
    await fs.mkdir(path.dirname(workspacePath(docPath)), { recursive: true })
    await Bun.write(workspacePath(docPath), FrontMatter.stringifyFrontMatter(frontMatter, body))
  })
}

function cleanupWorkspace(paths: string[]) {
  return Effect.promise(() =>
    Promise.all(paths.map((docPath) => fs.rm(workspacePath(docPath), { recursive: true, force: true }))),
  )
}

function readExit(agentId: string, docPath: string) {
  return ReadDoc.readDoc({ agentId, docPath, org }).pipe(Effect.exit)
}

afterEach(async () => {
  clearEdges()
  clearGroups()
  await Instance.disposeAll()
})

describe("read_doc tool", () => {
  test("enforces workspace ACL for clearance, groups, delegation, and path bounds", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const suffix = `p2-${Math.random().toString(36).slice(2)}`
            const confidential = `public/${suffix}/confidential.md`
            const groupId = `${suffix}-group`
            const groupDoc = `groups/${groupId}/brief.md`
            const privateDoc = `agents/owner-${suffix}/delegated.md`

            yield* Effect.addFinalizer(() =>
              cleanupWorkspace([`public/${suffix}`, `groups/${groupId}`, `agents/owner-${suffix}`]).pipe(Effect.ignore),
            )

            yield* writeDoc(
              confidential,
              { scope: "public", classification: "confidential", owner: "exec", updatedBy: "system" },
              "# Confidential\n\nBoosted channel readers can see this.",
            )
            yield* writeDoc(
              groupDoc,
              { scope: `group:${groupId}`, classification: "internal", owner: "exec", updatedBy: "system" },
              "# Group Brief\n\nOnly members can see this.",
            )
            yield* writeDoc(
              privateDoc,
              {
                scope: `agent:owner-${suffix}`,
                classification: "internal",
                owner: `owner-${suffix}`,
                updatedBy: "system",
              },
              "# Delegated\n\nDelegated readers can see this.",
            )

            expect(Exit.isFailure(yield* readExit("reader", confidential))).toBe(true)
            addEdge({ fromAgentId: "exec", toAgentId: "reader", kind: "channel" })
            expect((yield* ReadDoc.readDoc({ agentId: "reader", docPath: confidential, org })).content).toContain(
              "# Confidential",
            )

            expect(Exit.isFailure(yield* readExit("reader", groupDoc))).toBe(true)
            addGroupMember(groupId, "reader")
            expect((yield* ReadDoc.readDoc({ agentId: "reader", docPath: groupDoc, org })).content).toContain(
              "# Group Brief",
            )

            expect(Exit.isFailure(yield* readExit("reader", privateDoc))).toBe(true)
            addEdge({ fromAgentId: `owner-${suffix}`, toAgentId: "reader", kind: "delegation" })
            expect((yield* ReadDoc.readDoc({ agentId: "reader", docPath: privateDoc, org })).content).toContain(
              "# Delegated",
            )

            expect(Exit.isFailure(yield* readExit("reader", "../outside.md"))).toBe(true)
          }).pipe(Effect.scoped, Effect.provide(toolLayer)),
        ),
    })
  })

  test("uses configured org ACL through the tool path and emits audit events", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const suffix = `p2-tool-${Math.random().toString(36).slice(2)}`
            const internal = `public/${suffix}/internal.md`
            const confidential = `public/${suffix}/confidential.md`
            const audits: Array<{ agentId: string; docPath: string; granted: boolean; classification?: string }> = []
            const listener = (event: GlobalEvent) => {
              if (event.payload?.type !== ReadDoc.ReadDocAudit.type) return
              audits.push(event.payload.properties)
            }

            GlobalBus.on("event", listener)
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Effect.sync(() => GlobalBus.off("event", listener))
                yield* cleanupWorkspace([`public/${suffix}`])
              }).pipe(Effect.ignore),
            )

            yield* writeDoc(
              internal,
              { scope: "public", classification: "internal", owner: "exec", updatedBy: "system" },
              "# Internal\n\nBase internal readers can see this.",
            )
            yield* writeDoc(
              confidential,
              { scope: "public", classification: "confidential", owner: "exec", updatedBy: "system" },
              "# Confidential\n\nRequires boosted clearance.",
            )

            const info = yield* ReadDocTool
            const tool = yield* info.init()
            expect((yield* Config.Service.use((svc) => svc.get())).org).toMatchObject({
              agents: { reader: { department: "research", role: "analyst" } },
            })
            const allowed = yield* tool.execute({ path: internal }, ctx("reader"))
            const denied = yield* readExit("reader", confidential)

            addEdge({ fromAgentId: "exec", toAgentId: "reader", kind: "channel" })
            const boosted = yield* tool.execute({ path: confidential }, ctx("reader"))

            expect(allowed.output).toContain("# Internal")
            expect(allowed.metadata).toMatchObject({ path: internal, classification: "internal", scope: "public" })
            expect(Exit.isFailure(denied)).toBe(true)
            expect(boosted.output).toContain("# Confidential")
            expect(audits).toContainEqual({
              agentId: "reader",
              docPath: internal,
              granted: true,
              classification: "internal",
            })
            expect(audits).toContainEqual({
              agentId: "reader",
              docPath: confidential,
              granted: false,
              classification: "confidential",
            })
            expect(audits).toContainEqual({
              agentId: "reader",
              docPath: confidential,
              granted: true,
              classification: "confidential",
            })
          }).pipe(Effect.scoped, Effect.provide(toolLayer)),
        ),
    })
  })
})
