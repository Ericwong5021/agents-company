import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { CompanyAgent } from "../../src/company-agent/company-agent"
import type { CompanyAgentID } from "../../src/company-agent/schema"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { agentDir, agentSoulPath } from "../../src/session/checkpoint-paths"
import { ContextResolver, FrontMatter, ReadDoc, Workspace } from "../../src/workspace"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function exists(filePath: string) {
  return fs.stat(filePath).then(
    () => true,
    () => false,
  )
}

function slash(filePath: string) {
  return filePath.replaceAll("\\", "/")
}

async function readFrontMatter(filePath: string) {
  return FrontMatter.parseFrontMatter(await Bun.file(filePath).text()).frontMatter
}

function runAgent<A>(fn: (svc: CompanyAgent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(CompanyAgent.Service.use(fn).pipe(Effect.provide(CompanyAgent.defaultLayer)))
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("workspace org context", () => {
  test("bootstraps the three-layer tree with front-matter and scoped agent bundles", async () => {
    const agentID = "workspace-p2-agent" as CompanyAgentID
    const otherID = "workspace-p2-other" as CompanyAgentID
    const groupDir = path.join(Workspace.workspaceRoot(), "groups", "p2-workspace-test")
    const legacyProfile = path.join(Workspace.workspaceRoot(), "public", "org", "profiles", "legacy-p2-profile.md")
    const invalidClassificationDoc = path.join(Workspace.workspaceRoot(), "public", "policy", "invalid-classification-p2.md")

    await fs.rm(agentDir(agentID), { recursive: true, force: true })
    await fs.rm(agentDir(otherID), { recursive: true, force: true })
    await fs.rm(groupDir, { recursive: true, force: true })
    await fs.rm(legacyProfile, { force: true })
    await fs.rm(invalidClassificationDoc, { force: true })

    await using tmp = await tmpdir({ git: true })
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(Workspace.workspaceRoot()).toBe(path.join(Global.Path.data, "workspace"))
          expect(await exists(path.join(Workspace.workspaceRoot(), "public", "org", "profiles"))).toBe(true)
          expect(await exists(path.join(Workspace.workspaceRoot(), "groups"))).toBe(true)
          expect(await exists(path.join(Workspace.workspaceRoot(), "agents"))).toBe(true)

          expect(await readFrontMatter(path.join(Workspace.workspaceRoot(), "public", "org", "structure.md"))).toMatchObject({
            scope: "public",
            classification: "internal",
            owner: "system",
            updatedBy: "system",
          })
          expect(await readFrontMatter(path.join(Workspace.workspaceRoot(), "public", "policy", "safety-redlines.md"))).toMatchObject({
            scope: "public",
            classification: "internal",
            owner: "system",
            updatedBy: "system",
          })

          await Bun.write(
            legacyProfile,
            "---\nscope: org\nclassification: internal\nowner: legacy-p2-profile\n---\n\n# Legacy Profile\n",
          )
          await Workspace.generateAgentProfile("legacy-p2-profile", "Legacy P2 Profile", "agent", "engineering", [])
          expect(await readFrontMatter(legacyProfile)).toMatchObject({
            scope: "public",
            classification: "internal",
            owner: "legacy-p2-profile",
            updatedBy: "system",
          })
          expect(await Bun.file(legacyProfile).text()).toContain("# Legacy Profile")

          const created = await runAgent((svc) =>
            svc.create({
              id: agentID,
              name: "Workspace P2 Agent",
              system_prompt: "# Workspace P2 Agent\n\nPrivate identity.",
            }),
          )

          await runAgent((svc) =>
            svc.create({
              id: otherID,
              name: "Workspace P2 Other",
              system_prompt: "# Workspace P2 Other\n\nPrivate identity.",
            }),
          )

          expect(agentDir(created.id)).toBe(path.join(Workspace.workspaceRoot(), "agents", agentID))
          expect(await readFrontMatter(agentSoulPath(created.id))).toMatchObject({
            scope: `agent:${agentID}`,
            classification: "internal",
            owner: agentID,
            updatedBy: "system",
            type: "soul",
          })

          const fromFiles = await runAgent((svc) => svc.get(agentID))
          expect(fromFiles?.system_prompt).toBe("# Workspace P2 Agent\n\nPrivate identity.")

          await fs.mkdir(groupDir, { recursive: true })
          await Bun.write(
            path.join(groupDir, "brief.md"),
            FrontMatter.stringifyFrontMatter(
              { scope: "group:p2-workspace-test", classification: "internal", owner: "system", updatedBy: "system" },
              "# Group Brief\n\nOnly group members should see this.",
            ),
          )
          await Bun.write(
            invalidClassificationDoc,
            FrontMatter.stringifyFrontMatter(
              { scope: "public", classification: "secret", owner: "system", updatedBy: "system" },
              "# Invalid Classification\n\nThis should fail closed.",
            ),
          )

          const resolved = await Effect.runPromise(ContextResolver.resolve(agentID))
          const visible = resolved.visibleDocs.map((doc) => slash(doc.path))

          expect(visible).toContain("public/org/structure.md")
          expect(visible).toContain(`agents/${agentID}/private/SOUL.md`)
          expect(visible).not.toContain(`agents/${otherID}/private/SOUL.md`)
          expect(visible).not.toContain("groups/p2-workspace-test/brief.md")
          expect(visible).not.toContain("public/board/strategy.md")
          expect(visible).not.toContain("public/policy/invalid-classification-p2.md")
          expect(resolved.standingSummary).toContain("`public/org/structure.md`")
          expect(resolved.standingSummary).not.toContain("- `org/structure.md`")

          expect(
            await Effect.runPromise(
              ReadDoc.readDoc({
                agentId: agentID,
                docPath: `agents/${agentID}/private/SOUL.md`,
              }),
            ),
          ).toMatchObject({ granted: true })

          const denied = await Effect.runPromise(
            ReadDoc.readDoc({
              agentId: agentID,
              docPath: `agents/${otherID}/private/SOUL.md`,
            }).pipe(Effect.exit),
          )
          expect(denied._tag).toBe("Failure")

          const invalid = await Effect.runPromise(
            ReadDoc.readDoc({
              agentId: agentID,
              docPath: "public/policy/invalid-classification-p2.md",
            }).pipe(Effect.exit),
          )
          expect(invalid._tag).toBe("Failure")
        },
      })
    } finally {
      await fs.rm(agentDir(agentID), { recursive: true, force: true })
      await fs.rm(agentDir(otherID), { recursive: true, force: true })
      await fs.rm(groupDir, { recursive: true, force: true })
      await fs.rm(legacyProfile, { force: true })
      await fs.rm(invalidClassificationDoc, { force: true })
    }
  })
})
