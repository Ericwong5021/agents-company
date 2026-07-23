import { describe, it, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  delegate,
  propose,
  canDelegate,
  MAX_DELEGATION_DEPTH,
  messageAgent,
  reply,
  drainUnread,
} from "../../src/agent-message/primitives"
import { CompanyAgent } from "../../src/company-agent"
import { AgentMessage } from "../../src/agent-message/agent-message"
import * as Admission from "../../src/admission/admission"
import * as Reputation from "../../src/reputation/reputation"
import { TaskRegistry } from "../../src/task/registry"
import { Delegation } from "../../src/delegation/delegation"
import { AuditEvent } from "../../src/audit-event/audit-event"
import { TrustDial } from "../../src/trust-dial/trust-dial"
import { FrontMatter, Workspace } from "../../src/workspace"
import type { CompanyAgentID } from "../../src/company-agent/schema"
import type { SessionID } from "../../src/session/schema"
import type { Task } from "../../src/task/schema"

// ---------------------------------------------------------------------------
// Mock CompanyAgent service
// ---------------------------------------------------------------------------

function makeMockCompanyAgentService(agents: CompanyAgent.Info[]) {
  return CompanyAgent.Service.of({
    create: () => Effect.die("unexpected create"),
    get: (id: CompanyAgentID) => Effect.succeed(agents.find((a) => a.id === id)),
    list: () => Effect.succeed(agents),
    update: () => Effect.die("unexpected update"),
    assign: () => Effect.die("unexpected assign"),
    release: () => Effect.die("unexpected release"),
    promote: () => Effect.die("unexpected promote"),
    archive: () => Effect.die("unexpected archive"),
    remove: () => Effect.die("unexpected remove"),
  })
}

// ---------------------------------------------------------------------------
// Mock AgentMessage service — collects created messages for assertion
// ---------------------------------------------------------------------------

interface RecordedMessage {
  fromAgentID: string
  toAgentID: string
  kind: string
  body: string
  taskSummary?: string
  depth: number
  rootNeedID?: string
  threadID?: string
  inReplyTo?: string
  outcome?: string
  spawnedIssueID?: string
  id?: string
  read: boolean
  time: { created: number; updated: number }
}

function makeMockAgentMessageService(recorded: RecordedMessage[]) {
  let counter = 0
  return AgentMessage.Service.of({
    create: (input) => {
      counter++
      const id = input.id ?? `msg_${counter}`
      const time = { created: Date.now(), updated: Date.now() }
      recorded.push({
        id,
        fromAgentID: input.fromAgentID,
        toAgentID: input.toAgentID,
        kind: input.kind,
        body: input.body,
        taskSummary: input.taskSummary,
        depth: input.depth ?? 0,
        rootNeedID: input.rootNeedID,
        threadID: input.threadID,
        inReplyTo: input.inReplyTo,
        outcome: input.outcome,
        spawnedIssueID: input.spawnedIssueID,
        read: false,
        time,
      })
      return Effect.succeed({
        id,
        fromAgentID: input.fromAgentID,
        toAgentID: input.toAgentID,
        kind: input.kind,
        body: input.body,
        taskSummary: input.taskSummary,
        depth: input.depth ?? 0,
        rootNeedID: input.rootNeedID,
        threadID: input.threadID,
        inReplyTo: input.inReplyTo,
        outcome: input.outcome,
        spawnedIssueID: input.spawnedIssueID,
        read: false,
        time,
      } as AgentMessage.Info)
    },
    get: (id: string) => {
      const found = recorded.find((m) => m.id === id)
      if (!found) return Effect.succeed(undefined)
      return Effect.succeed({
        ...found,
        id: found.id!,
        read: found.read,
        time: found.time,
      } as AgentMessage.Info)
    },
    updateSpawnedIssue: (id: string, spawnedIssueID: string) => {
      const found = recorded.find((m) => m.id === id)
      if (!found) return Effect.die(new Error(`mock updateSpawnedIssue: not found id="${id}"`))
      found.spawnedIssueID = spawnedIssueID
      found.time = { ...found.time, updated: Date.now() }
      return Effect.succeed(found as AgentMessage.Info)
    },
    updateOutcome: (input) => {
      const found = recorded.find((m) => m.id === input.id)
      if (!found) return Effect.die(new Error(`mock updateOutcome: not found id="${input.id}"`))
      found.outcome = input.outcome
      found.read = input.read ?? true
      found.time = { ...found.time, updated: Date.now() }
      return Effect.succeed(found as AgentMessage.Info)
    },
    listByAgent: (agentId, opts) =>
      Effect.succeed(
        recorded
          .filter((msg) => msg.toAgentID === agentId)
          .filter((msg) => (opts?.unreadOnly ? !msg.read : true))
          .filter((msg) => (opts?.kind ? msg.kind === opts.kind : true))
          .sort((a, b) => b.time.created - a.time.created)
          .slice(0, opts?.limit ?? 1000)
          .map((msg) => msg as AgentMessage.Info),
      ),
    listPendingApprovals: (opts) =>
      Effect.succeed(
        recorded
          .filter((msg) => msg.kind === "reply" && msg.outcome === "needs_approval")
          .sort((a, b) => b.time.created - a.time.created)
          .slice(0, opts?.limit ?? 100)
          .map((msg) => msg as AgentMessage.Info),
      ),
    listByRootNeed: () => Effect.succeed([]),
    markRead: (id: string) => {
      const found = recorded.find((m) => m.id === id)
      if (!found) return Effect.die(new Error(`mock markRead: not found id="${id}"`))
      found.read = true
      found.time = { ...found.time, updated: Date.now() }
      return Effect.succeed(found as AgentMessage.Info)
    },
    getByThread: () => Effect.succeed([]),
  })
}

