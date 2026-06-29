import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import { Skill } from "../../src/skill"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import type { CompanyAgentID } from "../../src/company-agent/schema"
import { agentDir, agentSkillsDir } from "../../src/session/checkpoint-paths"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { resolveFoundingRoles } from "../../src/cli/cmd/tui/routes/onboarding/founding-roles"
import { COFOUNDER_RECRUIT_SKILL } from "../../src/cli/cmd/tui/routes/onboarding/cofounder-recruit-skill"

// Only the skills we seed should be discovered.
process.env.AGENTCOMPANY_DISABLE_COMPOSE_SKILLS = "true"
process.env.AGENTCOMPANY_DISABLE_BUILTIN_SKILLS = "true"

const node = CrossSpawnSpawner.defaultLayer
const it = testEffect(Layer.mergeAll(Skill.defaultLayer, node))

describe("onboarding founding team", () => {
  // Phase 1: the opening team is the two generalist co-founders, regardless of
  // the business scope the founder picked.
  test("resolveFoundingRoles returns the two co-founders for a known scope", () => {
    const roles = resolveFoundingRoles(["saas"])
    expect(roles.map((r) => r.key).sort()).toEqual(["builder", "strategist"])
    for (const r of roles) {
      expect(r.division).toBe("specialized")
      expect(r.level).toBe("c-suite")
    }
  })

  test("co-founders are scope-independent", () => {
    const custom = resolveFoundingRoles(["some-custom-scope"]).map((r) => r.key).sort()
    expect(custom).toEqual(["builder", "strategist"])
    // The query terms must resolve the new cofounder-* templates downstream.
    const strategist = resolveFoundingRoles(["saas"]).find((r) => r.key === "strategist")!
    expect(strategist.query).toContain("联合创始人")
  })

  // Phase 2/3: seeding the recruit skill into a co-founder's private skills/
  // folder makes it discoverable by the skill system, scoped to that agent only.
  it.live("seeds and scopes the co-founder recruit skill", () => {
    const owner = "specialized-strategist-founder-test"
    const other = "engineering-cto-test"
    const skillPath = (id: string) =>
      path.join(agentSkillsDir(id as CompanyAgentID), "recruit-teammate", "SKILL.md")

    return provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          // Seed only the owner; `other` gets nothing.
          yield* Effect.promise(() => Bun.write(skillPath(owner), COFOUNDER_RECRUIT_SKILL))

          const skill = yield* Skill.Service

          const forOwner = yield* skill.available(undefined, owner)
          const forOther = yield* skill.available(undefined, other)
          const forNone = yield* skill.available(undefined)

          const named = (list: { name: string }[]) => list.some((s) => s.name === "recruit-teammate")
          // Visible to its owner, invisible to everyone else and to anon callers.
          expect(named(forOwner)).toBe(true)
          expect(named(forOther)).toBe(false)
          expect(named(forNone)).toBe(false)

          // The owner's copy carries the derived agentID.
          expect(forOwner.find((s) => s.name === "recruit-teammate")!.agentID).toBe(owner)

          // get() resolves the private skill only for its owner.
          expect(yield* skill.get("recruit-teammate", owner)).toBeDefined()
          expect(yield* skill.get("recruit-teammate", other)).toBeUndefined()
          expect(yield* skill.get("recruit-teammate")).toBeUndefined()
        }).pipe(
          // data/workspace/agents is process-global; remove the seeded dir so it can't leak
          // into other skill tests' discovery (some assert exact skill counts).
          Effect.ensuring(
            Effect.promise(() =>
              fs.rm(agentDir(owner as CompanyAgentID), { recursive: true, force: true }),
            ),
          ),
        ),
      { git: true },
    )
  })
})
