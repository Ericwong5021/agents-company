import { describe, expect, test } from "bun:test"
import {
  parseAgents,
  parseBoardChannel,
  parseCompany,
  parseHealth,
  parseMessages,
  parseProjects,
  parseReadiness,
} from "../modules/agent-company/runtime/shared/snapshot-contract"

describe("company snapshot contract", () => {
  test("requires explicit health and readiness fields", () => {
    expect(parseHealth({ healthy: true, version: "1.2.3" })).toEqual({
      ok: true,
      value: "1.2.3",
    })
    expect(parseHealth({ healthy: true })).toEqual({ ok: false })
    expect(
      parseReadiness({
        ready: true,
        checks: [{ id: "database", status: "pass", detail: "ready" }],
      }),
    ).toEqual({
      ok: true,
      value: { ready: true, checks: [{ id: "database", status: "pass" }] },
    })
    expect(parseReadiness({ ready: true, checks: [{ id: "database", status: "unknown" }] }))
      .toEqual({ ok: false })
  })

  test("does not invent company identity, policy, or provider details", () => {
    expect(
      parseCompany({
        state: "ready",
        company: {
          id: "company-1",
          name: "Acme",
          approval_policy: { preset: "balanced" },
          provider: null,
          setup_goal: null,
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        id: "company-1",
        name: "Acme",
        policy: "balanced",
        provider: null,
        setupGoal: undefined,
      },
    })
    expect(
      parseCompany({
        state: "ready",
        company: {
          id: "",
          name: "Acme",
          approval_policy: { preset: "balanced" },
          provider: null,
        },
      }),
    ).toEqual({ ok: false })
  })

  test("accepts truthful empty collections and rejects incomplete records", () => {
    expect(parseAgents([])).toEqual({ ok: true, value: [] })
    expect(parseProjects([])).toEqual({ ok: true, value: [] })
    expect(parseBoardChannel([])).toEqual({ ok: true, value: null })
    expect(parseBoardChannel([{ id: "channel-chat", kind: "chat" }])).toEqual({
      ok: true,
      value: null,
    })
    expect(parseAgents([{ agent: { id: "agent-1" }, presence: "online", activity: "working" }]))
      .toEqual({ ok: false })
    expect(parseProjects([{ id: "project-1", title: "Launch", progress: 140, status: "active" }]))
      .toEqual({ ok: false })
    expect(parseBoardChannel([{ id: "", kind: "board" }])).toEqual({ ok: false })
  })

  test("requires real agent identity for agent-authored messages", () => {
    const agents = [{
      id: "agent-1",
      name: "Ada",
      role: "Researcher",
      activity: "working",
      presence: "online" as const,
    }]
    const message = {
      id: "message-1",
      sequence: 1,
      kind: "text",
      author: { kind: "agent", id: "agent-1" },
      body: "Evidence collected",
      reactions: [],
      pollVotes: [],
      deliveries: [],
      time: { created: 1_750_000_000_000 },
    }

    expect(parseMessages({ items: [message] }, agents).ok).toBe(true)
    expect(
      parseMessages({
        items: [{ ...message, author: { kind: "agent", id: "missing-agent" } }],
      }, agents),
    ).toEqual({ ok: false })
    expect(parseMessages({ items: [{ ...message, body: "" }] }, agents)).toEqual({ ok: false })
    expect(parseMessages({ items: [{ ...message, time: { created: 1e308 } }] }, agents)).toEqual({ ok: false })
    expect(parseMessages({ items: [{ ...message, time: { created: -1 } }] }, agents)).toEqual({ ok: false })
  })
})
