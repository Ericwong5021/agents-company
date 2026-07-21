import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { buildProbePrompt, probeOne, type ProbeCtx } from "../../../src/group-session/scheduler/probe"

describe("group-session probe", () => {
  test("requires a role-specific contribution instead of seniority-based participation", () => {
    expect(
      buildProbePrompt({
        persona: { name: "CEO", role: "ceo", description: "" },
        lastEvent: "User: hi",
        transcript: "",
        members: [],
        groupSessionID: "ses_test",
      }),
    ).toContain("Do not speak merely because of seniority")
  })

  test("passes safely when the optional probe agent is unavailable", async () => {
    const bid = await Effect.runPromise(
      probeOne(
        { probeAgent: undefined } as ProbeCtx,
        {
          persona: { name: "CEO", role: "ceo", description: "" },
          lastEvent: "User sent a new message: 你好",
          transcript: "",
          members: [],
          groupSessionID: "ses_test",
        },
      ),
    )

    expect(bid).toEqual({
      level: "pass",
      type: "info",
      addressedAs: "none",
      reason: "fallback: probe agent unavailable",
    })
  })
})
