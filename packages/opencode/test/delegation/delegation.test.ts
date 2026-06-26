import { describe, it, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { delegate, propose, canDelegate, MAX_DELEGATION_DEPTH } from "../../src/agent-message/primitives"
import { CompanyAgent } from "../../src/company-agent"
import { AgentMessage } from "../../src/agent-message/agent-message"
import { TaskRegistry } from "../../src/task/registry"
import { Delegation } from "../../src/delegation/delegation"
import type { CompanyAgentID } from "../../src/company-agent/schema"

// ---------------------------------------------------------------------------
// Mock CompanyAgent service
// ---------------------------------------------------------------------------

function makeMockCompanyAgentService(agents: CompanyAgent.Info[]) {
  return CompanyAgent.Service.of({
    create: () => Effect.die("unexpected create"),
    get: (id: CompanyAgentID) => Effect.succeed(agents.find((a) => a.id === id)),
    list: () => Effect.succeed(agents),
    update: () => Effect.die("unexpected update"),
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
}

function makeMockAgentMessageService(recorded: RecordedMessage[]) {
  let counter = 0
  return AgentMessage.Service.of({
    create: (input) => {
      counter++
      const id = input.id ?? `msg_${counter}`
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
        time: { created: Date.now(), updated: Date.now() },
      } as AgentMessage.Info)
    },
    get: (id: string) => {
      const found = recorded.find((m) => m.id === id)
      if (!found) return Effect.succeed(undefined)
      return Effect.succeed({
        ...found,
        id: found.id!,
        read: false,
        time: { created: Date.now(), updated: Date.now() },
      } as AgentMessage.Info)
    },
    listByAgent: () => Effect.succeed([]),
    listByRootNeed: () => Effect.succeed([]),
    markRead: (id: string) =>
      Effect.succeed({
        id,
        fromAgentID: "",
        toAgentID: "",
        kind: "fyi" as const,
        body: "",
        depth: 0,
        read: true,
        time: { created: Date.now(), updated: Date.now() },
      } as AgentMessage.Info),
    getByThread: () => Effect.succeed([]),
  })
}

// ---------------------------------------------------------------------------
// Mock TaskRegistry service
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const boardAgent: CompanyAgent.Info = {
  id: "board-lead" as CompanyAgentID,
  name: "Board Lead",
  org_layer: "board",
  department: undefined,
  reports_to: undefined,
  responsibilities: undefined,
  time: { created: Date.now(), updated: Date.now() },
}

const departmentAgent: CompanyAgent.Info = {
  id: "dept-head" as CompanyAgentID,
  name: "Department Head",
  org_layer: "department",
  department: "engineering",
  reports_to: "board-lead",
  responsibilities: undefined,
  time: { created: Date.now(), updated: Date.now() },
}

const projectAgent: CompanyAgent.Info = {
  id: "proj-manager" as CompanyAgentID,
  name: "Project Manager",
  org_layer: "project",
  department: "engineering",
  reports_to: "dept-head",
  responsibilities: undefined,
  time: { created: Date.now(), updated: Date.now() },
}

const executionAgent: CompanyAgent.Info = {
  id: "executor" as CompanyAgentID,
  name: "Executor",
  org_layer: "execution",
  department: "engineering",
  reports_to: "proj-manager",
  responsibilities: undefined,
  time: { created: Date.now(), updated: Date.now() },
}

const toolAgent: CompanyAgent.Info = {
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

describe("canDelegate: org layer hierarchy", () => {
  it("board can delegate to anyone", () => {
    expect(canDelegate("board", "department")).toBe(true)
    expect(canDelegate("board", "project")).toBe(true)
    expect(canDelegate("board", "execution")).toBe(true)
    expect(canDelegate("board", "tool")).toBe(true)
  })

  it("department can delegate to project, execution, tool", () => {
    expect(canDelegate("department", "project")).toBe(true)
    expect(canDelegate("department", "execution")).toBe(true)
    expect(canDelegate("department", "tool")).toBe(true)
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
  it("admission evaluates result as accepted", () => {
    const admissionResult = { accepted: true, findings: [] as string[] }
    expect(admissionResult.accepted).toBe(true)
    expect(admissionResult.findings).toHaveLength(0)
  })

  it("admission evaluates result as rejected with findings", () => {
    const admissionResult = {
      accepted: false,
      findings: ["Missing error handling", "No unit tests provided"],
    }
    expect(admissionResult.accepted).toBe(false)
    expect(admissionResult.findings).toHaveLength(2)
    expect(admissionResult.findings[0]).toBe("Missing error handling")
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
      }).pipe(
        Effect.provide(
          Delegation.layer.pipe(
            Layer.provide(Layer.succeed(CompanyAgent.Service, agentSvc)),
            Layer.provide(Layer.succeed(AgentMessage.Service, msgSvc)),
            Layer.provide(Layer.succeed(TaskRegistry.Service, mockTaskRegistryImpl)),
          ),
        ),
      ),
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

    const delegationSvc = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Delegation.Service
      }).pipe(
        Effect.provide(
          Delegation.layer.pipe(
            Layer.provide(Layer.succeed(CompanyAgent.Service, agentSvc)),
            Layer.provide(Layer.succeed(AgentMessage.Service, msgSvc)),
            Layer.provide(Layer.succeed(TaskRegistry.Service, mockTaskRegistryImpl)),
          ),
        ),
      ),
    )

    const result = await Effect.runPromise(
      delegationSvc.handleFailure({
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
      }),
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
