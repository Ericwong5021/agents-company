import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Company } from "../../src/company"
import { CompanyAgentTable } from "../../src/company-agent/company-agent.sql"
import { BootstrapInput } from "../../src/company/schema"
import { Config } from "../../src/config"
import { ChannelMemberTable, ChannelTable } from "../../src/conversation/conversation.sql"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import * as Database from "../../src/storage/db"
import { companyProviderConfig } from "../fixture/company-provider"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const initialGlobalConfig = Global.Path.config
let testGlobalConfig: string | undefined

async function reset() {
  await Instance.disposeAll()
  if (testGlobalConfig) {
    ;(Global.Path as { config: string }).config = initialGlobalConfig
    await AppRuntime.runPromise(Config.Service.use((config) => config.invalidate(true)))
    await fs.rm(testGlobalConfig, { recursive: true, force: true })
    testGlobalConfig = undefined
  }
  await resetDatabase()
}

async function setup() {
  await reset()
  testGlobalConfig = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-m2-provider-"))
  await Bun.write(path.join(testGlobalConfig, "provider-settings.json"), JSON.stringify(companyProviderConfig))
  ;(Global.Path as { config: string }).config = testGlobalConfig
  await AppRuntime.runPromise(Config.Service.use((config) => config.invalidate(true)))
}

async function bootstrap(directory: string) {
  return Instance.provide({
    directory,
    fn: () =>
      AppRuntime.runPromise(
        Company.Service.use((company) =>
          company.bootstrap(
            BootstrapInput.parse({
              request_id: "018f84f8-9c21-7d4d-a850-d63f8f9344cd",
              company_name: "Agent Company",
              provider_id: "m2-test",
              model_id: "test-model",
              repository_path: directory,
            }),
          ),
        ),
      ),
  })
}

beforeEach(setup)
afterEach(reset)

describe.serial("M2 company channel bootstrap", () => {
  test.serial("creates the default company and board channels with their members", async () => {
    await using repository = await tmpdir({ git: true })
    await bootstrap(repository.path)

    expect(Database.use((db) => db.select().from(ChannelTable).all())).toHaveLength(2)
    expect(Database.use((db) => db.select().from(ChannelMemberTable).all())).toHaveLength(8)
  })

  test.serial("rolls channel rows back when a later bootstrap write fails", async () => {
    await using repository = await tmpdir({ git: true })
    Database.use((db) => db.insert(CompanyAgentTable).values({ id: "board-ceo", name: "Taken" }).run())

    await expect(bootstrap(repository.path)).rejects.toThrow()
    expect(Database.use((db) => db.select().from(ChannelTable).all())).toHaveLength(0)
    expect(Database.use((db) => db.select().from(ChannelMemberTable).all())).toHaveLength(0)
  })
})
