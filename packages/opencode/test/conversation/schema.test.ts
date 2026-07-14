import { describe, expect, test } from "bun:test"
import {
  ChannelKind,
  ChannelMessageCursor,
  HighSignalDraft,
  SignalProjectionSourceKind,
} from "../../src/conversation/schema"

describe("M2 conversation schema", () => {
  test("accepts exactly the five declared channel kinds", () => {
    expect(ChannelKind.options).toEqual(["company", "board", "department", "project", "direct"])
    expect(ChannelKind.safeParse("private").success).toBe(false)
  })

  test("requires a DRI for decision signals", () => {
    expect(
      HighSignalDraft.safeParse({
        signal_type: "decision",
        body: "Proceed with the scoped option.",
        author: { kind: "agent", id: "board-ceo" },
      }).success,
    ).toBe(false)

    expect(
      HighSignalDraft.safeParse({
        signal_type: "decision",
        body: "Proceed with the scoped option.",
        author: { kind: "agent", id: "board-ceo" },
        dri: { kind: "agent", id: "board-ceo" },
      }).success,
    ).toBe(true)
  })

  test("keeps source kinds explicit and validates opaque message cursors", () => {
    expect(SignalProjectionSourceKind.options).toEqual([
      "group_message",
      "message",
      "part",
      "agent_message",
      "decision",
      "artifact",
      "gate",
    ])
    expect(ChannelMessageCursor.safeParse({ id: "cmsg_01", time_created: 1 }).success).toBe(true)
    expect(ChannelMessageCursor.safeParse({ id: "msg_01", time_created: 1 }).success).toBe(false)
  })
})
