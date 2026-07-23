import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Company } from "../../src/company"
import { CompanyAgentTable } from "../../src/company-agent/company-agent.sql"
import { CompanyAgentID } from "../../src/company-agent/schema"
import { BootstrapInput, CompanyID } from "../../src/company/schema"
import { ApprovalPolicyTable, CompanyTable, RepositoryBindingTable } from "../../src/company/company.sql"
import { Config } from "../../src/config"
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
  testGlobalConfig = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-m1-provider-"))
  await Bun.write(path.join(testGlobalConfig, "provider-settings.json"), JSON.stringify(companyProviderConfig))
  ;(Global.Path as { config: string }).config = testGlobalConfig
  await AppRuntime.runPromise(Config.Service.use((config) => config.invalidate(true)))
}

beforeEach(setup)
afterEach(reset)

function input(path: string, override: Record<string, unknown> = {}) {
  return BootstrapInput.parse({
    request_id: "018f84f8-9c21-7d4d-a850-d63f8f9344cc",
    company_name: "Agent Company",
    provider_id: "m1-test",
    model_id: "test-model",
    repository_path: path,
    approval_preset: "balanced",
    ...override,
  })
}

async function bootstrap(path: string, override: Record<string, unknown> = {}) {
  return Instance.provide({
    directory: path,
    fn: () =>
      AppRuntime.runPromise(Company.Service.use((company) => company.bootstrap(input(path, override)))),
  })
}

function git(directory: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: directory })
  if (result.exitCode === 0) return
  throw new Error(result.stderr.toString())
}

async function nonGitDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-m1-nongit-"))
  await fs.writeFile(
    path.join(directory, "agent-company.json"),
    JSON.stringify({ $schema: "https://control-plane.ai/config.json" }),
  )
  return {
    path: await fs.realpath(directory),
    [Symbol.asyncDispose]: () => fs.rm(directory, { recursive: true, force: true }),
  }
}