// ---------------------------------------------------------------------------
// Mock TaskRegistry service
// ---------------------------------------------------------------------------

function makeMockTaskRegistryService(tasks: Task[] = []) {
  return TaskRegistry.Service.of({
    create: (input) => {
      const now = Date.now()
      const task: Task = {
        id: `T${tasks.length + 1}`,
        session_id: input.session_id,
        parent_task_id: input.parent_id,
        status: "open",
        summary: input.summary,
        owner: input.owner,
        created_at: now,
        last_event_at: now,
      }
      tasks.push(task)
      return Effect.succeed(task)
    },
    list: () => Effect.succeed(tasks),
    get: (input) => Effect.succeed(tasks.find((task) => task.session_id === input.session_id && task.id === input.id)),
    start: () => Effect.die("noop" as any),
    block: () => Effect.die("noop" as any),
    unblock: () => Effect.die("noop" as any),
    done: () => Effect.die("noop" as any),
    abandon: () => Effect.die("noop" as any),
    rename: () => Effect.die("noop" as any),
    events: () => Effect.die("noop" as any),
  })
}

const mockTaskRegistryImpl = TaskRegistry.Service.of({
  create: () => Effect.die("noop" as any),
  list: () => Effect.succeed([]),
  get: () => Effect.succeed(undefined),
  start: () => Effect.die("noop" as any),
  block: () => Effect.die("noop" as any),
  unblock: () => Effect.die("noop" as any),
  done: () => Effect.die("noop" as any),
  abandon: () => Effect.die("noop" as any),
  rename: () => Effect.die("noop" as any),
  events: () => Effect.die("noop" as any),
})

interface ReputationUpdate {
  agentID: string
  passed: boolean
  findings: { severity: "blocker" | "warning" | "info" }[]
  taskRating: "company" | "project" | "individual"
}

function makeMockReputationService(updates: ReputationUpdate[] = [], initialScores: Record<string, number> = {}) {
  const scores = new Map<string, number>(Object.entries(initialScores))
  const info = (agentID: string) => ({
    id: `rep_${agentID}`,
    agentID,
    score: scores.get(agentID) ?? 0,
    time: { created: Date.now(), updated: Date.now() },
  })
  return Reputation.Service.of({
    get: (agentID) => Effect.succeed(info(agentID)),
    update: (input) => {
      scores.set(input.agentID, (scores.get(input.agentID) ?? 0) + input.scoreChange)
      return Effect.succeed(info(input.agentID))
    },
    getHistory: () => Effect.succeed([]),
    updateFromAdmission: (agentID, passed, findings, taskRating) => {
      updates.push({ agentID, passed, findings, taskRating })
      const ratingWeight = taskRating === "company" ? 2 : taskRating === "project" ? 1.5 : 1
      const findingPenalty = findings.reduce(
        (total, finding) => total + (finding.severity === "blocker" ? 5 : finding.severity === "warning" ? 2 : 0),
        0,
      )
      scores.set(
        agentID,
        (scores.get(agentID) ?? 0) + (passed ? 10 * ratingWeight : -5 * ratingWeight) - findingPenalty,
      )
      return Effect.succeed(info(agentID))
    },
  })
}

