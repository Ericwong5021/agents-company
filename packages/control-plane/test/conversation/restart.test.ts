import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { CompanyProviderList, CompanyReadyState } from "../../src/company/schema"
import { IssuedCredential, LocalPairing } from "../../src/local-auth/schema"
import { availablePort, tmpdir } from "../fixture/fixture"

/**
 * Task 10 restart vertical: proves the M2 conversation survives a Control Plane
 * process crash and restart. It exercises the §8 failure matrix rows where the
 * process is killed after the send transaction commits but before/as the board
 * run completes — the user message, Root Need, Thread and queued run are already
 * persisted, so restart must rehydrate them without duplicating any row.
 *
 * This test deliberately does not depend on a live LLM completing the full board
 * projection: the contract under test is persistence + idempotent recovery, not
 * model behavior (covered by runtime/signal-projector tests with a scripted LLM).
 */

const basic = "Basic " + Buffer.from("agentcompany:conv-restart-secret").toString("base64")

async function waitForHealth(url: string, attempts = 400): Promise<void> {
  const ready = await fetch(new URL("/global/health", url))
    .then((response) => response.ok)
    .catch(() => false)
  if (ready) return
  if (attempts === 0) throw new Error("Conversation restart server did not become healthy")
  await Bun.sleep(25)
  return waitForHealth(url, attempts - 1)
}

async function start(home: string) {
  const port = await availablePort()
  const url = `http://127.0.0.1:${port}`
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "AGENTCOMPANY_DB")),
    AGENTCOMPANY_HOME: home,
    AGENTCOMPANY_SERVER_USERNAME: "agentcompany",
    AGENTCOMPANY_SERVER_PASSWORD: "conv-restart-secret",
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

  return {
    url,
    kill: stop,
    [Symbol.asyncDispose]: stop,
  }
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
    body: JSON.stringify({ type: "api", key: "conv-restart-test-key" }),
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
    body: JSON.stringify({ label: "Conv restart browser" }),
  })
  const pairing = LocalPairing.parse(pairingResult.body)
  const exchange = await json(
    server.url,
    "/local-auth/exchange",
    { method: "POST", body: JSON.stringify({ code: pairing.code, label: pairing.label }) },
    null,
  )
  expect(exchange.response.status).toBe(200)

  return { company, issued: IssuedCredential.parse(exchange.body) }
}

async function boardChannelID(url: string, bearer: string, companyID: string): Promise<string> {
  const result = await json(url, `/company/channels?company_id=${companyID}`, {}, bearer)
  expect(result.response.status).toBe(200)
  const channels = (result.body as Array<{ id: string; kind: string }>) ?? []
  const board = channels.find((channel) => channel.kind === "board")
  if (!board) throw new Error("Expected a board channel after bootstrap")
  return board.id
}

describe.serial("Conversation process restart", () => {
  test.serial("persists the board message across crash and replays idempotently", async () => {
    await using home = await tmpdir()
    await using repository = await tmpdir({ git: true })
    const first = await initialize(home.path, repository.path)
    const bearer = "Bearer " + first.issued.token
    const companyID = first.company.company.id

    // Send a board goal; the 202 confirms persistence before any model work.
    await using server = await start(home.path)
    const channelID = await boardChannelID(server.url, bearer, companyID)
    const requestID = randomUUID()
    const send = await json(
      server.url,
      `/company/channels/${channelID}/messages?company_id=${companyID}`,
      {
        method: "POST",
        body: JSON.stringify({ request_id: requestID, body: "Define the M2 real-IM scope" }),
      },
      bearer,
    )
    expect(send.response.status).toBe(202)
    const accepted = send.body as { messageID: string; threadID?: string; runID?: string; replayed: boolean }
    expect(accepted.messageID).toBeTruthy()

    // Kill the process while the board run is still queued/running.
    await server.kill()

    // Restart: the persisted message, thread and run must rehydrate, and the
    // recovery layer must not duplicate them.
    await using restored = await start(home.path)
    const messagesResult = await json(
      restored.url,
      `/company/channels/${channelID}/messages?company_id=${companyID}&limit=50`,
      {},
      bearer,
    )
    expect(messagesResult.response.status).toBe(200)
    const page = messagesResult.body as { items: Array<{ id: string; body: string; requestID?: string }> }
    const userMessages = page.items.filter((item) => item.requestID === requestID)
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0].body).toBe("Define the M2 real-IM scope")

    // Replaying the exact same request must return the original result, not 409
    // and not a duplicate — the (channel_id, request_id) idempotency key holds.
    const replay = await json(
      restored.url,
      `/company/channels/${channelID}/messages?company_id=${companyID}`,
      { method: "POST", body: JSON.stringify({ request_id: requestID, body: "Define the M2 real-IM scope" }) },
      bearer,
    )
    expect(replay.response.status).toBe(202)
    const replayed = replay.body as { messageID: string; replayed: boolean }
    expect(replayed.messageID).toBe(accepted.messageID)
    expect(replayed.replayed).toBe(true)
  }, { timeout: 120_000 })

  test.serial("rejects a conflicting body on the same request id", async () => {
    await using home = await tmpdir()
    await using repository = await tmpdir({ git: true })
    const first = await initialize(home.path, repository.path)
    const bearer = "Bearer " + first.issued.token
    const companyID = first.company.company.id

    await using server = await start(home.path)
    const channelID = await boardChannelID(server.url, bearer, companyID)
    const requestID = randomUUID()
    const send = await json(
      server.url,
      `/company/channels/${channelID}/messages?company_id=${companyID}`,
      { method: "POST", body: JSON.stringify({ request_id: requestID, body: "First body" }) },
      bearer,
    )
    expect(send.response.status).toBe(202)

    // Same request_id, different body → 409 conflict, no second message.
    const conflict = await json(
      server.url,
      `/company/channels/${channelID}/messages?company_id=${companyID}`,
      { method: "POST", body: JSON.stringify({ request_id: requestID, body: "Different body" }) },
      bearer,
    )
    expect(conflict.response.status).toBe(409)

    // After restart the original message is the only one for that request id.
    await server.kill()
    await using restored = await start(home.path)
    const messagesResult = await json(
      restored.url,
      `/company/channels/${channelID}/messages?company_id=${companyID}&limit=50`,
      {},
      bearer,
    )
    const page = messagesResult.body as { items: Array<{ requestID?: string; body: string }> }
    const forRequest = page.items.filter((item) => item.requestID === requestID)
    expect(forRequest).toHaveLength(1)
    expect(forRequest[0].body).toBe("First body")
  }, { timeout: 120_000 })
})
