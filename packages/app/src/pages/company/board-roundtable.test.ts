import { describe, expect, test } from "bun:test"
import {
  boardChatItems,
  boardMemberStatus,
  latestExecutionProposal,
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

  test("only exposes an explicit agent plan as an execution proposal", () => {
    const proposal = latestExecutionProposal([
      {
        id: "user-plan",
        authorKind: "user",
        authorID: "usr_local",
        authorName: "你",
        role: "Owner",
        body: "请直接执行",
        created: 1,
        signalType: "plan",
      },
      {
        id: "agent-conclusion",
        authorKind: "agent",
        authorID: "board-ceo",
        authorName: "CEO",
        role: "ceo",
        body: "我们还需要继续讨论。",
        created: 2,
        signalType: "conclusion",
      },
      {
        id: "agent-plan",
        authorKind: "agent",
        authorID: "board-product-lead",
        authorName: "产品负责人",
        role: "product_lead",
        body: "先验证核心用户路径，再决定是否扩展。",
        created: 3,
        signalType: "plan",
      },
    ])

    expect(proposal?.id).toBe("agent-plan")
  })

  test("keeps persisted work items and approval gates in one chronological flow", () => {
    const project = {
      project: {
        id: "project-1",
        goal: "Ship a local product",
        title: "Local product",
        status: "awaiting_approval",
        output_dir: "/tmp/project-1",
        created_at: 1,
        updated_at: 30,
      },
      work_items: [
        {
          id: "work-1",
          title: "Research",
          description: "Collect evidence",
          kind: "worker",
          work_type: "research",
          status: "completed",
          created_at: 10,
          updated_at: 20,
        },
      ],
      artifacts: [],
      gates: [
        {
          id: "gate-1",
          kind: "risk_approval",
          status: "pending",
          title: "Approve",
          summary: "Evidence complete",
          requested_at: 30,
        },
      ],
      agent_runs: [],
      usage: {
        companyProjectID: "project-1",
        runCount: 0,
        observedTokens: { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        workItems: [],
      },
    } as unknown as Parameters<typeof projectChatItems>[0]

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
        work_items: [{ kind: "planner", work_type: "decision" }],
      } as unknown as Parameters<typeof projectResumeDescription>[0]),
    ).toBe("可以保留 Charter 和规划失败记录，重新生成动态任务树。")
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