function provideDelegation(
  agentSvc: CompanyAgent.Interface,
  msgSvc: AgentMessage.Interface,
  reputationSvc = makeMockReputationService(),
  taskSvc = mockTaskRegistryImpl,
) {
  const reputationLayer = Layer.succeed(Reputation.Service, reputationSvc)
  return Delegation.layer.pipe(
    Layer.provide(Layer.succeed(CompanyAgent.Service, agentSvc)),
    Layer.provide(Layer.succeed(AgentMessage.Service, msgSvc)),
    Layer.provide(reputationLayer),
    Layer.provide(TrustDial.layer.pipe(Layer.provide(reputationLayer))),
    Layer.provide(Layer.succeed(TaskRegistry.Service, taskSvc)),
    Layer.provide(Admission.defaultLayer),
  )
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const runtimeDefaults = {
  lifecycle: "employee" as const,
  preferred_runtime: "pi",
}

const boardAgent: CompanyAgent.Info = {
  ...runtimeDefaults,
  id: "board-lead" as CompanyAgentID,
  name: "Board Lead",
  org_layer: "board",
  department: undefined,
  reports_to: undefined,
  responsibilities: undefined,
  time: { created: Date.now(), updated: Date.now() },
}

const departmentAgent: CompanyAgent.Info = {
  ...runtimeDefaults,
  id: "dept-head" as CompanyAgentID,
  name: "Department Head",
  org_layer: "department",
  department: "engineering",
  reports_to: "board-lead",
  responsibilities: undefined,
  time: { created: Date.now(), updated: Date.now() },
}

const projectAgent: CompanyAgent.Info = {
  ...runtimeDefaults,
  id: "proj-manager" as CompanyAgentID,
  name: "Project Manager",
  org_layer: "project",
  department: "engineering",
  reports_to: "dept-head",
  responsibilities: undefined,
  time: { created: Date.now(), updated: Date.now() },
}

const executionAgent: CompanyAgent.Info = {
  ...runtimeDefaults,
  id: "executor" as CompanyAgentID,
  name: "Executor",
  org_layer: "execution",
  department: "engineering",
  reports_to: "proj-manager",
  responsibilities: undefined,
  time: { created: Date.now(), updated: Date.now() },
}

const toolAgent: CompanyAgent.Info = {
  ...runtimeDefaults,
  id: "tool-bot" as CompanyAgentID,
  name: "Tool Bot",
  org_layer: "tool",
  department: "engineering",
  reports_to: "executor",
  responsibilities: undefined,
  time: { created: Date.now(), updated: Date.now() },
}

const allAgents = [boardAgent, departmentAgent, projectAgent, executionAgent, toolAgent]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("message_agent and unread delivery", () => {
  it("messageAgent resolves a target by name and creates an unread FYI", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)

    const result = await Effect.runPromise(
      messageAgent(
        {
          fromId: "board-lead",
          toId: "department head",
          body: "Please review the new roadmap.",
          threadID: "thr_strategy",
          rootNeedID: "need_strategy",
        },
        agentSvc,
        msgSvc,
      ),
    )

    expect(result.toAgentID).toBe(departmentAgent.id)
    expect(result.toAgentName).toBe("Department Head")
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      fromAgentID: "board-lead",
      toAgentID: "dept-head",
      kind: "fyi",
      body: "Please review the new roadmap.",
      threadID: "thr_strategy",
      rootNeedID: "need_strategy",
      read: false,
    })
  })

  it("reply sends an unread message back to the original requester", async () => {
    const recorded: RecordedMessage[] = []
    const msgSvc = makeMockAgentMessageService(recorded)
    const original = await Effect.runPromise(
      msgSvc.create({
        fromAgentID: "board-lead",
        toAgentID: "dept-head",
        kind: "request",
        body: "Prepare a launch plan.",
        taskSummary: "Launch plan",
        threadID: "thr_launch",
        rootNeedID: "need_launch",
        depth: 2,
      }),
    )

    const result = await Effect.runPromise(
      reply(
        {
          fromId: "dept-head",
          originalMessageId: original.id,
          body: "Launch plan is ready.",
          outcome: "completed",
        },
        msgSvc,
      ),
    )

    expect(result.toAgentID).toBe("board-lead")
    expect(result.inReplyTo).toBe(original.id)
    expect(recorded[1]).toMatchObject({
      fromAgentID: "dept-head",
      toAgentID: "board-lead",
      kind: "reply",
      body: "Launch plan is ready.",
      inReplyTo: original.id,
      threadID: "thr_launch",
      rootNeedID: "need_launch",
      depth: 2,
      outcome: "completed",
      read: false,
    })
  })

  it("drainUnread renders context and marks messages as read", async () => {
    const recorded: RecordedMessage[] = []
    const msgSvc = makeMockAgentMessageService(recorded)
    const first = await Effect.runPromise(
      msgSvc.create({
        fromAgentID: "board-lead",
        toAgentID: "dept-head",
        kind: "fyi",
        body: "Board note.",
      }),
    )
    await Effect.runPromise(
      msgSvc.create({
        fromAgentID: "proj-manager",
        toAgentID: "dept-head",
        kind: "request",
        body: "Can you review this?",
        taskSummary: "Review request",
      }),
    )
    await Effect.runPromise(
      msgSvc.create({
        fromAgentID: "board-lead",
        toAgentID: "executor",
        kind: "fyi",
        body: "Not for department head.",
      }),
    )

    const block = await Effect.runPromise(drainUnread("dept-head", msgSvc))

    expect(block).toContain("## Unread messages (2)")
    expect(block).toContain("[fyi] from=board-lead")
    expect(block).toContain("Board note.")
    expect(block).toContain("Task: Review request")
    expect((await Effect.runPromise(msgSvc.get(first.id)))?.read).toBe(true)
    expect(await Effect.runPromise(msgSvc.listByAgent("dept-head", { unreadOnly: true }))).toHaveLength(0)
    expect(await Effect.runPromise(msgSvc.listByAgent("executor", { unreadOnly: true }))).toHaveLength(1)
  })
})

