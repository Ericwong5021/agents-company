import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CompanyTable, RepositoryBindingTable } from "../../src/company/company.sql"
import { CompanyID } from "../../src/company/schema"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Server } from "../../src/server/server"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await resetDatabase()
})

describe.serial("instance directory access", () => {
  test.serial("allows only the bound company repository outside the server working directory", async () => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-bound-repository-"))
    await fs.mkdir(path.join(external, "repository"))
    const repository = await fs.realpath(path.join(external, "repository"))
    const nested = path.join(repository, "packages", "app")
    const sibling = path.join(external, "sibling")
    await Promise.all([fs.mkdir(nested, { recursive: true }), fs.mkdir(sibling)])

    try {
      const app = Server.Default().app
      expect((await app.request(`/path?directory=${encodeURIComponent(repository)}`)).status).toBe(403)

      const now = Date.now()
      const companyID = CompanyID.parse("cmp_local")
      const projectID = ProjectID.make("bound-repository-project")
      Database.use((db) => {
        db.insert(ProjectTable)
          .values({ id: projectID, worktree: repository, sandboxes: [], time_created: now, time_updated: now })
          .run()
        db.insert(CompanyTable)
          .values({
            id: companyID,
            name: "Agent Company",
            data_version: 1,
            default_provider_id: ProviderID.zod.parse("test"),
            default_model_id: ModelID.zod.parse("test"),
            bootstrap_request_id: "00000000-0000-4000-8000-000000000001",
            bootstrap_input_path: repository,
            time_created: now,
            time_updated: now,
          })
          .run()
        db.insert(RepositoryBindingTable)
          .values({
            id: "rbd_primary",
            company_id: companyID,
            project_id: projectID,
            root_path: repository,
            default_branch: "main",
            bootstrap_head_commit: null,
            bootstrap_dirty: false,
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      expect((await app.request(`/path?directory=${encodeURIComponent(repository)}`)).status).toBe(200)
      expect((await app.request(`/path?directory=${encodeURIComponent(nested)}`)).status).toBe(200)
      expect((await app.request(`/path?directory=${encodeURIComponent(sibling)}`)).status).toBe(403)
    } finally {
      await fs.rm(external, { recursive: true, force: true })
    }
  })
})
