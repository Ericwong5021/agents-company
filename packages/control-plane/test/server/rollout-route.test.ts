import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  RolloutActionResult,
  RolloutApiError,
  RolloutEvidence,
  RolloutJournal,
  RolloutStatus,
  RolloutTransitionResult,
} from "@agents-company/shared/rollout"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"

let previousExecutionMode: string | undefined

beforeEach(async () => {
  previousExecutionMode = process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
  process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "off"
  await resetDatabase()
})

afterEach(async () => {
  await resetDatabase()
  if (previousExecutionMode === undefined) delete process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
  else process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = previousExecutionMode
})

async function json(pathname: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  if (init?.body) headers.set("content-type", "application/json")
  const response = await Server.Default().app.request(pathname, { ...init, headers })
  return { response, body: (await response.json()) as unknown }
}

describe.serial("/rollout", () => {
  test.serial("exposes strict rollout transitions, evidence actions, and replay conflicts", async () => {
    const initial = await json("/rollout")
    expect(initial.response.status).toBe(200)
    expect(RolloutStatus.parse(initial.body)).toMatchObject({
      state: { phase: "off", version: 1 },
      executionMode: "off",
      newProjectPolicy: { defaultStrategy: "legacy_full_plan" },
    })

    const transitionRequest = {
      idempotencyKey: "route-shadow",
      to: "shadow",
      reason: "exercise the rollout route",
    }
    const transition = await json("/rollout/transitions", {
      method: "POST",
      body: JSON.stringify(transitionRequest),
    })
    expect(transition.response.status).toBe(200)
    const transitionResult = RolloutTransitionResult.parse(transition.body)
    expect(transitionResult).toMatchObject({
      replayed: false,
      state: { phase: "shadow", version: 2 },
    })

    const replay = await json("/rollout/transitions", {
      method: "POST",
      body: JSON.stringify(transitionRequest),
    })
    expect(replay.response.status).toBe(200)
    expect(RolloutTransitionResult.parse(replay.body)).toEqual({
      ...transitionResult,
      replayed: true,
    })

    const collision = await json("/rollout/transitions", {
      method: "POST",
      body: JSON.stringify({ ...transitionRequest, reason: "different payload" }),
    })
    expect(collision.response.status).toBe(409)
    expect(RolloutApiError.parse(collision.body).code).toBe("idempotency_collision")

    const action = await json("/rollout/actions", {
      method: "POST",
      body: JSON.stringify({
        kind: "register_candidate",
        idempotencyKey: "route-candidate",
        candidate: {
          id: "route-candidate-1",
          candidateSha: "a".repeat(40),
          targetRef: "refs/heads/main",
        },
      }),
    })
    expect(action.response.status).toBe(200)
    expect(RolloutActionResult.parse(action.body)).toMatchObject({
      kind: "register_candidate",
      candidate: { id: "route-candidate-1" },
      replayed: false,
    })

    const evidence = await json("/rollout/evidence?limit=10")
    expect(evidence.response.status).toBe(200)
    expect(RolloutEvidence.parse(evidence.body)).toMatchObject({
      candidates: [{ id: "route-candidate-1" }],
      localRepeats: [],
      rollbacks: [],
    })

    const journal = await json("/rollout/journal?limit=10")
    expect(journal.response.status).toBe(200)
    expect(RolloutJournal.parse(journal.body).items).toHaveLength(2)

    const malformed = await json("/rollout/actions", {
      method: "POST",
      body: JSON.stringify({
        kind: "register_candidate",
        idempotencyKey: "route-malformed",
        candidate: {
          id: "route-candidate-2",
          candidateSha: "b".repeat(40),
          targetRef: "refs/heads/main",
          pass: true,
        },
      }),
    })
    expect(malformed.response.status).toBe(400)
  })

  test.serial(
    "publishes concrete OpenAPI request and response schemas",
    async () => {
      const spec = await Server.openapi()
      const operations = [
        { method: "get", path: "/rollout", request: false, statuses: ["200", "500"] },
        { method: "post", path: "/rollout/transitions", request: true, statuses: ["200", "409", "500"] },
        { method: "post", path: "/rollout/actions", request: true, statuses: ["200", "409", "500"] },
        { method: "post", path: "/rollout/promotion-evaluations", request: true, statuses: ["200", "409", "500"] },
        { method: "get", path: "/rollout/journal", request: false, statuses: ["200", "500"] },
        { method: "get", path: "/rollout/evidence", request: false, statuses: ["200", "500"] },
      ] as const

      for (const item of operations) {
        const operation = spec.paths?.[item.path]?.[item.method]
        expect(operation?.operationId).toBeDefined()
        if (item.request) {
          if (!operation?.requestBody || !("content" in operation.requestBody))
            throw new Error(`Missing JSON request schema for ${item.method} ${item.path}`)
          expect(operation.requestBody.required).toBe(true)
          const schema = operation.requestBody.content?.["application/json"]?.schema
          expect(schema).toBeDefined()
          expect(JSON.stringify(schema)).not.toContain('"type":"unknown"')
        }
        for (const status of item.statuses) {
          const response = operation?.responses?.[status]
          if (!response || !("content" in response))
            throw new Error(`Missing JSON response schema for ${item.method} ${item.path} ${status}`)
          const schema = response.content?.["application/json"]?.schema
          expect(schema).toBeDefined()
          expect(JSON.stringify(schema)).not.toContain('"type":"unknown"')
        }
      }
    },
    30000,
  )
})
