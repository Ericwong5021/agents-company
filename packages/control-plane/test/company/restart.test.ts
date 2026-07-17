import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { CompanyNeedsBootstrapState, CompanyProviderList, CompanyReadyState } from "../../src/company/schema"
import { IssuedCredential, LocalPairing } from "../../src/local-auth/schema"
import { tmpdir } from "../fixture/fixture"

const basic = "Basic " + Buffer.from("agentcompany:restart-secret").toString("base64")

async function waitForHealth(url: string, attempts = 400): Promise<void> {
  const ready = await fetch(new URL("/global/health", url))
    .then((response) => response.ok)
    .catch(() => false)
  if (ready) return
  if (attempts === 0) throw new Error("Restart test server did not become healthy")
  await Bun.sleep(25)
  return waitForHealth(url, attempts - 1)
}

async function start(home: string) {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") })
  const port = reservation.port
  await reservation.stop(true)
  const url = `http://127.0.0.1:${port}`
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "AGENTCOMPANY_DB")),
    AGENTCOMPANY_HOME: home,
    AGENTCOMPANY_SERVER_USERNAME: "agentcompany",
    AGENTCOMPANY_SERVER_PASSWORD: "restart-secret",
    AGENTCOMPANY_DISABLE_MODELS_FETCH: "true",
  }

  const child = Bun.spawn({
    cmd: [process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    cwd: path.resolve(import.meta.dir, "../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGTERM")
    await child.exited
  }

  await waitForHealth(url).catch(async (error) => {
    await stop()
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${await stdout}\n${await stderr}`)
  })

  return { url, [Symbol.asyncDispose]: stop }
}

async function json(url: string, pathname: string, init: RequestInit = {}, authorization: string | null = basic) {
  const headers = new Headers(init.headers)
  if (authorization) headers.set("authorization", authorization)
  if (init.body) headers.set("content-type", "application/json")
  const response = await fetch(new URL(pathname, url), { ...init, headers })
  return {
    response,
    body: await response.json().catch(() => undefined),
  }
}

async function initialize(home: string, repository: string) {
  await using server = await start(home)
  const providerSet = await json(server.url, "/company/providers/openai/credentials", {
    method: "PUT",
    body: JSON.stringify({ type: "api", key: "restart-test-key" }),
  })
  expect(providerSet.response.status).toBe(200)

  const providersResult = await json(server.url, "/company/providers")
  const providers = CompanyProviderList.parse(providersResult.body)
  const provider = providers.providers.find((item) => item.provider_id === "openai")
  const model = provider?.models[0]
  if (!provider || !model) throw new Error("Expected a connected OpenAI test model")

  const bootstrap = await json(server.url, "/company/bootstrap", {
    method: "POST",
    body: JSON.stringify({
      request_id: randomUUID(),
      company_name: "Agent Company",
      provider_id: provider.provider_id,
      model_id: model.model_id,
      repository_path: repository,
      approval_preset: "balanced",
    }),
  })
  expect(bootstrap.response.status).toBe(200)
  const company = CompanyReadyState.parse(bootstrap.body)

  const pairingResult = await json(server.url, "/local-auth/pairings", {
    method: "POST",
    body: JSON.stringify({ label: "Restart browser" }),
  })
  const pairing = LocalPairing.parse(pairingResult.body)
  const exchange = await json(
    server.url,
    "/local-auth/exchange",
    {
      method: "POST",
      body: JSON.stringify({ code: pairing.code, label: pairing.label }),
    },
    null,
  )
  expect(exchange.response.status).toBe(200)

  return { company, issued: IssuedCredential.parse(exchange.body) }
}

describe.serial("Company process restart", () => {
  test.serial("restores company and browser credential after process restart", async () => {
    await using home = await tmpdir()
    await using repository = await tmpdir({ git: true })
    const first = await initialize(home.path, repository.path)

    await using server = await start(home.path)
    const bearer = "Bearer " + first.issued.token
    const restoredResult = await json(server.url, "/company", {}, bearer)
    expect(restoredResult.response.status).toBe(200)
    const restored = CompanyReadyState.parse(restoredResult.body)
    expect(restored.company.id).toBe(first.company.company.id)
    expect(restored.company.board.map((member) => member.id)).toEqual(
      first.company.company.board.map((member) => member.id),
    )
    expect(restored.company.repository.project_id).toBe(first.company.company.repository.project_id)

    const revoke = await json(server.url, "/local-auth/credentials/" + first.issued.credential_id, { method: "DELETE" })
    expect(revoke.response.status).toBe(200)
    expect((await json(server.url, "/company", {}, bearer)).response.status).toBe(401)
  }, { timeout: 60_000 })

  test.serial("isolates two AGENTCOMPANY_HOME roots across child processes", async () => {
    await using homeA = await tmpdir()
    await using repository = await tmpdir({ git: true })
    const first = await initialize(homeA.path, repository.path)

    await using homeB = await tmpdir()
    await using serverB = await start(homeB.path)
    const freshResult = await json(serverB.url, "/company")
    expect(freshResult.response.status).toBe(200)
    const fresh = CompanyNeedsBootstrapState.parse(freshResult.body)
    expect(fresh.data_directory).toBe(path.join(homeB.path, "data"))
    expect((await json(serverB.url, "/company", {}, "Bearer " + first.issued.token)).response.status).toBe(401)

    await using serverA = await start(homeA.path)
    const restoredResult = await json(serverA.url, "/company", {}, "Bearer " + first.issued.token)
    expect(restoredResult.response.status).toBe(200)
    expect(CompanyReadyState.parse(restoredResult.body).company.id).toBe(first.company.company.id)
  }, { timeout: 90_000 })
})