describe.serial("Company bootstrap", () => {
  test.serial(
    "creates one company, one binding, and exactly three board members",
    async () => {
      await using repo = await tmpdir({
        git: true,
      })
      const result = await bootstrap(repo.path)
      expect(result.state).toBe("ready")
      if (result.state !== "ready") throw new Error("Expected ready state")
      if (!result.company.repository) throw new Error("Expected repository binding")
      expect(result.company.board).toHaveLength(3)
      expect(result.company.repository.root_path).toBe(repo.path)
      expect(Database.use((db) => db.select().from(CompanyTable).all())).toHaveLength(1)
      expect(Database.use((db) => db.select().from(ApprovalPolicyTable).all())).toHaveLength(1)
      expect(Database.use((db) => db.select().from(RepositoryBindingTable).all())).toHaveLength(1)
    },
    { timeout: 30_000 },
  )

  test.serial("updates and persists the company approval preset", async () => {
    await using repo = await tmpdir({ git: true })
    await Instance.provide({
      directory: repo.path,
      fn: () => AppRuntime.runPromise(Company.Service.use((company) => company.current())),
    })

    const updated = await Instance.provide({
      directory: repo.path,
      fn: () =>
        AppRuntime.runPromise(
          Company.Service.use((company) => company.updateApprovalPolicy({ preset: "strict" })),
        ),
    })
    expect(updated.company.approval_policy.preset).toBe("strict")

    const current = await Instance.provide({
      directory: repo.path,
      fn: () => AppRuntime.runPromise(Company.Service.use((company) => company.current())),
    })
    expect(current.state).toBe("ready")
    if (current.state !== "ready") throw new Error("Expected ready state")
    expect(current.company.approval_policy.preset).toBe("strict")
  })

  test.serial("keeps the company ready when non-board agents join", async () => {
    await using repo = await tmpdir({ git: true })
    await Instance.provide({
      directory: repo.path,
      fn: () => AppRuntime.runPromise(Company.Service.use((company) => company.current())),
    })
    const now = Date.now()
    Database.use((db) =>
      db
        .insert(CompanyAgentTable)
        .values({
          id: CompanyAgentID.make("delivery-candidate"),
          company_id: CompanyID.parse("cmp_local"),
          lifecycle: "candidate",
          name: "Delivery Candidate",
          org_layer: "execution",
          time_created: now,
          time_updated: now,
        })
        .run(),
    )

    const current = await Instance.provide({
      directory: repo.path,
      fn: () => AppRuntime.runPromise(Company.Service.use((company) => company.current())),
    })

    expect(current.state).toBe("ready")
    if (current.state !== "ready") throw new Error("Expected ready state")
    expect(current.company.board.map((member) => member.id)).toEqual(["board-ceo", "board-cto", "board-product-lead"])
  })

  test.serial("repairs orphan company rows into the default empty workspace", async () => {
    await using repo = await tmpdir({ git: true })
    Database.use((db) => db.insert(CompanyAgentTable).values({ id: "board-ceo", name: "Orphaned agent" }).run())

    const state = await Instance.provide({
      directory: repo.path,
      fn: () => AppRuntime.runPromise(Company.Service.use((company) => company.current())),
    })

    expect(state.state).toBe("ready")
    if (state.state !== "ready") throw new Error("Expected repaired ready state")
    expect(state.company.provider).toBeNull()
    expect(state.company.repository).toBeNull()
    expect(state.company.board.map((member) => member.name)).toEqual(["CEO", "CTO", "Product Lead"])
    expect(Database.use((db) => db.select().from(CompanyAgentTable).all().map((agent) => agent.name))).toEqual([
      "CEO",
      "CTO",
      "Product Lead",
    ])
  })

  test.serial("same request is idempotent and changed request conflicts", async () => {
    await using repo = await tmpdir({
      git: true,
    })
    const first = await bootstrap(repo.path)
    const second = await bootstrap(repo.path)
    expect(second).toEqual(first)
    await expect(bootstrap(repo.path, { company_name: "Other" })).rejects.toMatchObject({
      name: "CompanyAlreadyInitialized",
    })
  })

  test.serial("rejects a non-git repository after validating the configured provider", async () => {
    await using directory = await nonGitDirectory()
    await expect(bootstrap(directory.path)).rejects.toMatchObject({ name: "CompanyRepositoryNotGit" })
  })

  test.serial("rejects a provider that is not connected", async () => {
    await using repo = await tmpdir({ git: true })
    await expect(bootstrap(repo.path, { provider_id: "m1-unconnected" })).rejects.toMatchObject({
      name: "CompanyProviderNotConnected",
    })
  })

  test.serial("retries the same request without current provider or repository access", async () => {
    await using repo = await tmpdir({ git: true })
    const first = await bootstrap(repo.path)
    await Bun.write(path.join(repo.path, "advance-bootstrap-head"), "changed")
    git(repo.path, "add", "advance-bootstrap-head")
    git(repo.path, "commit", "-m", "advance-bootstrap-head")
    await Bun.write(path.join(repo.path, "dirty-after-bootstrap"), "changed")

    const moved = repo.path + "-moved"
    await fs.rename(repo.path, moved)
    try {
      expect(await bootstrap(repo.path)).toEqual(first)
    } finally {
      await Instance.disposeAll()
      await fs.rename(moved, repo.path)
    }
  })

  test.serial("accepts a new request through an alias to the canonical repository root", async () => {
    await using repo = await tmpdir({ git: true })
    const first = await bootstrap(repo.path)
    const alias = path.join(path.dirname(repo.path), path.basename(repo.path) + "-alias")
    await fs.symlink(repo.path, alias)
    try {
      expect(
        await bootstrap(alias, {
          request_id: "018f84f8-9c21-7d4d-a850-d63f8f9344cd",
        }),
      ).toEqual(first)
    } finally {
      await fs.unlink(alias)
    }
  })

  test.serial("concurrent bootstrap calls produce one singleton", async () => {
    await using repo = await tmpdir({ git: true })
    const [first, second] = await Promise.all([bootstrap(repo.path), bootstrap(repo.path)])
    expect(second).toEqual(first)
    expect(Database.use((db) => db.select().from(CompanyTable).all())).toHaveLength(1)
    expect(
      Database.use((db) => db.select().from(CompanyAgentTable).all().filter((agent) => agent.company_id === "cmp_local")),
    ).toHaveLength(3)
  })

  test.serial("rolls back the company when board creation fails", async () => {
    await using repo = await tmpdir({ git: true })
    Database.use((db) => db.insert(CompanyAgentTable).values({ id: "board-ceo", name: "Taken" }).run())
    await expect(bootstrap(repo.path)).rejects.toThrow()
    const state = await Instance.provide({
      directory: repo.path,
      fn: () => AppRuntime.runPromise(Company.Service.use((company) => company.current())),
    })
    expect(state.state).toBe("ready")
    if (state.state !== "ready") throw new Error("Expected repaired ready state")
    expect(state.company.provider).toBeNull()
    expect(state.company.repository).toBeNull()
    expect(state.company.board.map((member) => member.name)).toEqual(["CEO", "CTO", "Product Lead"])
  })
})
