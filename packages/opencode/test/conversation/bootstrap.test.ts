import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Company } from "../../src/company"
import { CompanyAgentTable } from "../../src/company-agent/company-agent.sql"
import { BootstrapInput } from "../../src/company/schema"
import { ChannelMemberTable, ChannelTable } from "../../src/conversation/conversation.sql"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import * as Database from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const providerConfig = {
  provider: {
    "m2-test": {
      name: "M2 Test",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      models: {
        "test-model": {
          name: "Test Model",
          tool_call: true,
          limit: { context: 8_000, output: 2_000 },
        },
      },
      options: { apiKey: "test-key" },
    },
  },
}

async function reset() {
  await Instance.disposeAll()
  await resetDatabase()
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

beforeEach(reset)
afterEach(reset)

describe.serial("M2 company channel bootstrap", () => {
  test.serial("creates the default company and board channels with their members", async () => {
    await using repository = await tmpdir({ git: true, config: providerConfig })
    await bootstrap(repository.path)

    expect(Database.use((db) => db.select().from(ChannelTable).all())).toHaveLength(2)
    expect(Database.use((db) => db.select().from(ChannelMemberTable).all())).toHaveLength(8)
  })

  test.serial("rolls channel rows back when a later bootstrap write fails", async () => {
    await using repository = await tmpdir({ git: true, config: providerConfig })
    Database.use((db) => db.insert(CompanyAgentTable).values({ id: "board-ceo", name: "Taken" }).run())

    await expect(bootstrap(repository.path)).rejects.toThrow()
    expect(Database.use((db) => db.select().from(ChannelTable).all())).toHaveLength(0)
    expect(Database.use((db) => db.select().from(ChannelMemberTable).all())).toHaveLength(0)
  })
})