describe("delegate: message creation", () => {
  it("creates message with correct depth", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)

    const result = await Effect.runPromise(
      delegate(
        {
          fromId: "dept-head",
          toId: "proj-manager",
          body: "Please implement feature X",
          taskSummary: "Implement feature X",
          depth: 2,
        },
        agentSvc,
        msgSvc,
      ),
    )

    expect(result.depth).toBe(3) // input depth (2) + 1
    expect(recorded).toHaveLength(1)
    expect(recorded[0].depth).toBe(2) // stored depth is input, not input+1
    expect(recorded[0].kind).toBe("request")
    expect(recorded[0].body).toBe("Please implement feature X")
  })

  it("defaults depth to 0 when not specified", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)

    const result = await Effect.runPromise(
      delegate(
        {
          fromId: "dept-head",
          toId: "proj-manager",
          body: "Do the thing",
          taskSummary: "The thing",
        },
        agentSvc,
        msgSvc,
      ),
    )

    expect(result.depth).toBe(1) // 0 + 1
    expect(recorded[0].depth).toBe(0)
  })
})

describe("delegate: depth limit enforcement", () => {
  it("rejects delegation at max depth (depth=5)", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)

    const exit = await Effect.runPromise(
      delegate(
        {
          fromId: "dept-head",
          toId: "proj-manager",
          body: "Too deep",
          taskSummary: "Deep task",
          depth: MAX_DELEGATION_DEPTH,
        },
        agentSvc,
        msgSvc,
      ).pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("max delegation depth")
    }
    expect(recorded).toHaveLength(0)
  })

  it("allows delegation at depth=4 (one below max)", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)

    const result = await Effect.runPromise(
      delegate(
        {
          fromId: "dept-head",
          toId: "proj-manager",
          body: "Almost at limit",
          taskSummary: "Almost deep",
          depth: MAX_DELEGATION_DEPTH - 1,
        },
        agentSvc,
        msgSvc,
      ),
    )

    expect(result.depth).toBe(MAX_DELEGATION_DEPTH)
    expect(recorded).toHaveLength(1)
  })
})

describe("delegate: self-delegation rejection", () => {
  it("rejects delegation to self", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)

    const exit = await Effect.runPromise(
      delegate(
        {
          fromId: "dept-head",
          toId: "dept-head",
          body: "Do my own work",
          taskSummary: "Self-task",
        },
        agentSvc,
        msgSvc,
      ).pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("cannot delegate to self")
    }
    expect(recorded).toHaveLength(0)
  })
})

