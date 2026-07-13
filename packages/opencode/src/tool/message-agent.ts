import * as Tool from "./tool"
import DESCRIPTION from "./message-agent.txt"
import z from "zod"
import { Effect } from "effect"
import { messageAgent, delegate, propose, reply } from "@/agent-message/primitives"
import { AgentMessage } from "@/agent-message/agent-message"
import { CompanyAgent } from "@/company-agent"
import { spawnRef } from "@/actor/spawn-ref"

const id = "message_agent"

const fyiOperation = z.strictObject({
  action: z.literal("fyi"),
  to: z.string().min(1).describe("Target agent ID or name."),
  body: z.string().min(1).describe("Message body."),
  thread_id: z.string().optional().describe("Thread ID for conversation tracking."),
  root_need_id: z.string().optional().describe("Root need ID for delegation chains."),
})

const delegateOperation = z.strictObject({
  action: z.literal("delegate"),
  to: z.string().min(1).describe("Target agent ID or name."),
  body: z.string().min(1).describe("Delegation request body."),
  task_summary: z.string().min(1).describe("Summary of the delegated task."),
  thread_id: z.string().optional().describe("Thread ID for conversation tracking."),
  root_need_id: z.string().optional().describe("Root need ID for delegation chains."),
  depth: z.number().int().min(0).optional().describe("Current delegation depth (default 0)."),
  auto_spawn: z.boolean().optional().describe("Auto-spawn an actor to handle the delegated task (default false)."),
})

const proposeOperation = z.strictObject({
  action: z.literal("propose"),
  body: z.string().min(1).describe("The proposal content."),
  rationale: z.string().min(1).describe("Why this proposal should be adopted."),
  thread_id: z.string().optional().describe("Thread ID for conversation tracking."),
  root_need_id: z.string().optional().describe("Root need ID for delegation chains."),
  depth: z.number().int().min(0).optional().describe("Current proposal depth (default 0)."),
})

const replyOperation = z.strictObject({
  action: z.literal("reply"),
  original_message_id: z.string().min(1).describe("ID of the message being replied to."),
  body: z.string().min(1).describe("Reply body."),
  outcome: z.string().optional().describe("Outcome of the request (for replies to requests)."),
})

const parameters = z.strictObject({
  operation: z
    .discriminatedUnion("action", [fyiOperation, delegateOperation, proposeOperation, replyOperation])
    .meta({ type: "object" }),
})

type MessageAgentInput = z.infer<typeof parameters>

type Metadata = {
  action?: string
  messageID?: string
  toAgentID?: string
  spawnedActorID?: string
}

export const MessageAgentTool = Tool.define<typeof parameters, Metadata, AgentMessage.Service | CompanyAgent.Service>(
  id,
  Effect.gen(function* () {
    const agentMessageSvc = yield* AgentMessage.Service
    const companyAgentSvc = yield* CompanyAgent.Service

    return {
      description: DESCRIPTION,
      parameters,
      execute: (args: MessageAgentInput, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const op = args.operation

          if (op.action === "fyi") {
            const result = yield* messageAgent(
              {
                fromId: ctx.companyAgentID ?? ctx.agent,
                toId: op.to,
                body: op.body,
                threadID: op.thread_id,
                rootNeedID: op.root_need_id,
              },
              companyAgentSvc,
              agentMessageSvc,
            )
            return {
              title: `Message sent to ${result.toAgentName}`,
              output: `FYI message sent to ${result.toAgentName} (${result.toAgentID}). Message ID: ${result.messageID}`,
              metadata: { action: "fyi", messageID: result.messageID, toAgentID: result.toAgentID } as Metadata,
            }
          }

          if (op.action === "delegate") {
            const result = yield* delegate(
              {
                fromId: ctx.companyAgentID ?? ctx.agent,
                toId: op.to,
                body: op.body,
                taskSummary: op.task_summary,
                threadID: op.thread_id,
                rootNeedID: op.root_need_id,
                depth: op.depth,
              },
              companyAgentSvc,
              agentMessageSvc,
            )

            let spawnedActorID: string | undefined
            if (op.auto_spawn) {
              const actor = spawnRef.current
              if (actor) {
                const spawned = yield* actor.spawnForDelegation({
                  spawn: {
                    sessionID: ctx.sessionID as any,
                    agentType: result.toAgentID,
                    companyAgentID: result.toAgentID,
                    task: op.body,
                    context: "none",
                    tools: "INHERIT",
                    background: true,
                    parentActorID: ctx.actorID ?? "main",
                    delegationMessageID: result.messageID,
                    depth: result.depth,
                  },
                  delegationContext: {
                    depth: result.depth,
                    rootNeedID: op.root_need_id,
                    taskSummary: op.task_summary,
                  },
                })
                spawnedActorID = spawned.actorID
              }
            }

            const actorSuffix = spawnedActorID ? ` Actor spawned: ${spawnedActorID}.` : ""
            return {
              title: `Delegated to ${result.toAgentName}`,
              output: `Task delegated to ${result.toAgentName} (${result.toAgentID}). Message ID: ${result.messageID}. Task: ${result.taskSummary}. Depth: ${result.depth}.${actorSuffix}`,
              metadata: {
                action: "delegate",
                messageID: result.messageID,
                toAgentID: result.toAgentID,
                ...(spawnedActorID ? { spawnedActorID } : {}),
              } as Metadata,
            }
          }

          if (op.action === "propose") {
            const result = yield* propose(
              {
                fromId: ctx.companyAgentID ?? ctx.agent,
                body: op.body,
                rationale: op.rationale,
                threadID: op.thread_id,
                rootNeedID: op.root_need_id,
                depth: op.depth,
              },
              companyAgentSvc,
              agentMessageSvc,
            )
            return {
              title: `Proposal sent to ${result.toAgentName}`,
              output: `Proposal sent to ${result.toAgentName} (${result.toAgentID}). Message ID: ${result.messageID}. Depth: ${result.depth}`,
              metadata: { action: "propose", messageID: result.messageID, toAgentID: result.toAgentID } as Metadata,
            }
          }

          if (op.action === "reply") {
            const result = yield* reply(
              {
                fromId: ctx.companyAgentID ?? ctx.agent,
                originalMessageId: op.original_message_id,
                body: op.body,
                outcome: op.outcome,
              },
              agentMessageSvc,
            )
            return {
              title: `Reply sent`,
              output: `Reply sent to ${result.toAgentID}. Message ID: ${result.messageID}. In reply to: ${result.inReplyTo}`,
              metadata: { action: "reply", messageID: result.messageID, toAgentID: result.toAgentID } as Metadata,
            }
          }

          return yield* Effect.fail(new Error(`Unknown action: ${(op as { action: string }).action}`))
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
