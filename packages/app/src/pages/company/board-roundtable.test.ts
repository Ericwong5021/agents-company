import { describe, expect, test } from "bun:test"
import {
  boardChatItems,
  boardMemberStatus,
  projectChatItems,
  projectResumeDescription,
  shouldAutoScrollBoardFeed,
} from "./board-roundtable"

describe("board member status", () => {
  test("prioritizes the active speaker while a round is running", () => {
    expect(boardMemberStatus({ active: true, running: true, completed: false, failed: false })).toBe("发言中")
    expect(boardMemberStatus({ active: false, running: true, completed: false, failed: false })).toBe("倾听中")
  })

  test("projects terminal run states onto every board member", () => {
    expect(boardMemberStatus({ active: false, running: false, completed: true, failed: false })).toBe("已完成")
    expect(boardMemberStatus({ active: false, running: false, completed: false, failed: true })).toBe("已结束")
  })

  test("keeps an untouched board member on standby", () => {
    expect(boardMemberStatus({ active: false, running: false, completed: false, failed: false })).toBe("待命中")
  })
})

describe("board chat timeline", () => {
  test("turns thread entries into an oldest-first human and agent conversation", () => {
    const members = [
      {
        id: "board-cto",
        role: "cto",
        name: "CTO",
        lifecycle: "employee",
        responsibilities: ["技术方向与工程质量"],
      },
    ] as Parameters<typeof boardChatItems>[2]
    const entries = [
      {
        type: "agent_message",
        message: {
          id: "agent-later",
          roundNum: 1,
          agentID: "board-cto",
          body: "我来评估技术方案",
          time: { created: 20, updated: 20 },
        },
      },
      {
        type: "message",
        message: {
          id: "user-first",
          channelID: "chn_board",
          author: { kind: "user", id: "usr_local" },
          body: "请评估这个目标",
          visibility: "channel",
          mentions: [],
          time: { created: 10, updated: 10 },
        },
      },
    ] as Parameters<typeof boardChatItems>[0]

    expect(boardChatItems(entries, [], members).map((item) => [item.id, item.authorName])).toEqual([
      ["user-first", "你"],
      ["agent-later", "CTO"],
    ])
  })

  test("keeps persisted work items and approval gates in one chronological flow", () => {
    const project = {
      project: {
        id: "project-1",
        goal: "Ship a local product",
        title: "Local product",
        status: "awaiting_project_approval",
        output_dir: "/tmp/project-1",
        created_at: 1,
        updated_at: 30,
      },
      work_items: [
        {
          id: "work-1",
          title: "Research",
          description: "Collect evidence",
          kind: "research",
          status: "completed",
          created_at: 10,
          updated_at: 20,
        },
      ],
      artifacts: [],
      gates: [
        {
          id: "gate-1",
          kind: "project_approval",
          status: "pending",
          title: "Approve",
          summary: "Evidence complete",
          requested_at: 30,
        },
      ],
    } as Parameters<typeof projectChatItems>[0]

    expect(projectChatItems(project).map((item) => [item.type, item.id])).toEqual([
      ["work_item", "work-1"],
      ["gate", "gate-1"],
    ])
  })
})

describe("blocked project recovery copy", () => {
  test("describes research recovery without claiming that a plan or repository already exists", () => {
    expect(
      projectResumeDescription({
        work_items: [{ kind: "research" }, { kind: "synthesis" }],
      } as Parameters<typeof projectResumeDescription>[0]),
    ).toBe("可以保留失败记录和已有研究工作项，并使用当前可用模型继续调研。")
  })
})

describe("board feed silent refresh", () => {
  test("scrolls initially and follows new content only while the reader remains near the bottom", () => {
    expect(shouldAutoScrollBoardFeed({ initialized: false, contentChanged: true, wasNearBottom: false })).toBe(true)
    expect(shouldAutoScrollBoardFeed({ initialized: true, contentChanged: false, wasNearBottom: true })).toBe(false)
    expect(shouldAutoScrollBoardFeed({ initialized: true, contentChanged: true, wasNearBottom: false })).toBe(false)
    expect(shouldAutoScrollBoardFeed({ initialized: true, contentChanged: true, wasNearBottom: true })).toBe(true)
  })
})