describe("delegate: org_layer validation", () => {
  it("rejects skip-level delegation", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)

    const exit = await Effect.runPromise(
      delegate(
        {
          fromId: "board-lead",
          toId: "proj-manager",
          body: "Skip directly to project",
          taskSummary: "Skip-level delegation",
        },
        agentSvc,
        msgSvc,
      ).pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("exactly one org layer below")
    }
    expect(recorded).toHaveLength(0)
  })

  it("tool agent cannot delegate to execution agent", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)

    // tool(4) -> execution(3) is blocked (tool has no lower authority)
    const exit = await Effect.runPromise(
      delegate(
        {
          fromId: "tool-bot",
          toId: "executor",
          body: "Do this for me",
          taskSummary: "Tool task",
        },
        agentSvc,
        msgSvc,
      ).pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("cannot delegate")
    }
    expect(recorded).toHaveLength(0)
  })

  it("execution agent cannot delegate to execution agent (same layer)", async () => {
    const execAgent2: CompanyAgent.Info = {
      ...executionAgent,
      id: "executor-2" as CompanyAgentID,
      name: "Executor 2",
    }
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService([...allAgents, execAgent2])
    const msgSvc = makeMockAgentMessageService(recorded)

    const exit = await Effect.runPromise(
      delegate(
        {
          fromId: "executor",
          toId: "executor-2",
          body: "Peer task",
          taskSummary: "Peer delegation",
        },
        agentSvc,
        msgSvc,
      ).pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("propose: creates upward message", () => {
  it("propose sends message to superior (reports_to)", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)

    const result = await Effect.runPromise(
      propose(
        {
          fromId: "proj-manager",
          body: "We should adopt TypeScript 6",
          rationale: "Better type inference reduces bugs by 30%",
          depth: 1,
        },
        agentSvc,
        msgSvc,
      ),
    )

    // proj-manager reports_to dept-head
    expect(result.toAgentID).toBe("dept-head" as CompanyAgentID)
    expect(result.toAgentName).toBe("Department Head")
    expect(result.depth).toBe(2) // input depth (1) + 1

    expect(recorded).toHaveLength(1)
    expect(recorded[0].kind).toBe("proposal")
    expect(recorded[0].toAgentID).toBe("dept-head")
    expect(recorded[0].body).toContain("TypeScript 6")
    expect(recorded[0].body).toContain("Better type inference")
  })

  it("propose fails when agent has no superior", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)

    const exit = await Effect.runPromise(
      propose(
        {
          fromId: "board-lead", // board has no reports_to
          body: "Strategic pivot",
          rationale: "Market shift",
        },
        agentSvc,
        msgSvc,
      ).pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("no superior")
    }
    expect(recorded).toHaveLength(0)
  })
})

describe("proposal resolution", () => {
  it("adopts an upward proposal into an executable task", async () => {
    const recorded: RecordedMessage[] = []
    const tasks: Task[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)
    const taskSvc = makeMockTaskRegistryService(tasks)

    const proposal = await Effect.runPromise(
      msgSvc.create({
        id: "msg_proposal_adopt",
        fromAgentID: "proj-manager",
        toAgentID: "dept-head",
        kind: "proposal",
        body: "Run a production-readiness experiment\n\n**Rationale:** reduce release risk",
        taskSummary: "Production-readiness experiment",
        threadID: "thr_governance",
        rootNeedID: "need_governance",
        depth: 2,
      }),
    )
    const delegationSvc = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Delegation.Service
      }).pipe(Effect.provide(provideDelegation(agentSvc, msgSvc, makeMockReputationService(), taskSvc))),
    )

    const result = await Effect.runPromise(
      delegationSvc.resolveProposal({
        proposalMessage: proposal,
        resolverAgentID: "dept-head",
        decision: "adopt",
        reason: "The experiment is within department scope and has clear risk reduction value.",
        sessionID: "ses_proposal" as SessionID,
      }),
    )

    expect(result.decision).toBe("adopt")
    expect(result.task).toMatchObject({
      id: "T1",
      session_id: "ses_proposal",
      status: "open",
      summary: "Production-readiness experiment",
      owner: "proj-manager",
    })
    expect(tasks).toHaveLength(1)
    expect(result.reply).toMatchObject({
      fromAgentID: "dept-head",
      toAgentID: "proj-manager",
      kind: "reply",
      inReplyTo: "msg_proposal_adopt",
      threadID: "thr_governance",
      rootNeedID: "need_governance",
      depth: 2,
      outcome: "adopted",
    })
    expect(result.reply.body).toContain("Proposal adopted")
    expect(result.reply.body).toContain("Task: T1")
  })

  it("rejects a proposal without creating a task", async () => {
    const recorded: RecordedMessage[] = []
    const tasks: Task[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)
    const taskSvc = makeMockTaskRegistryService(tasks)

    const proposal = await Effect.runPromise(
      msgSvc.create({
        id: "msg_proposal_reject",
        fromAgentID: "proj-manager",
        toAgentID: "dept-head",
        kind: "proposal",
        body: "Replace the release process immediately",
        threadID: "thr_governance",
        rootNeedID: "need_governance",
        depth: 2,
      }),
    )
    const delegationSvc = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Delegation.Service
      }).pipe(Effect.provide(provideDelegation(agentSvc, msgSvc, makeMockReputationService(), taskSvc))),
    )

    const result = await Effect.runPromise(
      delegationSvc.resolveProposal({
        proposalMessage: proposal,
        resolverAgentID: "dept-head",
        decision: "reject",
        reason: "Too disruptive for the current release window.",
        sessionID: "ses_proposal" as SessionID,
      }),
    )

    expect(result.task).toBeUndefined()
    expect(tasks).toHaveLength(0)
    expect(result.reply.outcome).toBe("reject")
    expect(result.reply.body).toContain("Proposal rejected")
    expect(result.reply.body).toContain("Too disruptive")
  })

  it("prevents non-recipients from resolving a proposal", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)

    const proposal = await Effect.runPromise(
      msgSvc.create({
        id: "msg_proposal_wrong_resolver",
        fromAgentID: "proj-manager",
        toAgentID: "dept-head",
        kind: "proposal",
        body: "Pilot a smaller release checklist",
        depth: 1,
      }),
    )
    const delegationSvc = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Delegation.Service
      }).pipe(Effect.provide(provideDelegation(agentSvc, msgSvc))),
    )

    const exit = await Effect.runPromise(
      delegationSvc
        .resolveProposal({
          proposalMessage: proposal,
          resolverAgentID: "board-lead",
          decision: "adopt",
          reason: "Trying to bypass the DRI.",
          sessionID: "ses_proposal" as SessionID,
        })
        .pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("cannot resolve proposal")
    }
  })
})

