import { describe, expect, test } from "bun:test"
import {
  authorLabel,
  boardMessagesEnabled,
  interruptAction,
  mergeMessages,
  signalBadge,
  threadEntryAuthor,
  threadEntryBody,
  threadMemberIds,
  threadSummary,
  type ChannelMessage,
  type ThreadDetail,
  type ThreadEntry,
} from "../../../src/cli/cmd/tui/routes/company-channel-model"

function msg(partial: Partial<ChannelMessage> & Pick<ChannelMessage, "id">): ChannelMessage {
  return {
    channelID: "chn_board",
    body: partial.body ?? "hello",
    author: partial.author ?? { kind: "user", id: "u1" },
    visibility: partial.visibility ?? "channel",
    mentions: partial.mentions ?? [],
    time: partial.time ?? { created: 1000, updated: 1000 },
    ...partial,
  }
}

describe("company-channel model", () => {
  test("mergeMessages dedups by id and keeps stable (created, id) order", () => {
    const existing = [
      msg({ id: "cmsg_a", time: { created: 1000, updated: 1000 } }),
      msg({ id: "cmsg_b", time: { created: 2000, updated: 2000 } }),
    ]
    const next = [
      // duplicate of a — must not appear twice
      msg({ id: "cmsg_a", body: "updated body", time: { created: 1000, updated: 1500 } }),
      // new, earlier created time — sorts before existing
      msg({ id: "cmsg_z", time: { created: 500, updated: 500 } }),
    ]

    const merged = mergeMessages(existing, next)

    expect(merged.map((m) => m.id)).toEqual(["cmsg_z", "cmsg_a", "cmsg_b"])
    // duplicate id is overwritten by the fresher fetch, not appended
    expect(merged.find((m) => m.id === "cmsg_a")?.body).toBe("updated body")
  })

  test("mergeMessages tie-breaks equal created times by id", () => {
    const merged = mergeMessages(
      [],
      [
        msg({ id: "cmsg_b", time: { created: 1000, updated: 1000 } }),
        msg({ id: "cmsg_a", time: { created: 1000, updated: 1000 } }),
      ],
    )
    expect(merged.map((m) => m.id)).toEqual(["cmsg_a", "cmsg_b"])
  })

  test("mergeMessages is idempotent", () => {
    const page = [msg({ id: "cmsg_a" })]
    expect(mergeMessages(mergeMessages(page, page), page).map((m) => m.id)).toEqual(["cmsg_a"])
  })

  test("authorLabel localizes users and ids agents/system", () => {
    expect(authorLabel({ kind: "user", id: "u1" }, "You")).toBe("You")
    expect(authorLabel({ kind: "agent", id: "ceo" }, "You")).toBe("ceo")
    expect(authorLabel({ kind: "system", id: "board" }, "You")).toBe("board")
  })

  test("signalBadge passes through high-signal types and drops undefined", () => {
    expect(signalBadge("conclusion")).toBe("conclusion")
    expect(signalBadge("risk")).toBe("risk")
    expect(signalBadge(undefined)).toBeUndefined()
  })

  test("threadSummary renders title and status", () => {
    const thread: ThreadDetail = {
      id: "cth_1",
      channelID: "chn_board",
      title: "Goal: ship M2",
      status: "active",
      members: [],
      time: { created: 1, updated: 2 },
    }
    expect(threadSummary(thread)).toBe("Goal: ship M2 (active)")
  })

  test("threadMemberIds deduplicates participant ids", () => {
    const thread: ThreadDetail = {
      id: "cth_1",
      channelID: "chn_board",
      title: "t",
      status: "active",
      members: [
        { principal: { kind: "user", id: "u1" }, time: { joined: 1 } },
        { principal: { kind: "agent", id: "ceo" }, time: { joined: 1 } },
        { principal: { kind: "agent", id: "ceo" }, time: { joined: 2 } },
        { principal: { kind: "agent", id: "cto" }, time: { joined: 1 } },
      ],
      time: { created: 1, updated: 2 },
    }
    expect(threadMemberIds(thread)).toEqual(["u1", "ceo", "cto"])
  })

  test("interruptAction is the only structured M2 thread action", () => {
    expect(interruptAction()).toEqual({ kind: "interrupt" })
  })

  test("board capability is fail-closed in every TUI send surface", () => {
    expect(boardMessagesEnabled(undefined)).toBeFalse()
    expect(boardMessagesEnabled({ board_messages: false })).toBeFalse()
    expect(boardMessagesEnabled({ board_messages: true })).toBeTrue()
  })

  test("thread entry helpers render channel and agent messages without unsafe narrowing", () => {
    const channelEntry: ThreadEntry = {
      type: "message",
      message: msg({ id: "cmsg_1", body: "user goal" }),
    }
    const agentEntry: ThreadEntry = {
      type: "agent_message",
      message: {
        id: "gmsg_1",
        roundNum: 1,
        agentID: "ceo",
        body: "agent answer",
        time: { created: 2, updated: 2 },
      },
    }

    expect(threadEntryAuthor(channelEntry, "You")).toBe("You")
    expect(threadEntryBody(channelEntry)).toBe("user goal")
    expect(threadEntryAuthor(agentEntry, "You")).toBe("ceo")
    expect(threadEntryBody(agentEntry)).toBe("agent answer")
  })
})
