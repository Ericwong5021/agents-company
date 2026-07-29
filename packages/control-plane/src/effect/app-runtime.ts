import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "./observability"

import { AppFileSystem } from "@agents-company/shared/filesystem"
import { Bus } from "@/bus"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Config } from "@/config"
import { Git } from "@/git"
import { Ripgrep } from "@/file/ripgrep"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Storage } from "@/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider"
import { ProviderAuth } from "@/provider"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { Session } from "@/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { Goal } from "@/session/goal"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrune } from "@/session/prune"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { SessionCheckpoint } from "@/session/checkpoint"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Truncate } from "@/tool"
import { ToolRegistry } from "@/tool"
import { Format } from "@/format"
import { Project } from "@/project"
import { Vcs } from "@/project"
import { Worktree } from "@/worktree"
import { Pty } from "@/pty"
import { Installation } from "@/installation"
import { ShareNext } from "@/share"
import { AgentMessage } from "@/agent-message/agent-message"
import { AgentRun } from "@/agent-run/agent-run"
import { AgentRunSupervisor } from "@/agent-run/supervisor"
import { AuditEvent } from "@/audit-event/audit-event"
import { SessionShare } from "@/share"
import { Npm } from "@/npm"
import { ActorRegistry } from "@/actor/registry"
import { ActorWaiter } from "@/actor/waiter"
import { Actor } from "@/actor/spawn"
import { TaskRegistry } from "@/task/registry"
import { WorkflowRuntime } from "@/workflow/runtime"
import { History } from "@/history"
import { Memory } from "@/memory"
import { CompanyAgent } from "@/company-agent"
import { Company } from "@/company"
import { DecisionLedger } from "@/founder-os"
import { LocalAuth } from "@/local-auth"
import { GroupSession } from "@/group-session"
import { Conversation } from "@/conversation"
import { ConversationCommand } from "@/conversation/command"
import { ConversationRuntime } from "@/conversation/runtime"
import {
  CompanyProject,
  CompanyProjectDirection,
  CompanyProjectExecution,
  CompanyOutcomeSignal,
  CompanyProjectRecovery,
} from "@/company-project"
import { CompanyRecruitment } from "@/company-recruitment"
import { ProjectOrchestrator } from "@/project-orchestrator/project-orchestrator"
import { ProjectActionExecutor } from "@/project-orchestrator/project-action-executor"
import { Thread } from "@/thread/thread"
import { Org } from "@/org"
import { defaultLayer as ReputationLayer } from "@/reputation/reputation"
import { TokenGovernance } from "@/token-governance/token-governance"
import { TrustDial } from "@/trust-dial/trust-dial"
import * as BashInteractive from "@/tool/bash-interactive"
import { memoMap } from "./memo-map"

// Wrapped in Layer.suspend so the cross-module `.defaultLayer` reads defer to
// first use instead of running at module load — same TDZ fix as Actor.defaultLayer.
export const AppLayer = Layer.suspend(() => {
  const bus = Bus.defaultLayer
  const groupSession = GroupSession.defaultLayer
  const conversation = Conversation.defaultLayer
  const conversationRuntime = ConversationRuntime.layer.pipe(
    Layer.provide(Layer.mergeAll(groupSession, bus, conversation)),
  )
  return Layer.mergeAll(
    Npm.defaultLayer,
    AppFileSystem.defaultLayer,
    bus,
    Auth.defaultLayer,
    Account.defaultLayer,
    Config.defaultLayer,
    Git.defaultLayer,
    Ripgrep.defaultLayer,
    File.defaultLayer,
    FileWatcher.defaultLayer,
    Storage.defaultLayer,
    Snapshot.defaultLayer,
    Plugin.defaultLayer,
    Provider.defaultLayer,
    ProviderAuth.defaultLayer,
    Agent.defaultLayer,
    Skill.defaultLayer,
    Discovery.defaultLayer,
    Question.defaultLayer,
    Permission.defaultLayer,
    Todo.defaultLayer,
    Session.defaultLayer,
    SessionStatus.defaultLayer,
    SessionRunState.defaultLayer,
    Goal.defaultLayer,
    SessionProcessor.defaultLayer,
    SessionCompaction.defaultLayer,
    SessionPrune.defaultLayer,
    SessionRevert.defaultLayer,
    SessionSummary.defaultLayer,
    SessionPrompt.defaultLayer,
    SessionCheckpoint.defaultLayer,
    Instruction.defaultLayer,
    LLM.defaultLayer,
    LSP.defaultLayer,
    MCP.defaultLayer,
    McpAuth.defaultLayer,
    Command.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    Format.defaultLayer,
    Project.defaultLayer,
    Vcs.defaultLayer,
    Worktree.defaultLayer,
    Pty.defaultLayer,
    Installation.defaultLayer,
    ShareNext.defaultLayer,
    SessionShare.defaultLayer,
    ActorRegistry.defaultLayer,
    ActorWaiter.defaultLayer,
    Actor.defaultLayer,
    TaskRegistry.defaultLayer,
    WorkflowRuntime.defaultLayer,
    Memory.defaultLayer,
    History.defaultLayer,
    CompanyAgent.defaultLayer,
    Company.defaultLayer,
    DecisionLedger.defaultLayer,
    LocalAuth.defaultLayer,
    groupSession,
    conversation,
    conversationRuntime,
    ConversationCommand.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          conversation,
          conversationRuntime,
          bus,
          Company.defaultLayer,
          Git.defaultLayer,
          Project.defaultLayer,
        ),
      ),
    ),
    CompanyProject.recoveryControlledLayer,
    CompanyProjectRecovery.defaultLayer,
    CompanyRecruitment.defaultLayer,
    CompanyProjectExecution.defaultLayer,
    CompanyProjectDirection.defaultLayer,
    CompanyOutcomeSignal.defaultLayer,
    ProjectActionExecutor.defaultLayer,
    ProjectOrchestrator.defaultLayer,
    Thread.defaultLayer,
    AgentMessage.defaultLayer,
    AgentRun.defaultLayer,
    AgentRunSupervisor.layer.pipe(Layer.provide(AgentRun.defaultLayer)),
    AuditEvent.defaultLayer,
    Org.defaultLayer,
    ReputationLayer,
    TokenGovernance.defaultLayer,
    TrustDial.defaultLayer,
  ).pipe(Layer.provideMerge(Observability.layer), Layer.provideMerge(BashInteractive.defaultLayer))
})

const rt = ManagedRuntime.make(AppLayer as Layer.Layer<any, never, never>, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}