describe("DRI decision recording", () => {
  it("records a DRI decision with reputation-weighted advisory votes and dissent minutes", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-company-decision-"))
    const previousWorkspaceRoot = (() => {
      try {
        return Workspace.workspaceRoot()
      } catch {
        return undefined
      }
    })()
    try {
      await Workspace.initWorkspace(dataDir)
      const recorded: RecordedMessage[] = []
      const agentSvc = makeMockCompanyAgentService(allAgents)
      const msgSvc = makeMockAgentMessageService(recorded)
      const reputationSvc = makeMockReputationService([], {
        "proj-manager": 15,
        executor: 3,
        "dept-head": 8,
      })
      const delegationSvc = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* Delegation.Service
        }).pipe(Effect.provide(provideDelegation(agentSvc, msgSvc, reputationSvc))),
      )

      const result = await Effect.runPromise(
        delegationSvc.recordDecision({
          domain: "release-governance",
          question: "How should we handle the release gate?",
          driAgentID: "dept-head",
          selectedOptionID: "staged",
          options: [
            { id: "staged", title: "Ship through a staged release gate" },
            { id: "freeze", title: "Freeze release until all work is rechecked" },
          ],
          rationale: "DRI accepts staged release because it preserves momentum while reducing blast radius.",
          rootNeedID: "need_release_decision",
          currentRound: 2,
          maxRounds: 2,
          votes: [
            {
              agentID: "proj-manager",
              optionID: "staged",
              rationale: "Project risk is manageable with staged rollout.",
            },
            {
              agentID: "executor",
              optionID: "freeze",
              rationale: "Execution confidence is still low.",
            },
          ],
        }),
      )

      expect(result.selectedOptionID).toBe("staged")
      expect(result.advisoryTotals).toMatchObject({ staged: 15, freeze: 3 })
      expect(result.dissent).toHaveLength(1)
      expect(result.dissent[0]).toMatchObject({
        agentID: "executor",
        optionID: "freeze",
        reputationScore: 3,
        weight: 3,
      })
      expect(result.minutesPath).toContain(path.join("workspace", "public", "minutes"))

      const minutes = await Bun.file(result.minutesPath).text()
      expect(FrontMatter.parseFrontMatter(minutes).frontMatter).toMatchObject({
        scope: "org",
        classification: "internal",
        owner: "dept-head",
        updatedBy: "dept-head",
      })
      expect(minutes).toContain("DRI: Department Head (dept-head)")
      expect(minutes).toContain("Selected: staged")
      expect(minutes).toContain("staged, weight 15")
      expect(minutes).toContain("executor) supported freeze")
      expect(minutes).toContain("need_release_decision")
    } finally {
      if (previousWorkspaceRoot) await Workspace.initWorkspace(path.dirname(previousWorkspaceRoot))
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it("rejects decisions whose selected option is not declared", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)
    const delegationSvc = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Delegation.Service
      }).pipe(Effect.provide(provideDelegation(agentSvc, msgSvc))),
    )

    const exit = await Effect.runPromise(
      delegationSvc
        .recordDecision({
          domain: "release-governance",
          question: "Pick a release policy",
          driAgentID: "dept-head",
          selectedOptionID: "missing",
          options: [{ id: "staged", title: "Staged rollout" }],
          rationale: "Invalid test case.",
        })
        .pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain('selected option "missing"')
    }
  })
})

