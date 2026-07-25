import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import fs from "fs/promises"
import path from "node:path"
import { CompanyAgent } from "../../src/company-agent/company-agent"
import { CompanyAgentID } from "../../src/company-agent/schema"
import { Instance } from "../../src/project/instance"
import {
  agentDir,
  agentHomeLegacyMigrationPaths,
  agentInstructPath,
  agentKanbanPath,
  agentMemoryDir,
  agentPublicProfilePath,
  agentRelationshipsPath,
  agentSettingsPath,
  agentSkillsDir,
  agentSoulPath,
  companyAgentMemoryPath,
  migrateAgentHome,
} from "../../src/session/checkpoint-paths"
import { Log } from "../../src/util"
import { FrontMatter } from "../../src/workspace"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A>(fn: (svc: CompanyAgent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(CompanyAgent.Service.use(fn).pipe(Effect.provide(CompanyAgent.defaultLayer)))
}

function exists(filePath: string) {
  return fs.stat(filePath).then(
    () => true,
    () => false,
  )
}

async function readFrontMatter(filePath: string) {
  return FrontMatter.parseFrontMatter(await Bun.file(filePath).text()).frontMatter
}

async function treeEntries(root: string, current = root): Promise<[string, string][]> {
  if ((await fs.stat(current)).isFile())
    return [[path.relative(root, current) || ".", await fs.readFile(current, "base64")]]
  return (
    await Promise.all((await fs.readdir(current)).sort().map((entry) => treeEntries(root, path.join(current, entry))))
  ).flat()
}

async function treeHash(root: string) {
  return createHash("sha256")
    .update(JSON.stringify(await treeEntries(root)))
    .digest("hex")
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("company agent file bundle", () => {
  test("migrates the complete legacy bundle without changing content hashes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agentID = CompanyAgentID.make("legacy-bundle-agent")
        const migration = agentHomeLegacyMigrationPaths(agentID)
        const legacyDirectories = new Set(["skills", "memory", "projects"])

        await Promise.all(
          migration.map(async (entry, index) => {
            await fs.mkdir(path.dirname(entry.legacy), { recursive: true })
            if (!legacyDirectories.has(path.basename(entry.legacy))) {
              await fs.writeFile(entry.legacy, `legacy-file-${index}`)
              return
            }
            await fs.mkdir(entry.legacy, { recursive: true })
            await fs.writeFile(path.join(entry.legacy, "legacy.txt"), `legacy-directory-${index}`)
          }),
        )
        const before = Object.fromEntries(
          await Promise.all(migration.map(async (entry) => [entry.target, await treeHash(entry.legacy)] as const)),
        )

        await migrateAgentHome(agentID)

        expect(
          Object.fromEntries(
            await Promise.all(migration.map(async (entry) => [entry.target, await treeHash(entry.target)] as const)),
          ),
        ).toEqual(before)
        expect(await Promise.all(migration.map((entry) => exists(entry.legacy)))).toEqual(migration.map(() => false))

        await migrateAgentHome(agentID)
        expect(
          Object.fromEntries(
            await Promise.all(migration.map(async (entry) => [entry.target, await treeHash(entry.target)] as const)),
          ),
        ).toEqual(before)
      },
    })
  })

  test("creates, reads, updates, and repairs the persistent agent bundle", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await run((svc) =>
          svc.create({
            id: "bundle-agent",
            name: "Bundle Agent",
            org_layer: "execution",
            department: "engineering",
            reports_to: "project-lead",
            responsibilities: ["Deliver tested product slices"],
            model: "openai/gpt-5",
          }),
        )

        expect(await exists(agentSoulPath(created.id))).toBe(true)
        expect(await exists(agentInstructPath(created.id))).toBe(true)
        expect(await exists(agentRelationshipsPath(created.id))).toBe(true)
        expect(await exists(agentKanbanPath(created.id))).toBe(true)
        expect(await exists(companyAgentMemoryPath(created.id))).toBe(true)
        expect(await exists(agentSettingsPath(created.id))).toBe(true)
        expect(await exists(agentSkillsDir(created.id))).toBe(true)
        expect(await exists(agentMemoryDir(created.id))).toBe(true)
        expect(await readFrontMatter(agentSoulPath(created.id))).toMatchObject({
          scope: `agent:${created.id}`,
          classification: "internal",
          type: "soul",
          org_layer: "execution",
          department: "engineering",
          reports_to: "project-lead",
          responsibilities: "Deliver tested product slices",
        })

        await Bun.write(agentSoulPath(created.id), "# Edited Soul\n")
        await Bun.write(agentInstructPath(created.id), "# Edited Instructions\n")

        const fromFiles = await run((svc) => svc.get(created.id))
        expect(fromFiles?.system_prompt).toBe("# Edited Soul")
        expect(fromFiles?.instruct).toBe("# Edited Instructions")
        expect(fromFiles?.model).toBe("openai/gpt-5")
        expect(await readFrontMatter(agentSoulPath(created.id))).toMatchObject({
          org_layer: "execution",
          department: "engineering",
          reports_to: "project-lead",
        })

        await run((svc) =>
          svc.update({
            id: created.id,
            relationships: "# Relationships\n\n- Works closely with QA.",
            kanban: "# Kanban\n\n## In Progress\n\n- P1 file bundle",
            model: "",
          }),
        )

        expect(await Bun.file(agentRelationshipsPath(created.id)).text()).toContain("Works closely with QA")
        expect(await Bun.file(agentKanbanPath(created.id)).text()).toContain("P1 file bundle")
        expect(await Bun.file(agentSettingsPath(created.id)).text()).toBe("{}\n")

        await fs.rm(agentRelationshipsPath(created.id))
        await fs.rm(agentSkillsDir(created.id), { recursive: true, force: true })
        await fs.rm(agentMemoryDir(created.id), { recursive: true, force: true })

        const repaired = await run((svc) => svc.get(created.id))
        expect(repaired?.id).toBe(created.id)
        expect(await exists(agentRelationshipsPath(created.id))).toBe(true)
        expect(await exists(agentSkillsDir(created.id))).toBe(true)
        expect(await exists(agentMemoryDir(created.id))).toBe(true)
        expect(await exists(agentDir(created.id))).toBe(true)
      },
    })
  })

  test("refreshes public organization facts without overwriting the agent profile", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await run((svc) =>
          svc.create({
            id: "promotion-candidate",
            name: "Promotion Candidate",
            description: "Evidence-backed delivery specialist.",
            system_prompt: "# Private Soul",
            instruct: "# Private Instructions",
          }),
        )
        await Bun.write(
          agentPublicProfilePath(created.id),
          [
            "# Promotion Candidate",
            "",
            "Agent-authored public summary.",
            "",
            "## Public Role",
            "",
            "- Organization layer: execution",
            "- Department: Unassigned",
            "- Responsibilities: To be assigned",
            "",
            "## Highlights",
            "",
            "- Preserved across organization updates.",
            "",
          ].join("\n"),
        )

        expect((await run((svc) => svc.promote(created.id))).lifecycle).toBe("employee")
        const updated = await run((svc) => svc.update({ id: created.id, department: "delivery-assurance" }))

        expect(updated.public_profile).toContain("Agent-authored public summary.")
        expect(updated.public_profile).toContain("## Highlights")
        expect(updated.public_profile).toContain("- Department: delivery-assurance")
        expect(updated.public_profile).not.toContain("- Department: Unassigned")
      },
    })
  })
})
