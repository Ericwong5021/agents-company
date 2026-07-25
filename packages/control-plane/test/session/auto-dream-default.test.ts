import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Config } from "../../src/config"
import { CompanyAgentID } from "../../src/company-agent/schema"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { shouldAutoDistill, shouldAutoDream } from "../../src/session/auto-dream"
import { SessionTable } from "../../src/session/session.sql"
import { SessionID } from "../../src/session/schema"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"

beforeEach(resetDatabase)
afterEach(resetDatabase)

test("automatic reflection workflows default off and remain readable when explicitly enabled", async () => {
  expect(await Effect.runPromise(shouldAutoDream({} as Config.Info))).toBe(false)
  expect(await Effect.runPromise(shouldAutoDream({ dream: { auto: false } } as Config.Info))).toBe(false)
  expect(await Effect.runPromise(shouldAutoDistill({} as Config.Info))).toBe(false)
  expect(await Effect.runPromise(shouldAutoDistill({ distill: { auto: false } } as Config.Info))).toBe(false)

  Database.use((db) => {
    const projectID = ProjectID.make("project-reflection-compatibility")
    const agentID = CompanyAgentID.make("assistant")
    db.insert(ProjectTable)
      .values({
        id: projectID,
        worktree: "/tmp/reflection-compatibility",
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      .run()
    db.insert(SessionTable)
      .values({
        id: SessionID.make("session-reflection-compatibility"),
        project_id: projectID,
        company_agent_id: agentID,
        slug: "reflection-compatibility",
        directory: "/tmp/reflection-compatibility",
        title: "Existing work",
        version: "1",
        time_created: 1,
        time_updated: 1,
      })
      .run()
  })

  expect(await Effect.runPromise(shouldAutoDream({ dream: { auto: true, interval_days: 0 } } as Config.Info))).toBe(
    true,
  )
  expect(await Effect.runPromise(shouldAutoDistill({ distill: { auto: true, interval_days: 0 } } as Config.Info))).toBe(
    true,
  )
})