describe("canDelegate: org layer hierarchy", () => {
  it("allows delegation only to the exact next layer", () => {
    expect(canDelegate("board", "department")).toBe(true)
    expect(canDelegate("department", "project")).toBe(true)
    expect(canDelegate("project", "execution")).toBe(true)
    expect(canDelegate("execution", "tool")).toBe(true)
  })

  it("blocks skip-level delegation", () => {
    expect(canDelegate("board", "project")).toBe(false)
    expect(canDelegate("board", "execution")).toBe(false)
    expect(canDelegate("board", "tool")).toBe(false)
    expect(canDelegate("department", "execution")).toBe(false)
    expect(canDelegate("department", "tool")).toBe(false)
    expect(canDelegate("project", "tool")).toBe(false)
  })

  it("department cannot delegate to board or department", () => {
    expect(canDelegate("department", "board")).toBe(false)
    expect(canDelegate("department", "department")).toBe(false)
  })

  it("execution can delegate to tool but not to same/higher layer", () => {
    expect(canDelegate("execution", "tool")).toBe(true)
    expect(canDelegate("execution", "execution")).toBe(false)
    expect(canDelegate("execution", "project")).toBe(false)
  })

  it("tool cannot delegate to anyone", () => {
    expect(canDelegate("tool", "tool")).toBe(false)
    expect(canDelegate("tool", "execution")).toBe(false)
    expect(canDelegate("tool", "board")).toBe(false)
  })
})

describe("admission grading", () => {
  it("submitForAdmission gates a passing project submission until trust is high enough", async () => {
    const recorded: RecordedMessage[] = []
    const reputationUpdates: ReputationUpdate[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)
    const reputationSvc = makeMockReputationService(reputationUpdates)

    const request = await Effect.runPromise(
      msgSvc.create({
        id: "msg_review_accept",
        fromAgentID: "dept-head",
        toAgentID: "proj-manager",
        kind: "request",
        body: "Prepare release plan",
        taskSummary: "Release plan",
        threadID: "thr_release",
        rootNeedID: "need_release",
        depth: 1,
      }),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const delegationSvc = yield* Delegation.Service
        const result = yield* delegationSvc.submitForAdmission({
          delegationMessage: request,
          submission: {
            kind: "coding",
            testsPassed: true,
            lintClean: true,
            buildSucceeds: true,
          },
        })
        const auditSvc = yield* AuditEvent.Service
        const auditEvents = yield* auditSvc.listByRootNeed("need_release")
        expect(auditEvents.some((event) => event.kind === "admission" && event.action === "needs_approval")).toBe(true)
        return result
      }).pipe(
        Effect.provide(provideDelegation(agentSvc, msgSvc, reputationSvc)),
        Effect.provide(AuditEvent.defaultLayer),
      ),
    )

    expect(result.accepted).toBe(true)
    expect(result.admission.taskRating).toBe("project")
    expect(result.reputation).toMatchObject({ agentID: "proj-manager", score: 15 })
    expect(result.trust).toMatchObject({
      agentID: "proj-manager",
      level: "standard",
      approvalRequired: true,
      minimumApprovals: 1,
      autoAdmissionAllowed: false,
    })
    expect(reputationUpdates).toEqual([
      {
        agentID: "proj-manager",
        passed: true,
        findings: [],
        taskRating: "project",
      },
    ])
    expect(result.reply).toMatchObject({
      fromAgentID: "proj-manager",
      toAgentID: "dept-head",
      kind: "reply",
      inReplyTo: request.id,
      threadID: "thr_release",
      rootNeedID: "need_release",
      depth: 1,
      outcome: "needs_approval",
    })
    expect(result.reply.body).toContain("Approval required: 1")
  })

  it("submitForAdmission rejects a failing submission with actionable findings", async () => {
    const recorded: RecordedMessage[] = []
    const reputationUpdates: ReputationUpdate[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)
    const reputationSvc = makeMockReputationService(reputationUpdates)

    const request = await Effect.runPromise(
      msgSvc.create({
        id: "msg_review_reject",
        fromAgentID: "dept-head",
        toAgentID: "proj-manager",
        kind: "request",
        body: "Prepare release plan",
        taskSummary: "Release plan",
        threadID: "thr_release",
        rootNeedID: "need_release",
        depth: 1,
      }),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const delegationSvc = yield* Delegation.Service
        const result = yield* delegationSvc.submitForAdmission({
          delegationMessage: request,
          submission: {
            kind: "coding",
            testsPassed: false,
            lintClean: true,
            buildSucceeds: true,
            testOutput: "unit tests failed",
          },
        })
        const auditSvc = yield* AuditEvent.Service
        const auditEvents = yield* auditSvc.listByRootNeed("need_release")
        expect(auditEvents.some((event) => event.kind === "admission" && event.action === "failed")).toBe(true)
        return result
      }).pipe(
        Effect.provide(provideDelegation(agentSvc, msgSvc, reputationSvc)),
        Effect.provide(AuditEvent.defaultLayer),
      ),
    )

    expect(result.accepted).toBe(false)
    expect(result.trust.approvalRequired).toBe(false)
    expect(result.trust.autoAdmissionAllowed).toBe(false)
    expect(result.admission.findings.some((finding) => finding.item === "Tests failing")).toBe(true)
    expect(result.reputation.agentID).toBe("proj-manager")
    expect(result.reputation.score).toBeLessThan(0)
    expect(reputationUpdates).toHaveLength(1)
    expect(reputationUpdates[0]).toMatchObject({
      agentID: "proj-manager",
      passed: false,
      taskRating: "project",
    })
    expect(reputationUpdates[0].findings.some((finding) => finding.severity === "blocker")).toBe(true)
    expect(result.reply.outcome).toBe("failed")
    expect(result.reply.body).toContain("Submission rejected")
    expect(result.reply.body).toContain("How to verify")
  })

  it("submitForAdmission auto-admits trusted project work", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)
    const reputationSvc = makeMockReputationService([], { "proj-manager": 20 })

    const request = await Effect.runPromise(
      msgSvc.create({
        id: "msg_review_trusted",
        fromAgentID: "dept-head",
        toAgentID: "proj-manager",
        kind: "request",
        body: "Prepare release plan",
        taskSummary: "Release plan",
        threadID: "thr_release",
        rootNeedID: "need_release_trusted",
        depth: 1,
      }),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const delegationSvc = yield* Delegation.Service
        return yield* delegationSvc.submitForAdmission({
          delegationMessage: request,
          submission: {
            kind: "coding",
            testsPassed: true,
            lintClean: true,
            buildSucceeds: true,
          },
        })
      }).pipe(
        Effect.provide(provideDelegation(agentSvc, msgSvc, reputationSvc)),
        Effect.provide(AuditEvent.defaultLayer),
      ),
    )

    expect(result.reputation.score).toBe(35)
    expect(result.trust).toMatchObject({
      level: "trusted",
      approvalRequired: false,
      autoAdmissionAllowed: true,
    })
    expect(result.reply.outcome).toBe("success")
    expect(result.reply.body).toContain("Auto-admitted: yes")
  })
})

