import { describe, expect, test } from "bun:test"
import {
  buildOfficeModel,
  flattenCollaborationNodes,
  formatTokens,
} from "../../../src/cli/cmd/tui/feature-plugins/nav/workstation-model"

describe("workstation office model", () => {
  test("combines presence, project block, and token stats", () => {
    const model = buildOfficeModel({
      agents: [
        { id: "ceo", name: "CEO", org_layer: "board", department: "board" },
        { id: "exec", name: "Executor", org_layer: "execution", department: "engineering" },
      ],
      statuses: { ceo: "idle", exec: "busy" },
      threads: [],
      workstation: {
        project: {
          id: "proj_1",
          blocked: true,
          blocked_reason: "Token runaway",
          blocked_by_agent_id: "ceo",
          time_blocked: 123,
        },
        agents: [
          {
            id: "ceo",
            name: "CEO",
            org_layer: "board",
            status: "idle",
            threads: [],
          },
          {
            id: "exec",
            name: "Executor",
            org_layer: "execution",
            status: "busy",
            threads: [
              {
                id: "thread_1",
                kind: "primary",
                status: "active",
                task_summary: "Build feature",
                budget_tokens: 1000,
                spent_tokens: 345,
              },
            ],
          },
        ],
        summary: {
          total_agents: 2,
          active_agents: 1,
          total_threads: 1,
          open_tasks: 1,
          pending_approvals: 1,
        },
        approvals: [
          {
            id: "message_approval",
            from_agent_id: "exec",
            to_agent_id: "ceo",
            task_summary: "Build feature",
            body: "Approval required",
            depth: 1,
            time_created: 123,
          },
        ],
        collaboration_trees: [
          {
            root_need_id: "need_tree",
            total_messages: 2,
            max_depth: 1,
            nodes: [
              {
                id: "message_root",
                kind: "request",
                from_agent_id: "ceo",
                to_agent_id: "exec",
                task_summary: "Build feature",
                depth: 0,
                time_created: 100,
                children: [
                  {
                    id: "message_reply",
                    kind: "reply",
                    from_agent_id: "exec",
                    to_agent_id: "ceo",
                    outcome: "needs_approval",
                    depth: 1,
                    time_created: 120,
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
      tokenStats: {
        trackedSpentTokens: 345,
        observedTokens: {
          total: 123,
          input: 50,
          output: 40,
          reasoning: 20,
          cacheRead: 10,
          cacheWrite: 3,
          cost: 0.25,
        },
      },
    })

    expect(model.summary).toMatchObject({
      totalAgents: 2,
      activeAgents: 1,
      totalThreads: 1,
      openTasks: 1,
      trackedTokens: 345,
      observedTokens: 123,
      blocked: true,
      pendingApprovals: 1,
    })
    expect(model.approvals).toHaveLength(1)
    expect(model.collaborationTrees).toHaveLength(1)
    expect(flattenCollaborationNodes(model.collaborationTrees[0].nodes).map((row) => row.level)).toEqual([0, 1])
    expect(model.presence).toEqual({ idle: 1, busy: 1, paused: 0 })
    expect(model.agents.find((agent) => agent.id === "exec")?.threads[0]).toMatchObject({
      description: "Build feature",
      spentTokens: 345,
      budgetTokens: 1000,
    })
  })

  test("falls back to local thread state when workstation status is unavailable", () => {
    const model = buildOfficeModel({
      agents: [{ id: "agent_1", name: "Agent One" }],
      statuses: { agent_1: "busy" },
      threads: [
        {
          id: "thread_1",
          agentID: "agent_1",
          kind: "reactive",
          status: "active",
          spentTokens: 1200,
        },
      ],
    })

    expect(model.summary).toMatchObject({
      totalAgents: 1,
      activeAgents: 1,
      totalThreads: 1,
      openTasks: 0,
      trackedTokens: 1200,
      blocked: false,
    })
    expect(model.agents[0].totalTokens).toBe(1200)
  })
})

describe("formatTokens", () => {
  test("formats compact token counts", () => {
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(1200)).toBe("1.2k")
    expect(formatTokens(1_500_000)).toBe("1.5M")
  })
})