describe("escalation after failed approaches", () => {
  it("handleFailure returns retry when attemptCount < MAX_APPROACH_ATTEMPTS", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)

    const delegationSvc = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Delegation.Service
      }).pipe(Effect.provide(provideDelegation(agentSvc, msgSvc))),
    )

    const result = await Effect.runPromise(
      delegationSvc.handleFailure({
        agentId: "executor",
        originalGoal: "Build the feature",
        rootNeedID: "need-1",
        originalMessageId: "msg-1",
        error: "Compilation failed",
        attemptCount: 0,
        approaches: [],
      }),
    )

    expect(result.action).toBe("retry")
    if (result.action === "retry") {
      expect(result.nextAttemptCount).toBe(1)
      expect(result.retryInstruction).toContain("FUNDAMENTALLY DIFFERENT approach")
      expect(result.retryInstruction).toContain("Compilation failed")
    }
  })

  it("handleFailure returns escalate when attemptCount >= MAX_APPROACH_ATTEMPTS", async () => {
    const recorded: RecordedMessage[] = []
    const agentSvc = makeMockCompanyAgentService(allAgents)
    const msgSvc = makeMockAgentMessageService(recorded)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const delegationSvc = yield* Delegation.Service
        const result = yield* delegationSvc.handleFailure({
          agentId: "executor",
          originalGoal: "Build the feature",
          rootNeedID: "need-1",
          originalMessageId: "msg-1",
          error: "Still failing after retry",
          attemptCount: 2, // >= MAX_APPROACH_ATTEMPTS (2)
          approaches: [
            {
              approach: "compile-fix",
              description: "Attempted to fix compilation errors",
              findings: "Missing import statement",
              timestamp: Date.now(),
            },
            {
              approach: "rewrite-module",
              description: "Rewrote the module from scratch",
              findings: "Type conflicts with shared schema",
              timestamp: Date.now(),
            },
          ],
        })
        const auditSvc = yield* AuditEvent.Service
        const auditEvents = yield* auditSvc.listByRootNeed("need-1")
        expect(auditEvents.some((event) => event.kind === "escalation" && event.action === "escalated")).toBe(true)
        return result
      }).pipe(Effect.provide(provideDelegation(agentSvc, msgSvc)), Effect.provide(AuditEvent.defaultLayer)),
    )

    expect(result.action).toBe("escalate")
    if (result.action === "escalate") {
      // executor reports_to proj-manager
      expect(result.superiorId).toBe("proj-manager")
      expect(result.superiorName).toBe("Project Manager")
      expect(result.escalationMessageId).toBeTruthy()
    }

    // Verify escalation message was created
    const escalationMsg = recorded.find((m) => m.outcome === "escalated")
    expect(escalationMsg).toBeDefined()
    expect(escalationMsg!.kind).toBe("reply")
    expect(escalationMsg!.toAgentID).toBe("proj-manager")
    expect(escalationMsg!.body).toContain("Escalation from Executor")
  })
})
