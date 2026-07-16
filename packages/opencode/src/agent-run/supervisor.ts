import path from "path"
import { createHash } from "node:crypto"
import z from "zod"
import { Context, Effect, Layer } from "effect"
import { Global } from "@/global"
import { Identifier } from "@/id/id"
import {
  AgentExecutionSupervisor,
  AgentRunSpec,
  PiRuntimeAdapter,
  RuntimeRegistry,
  RuntimeResolver,
  createCliRuntimeAdapter,
  createPiRuntimeEngineFactory,
  createPiTools,
  createRuntimeHome,
  piProviderCredential,
  piProviderModel,
} from "@/runtime"
import type { AgentRunResult } from "@/runtime"
import { Auth } from "@/auth"
import { Provider } from "@/provider"
import { ProviderID } from "@/provider/schema"
import { CapabilityCatalog } from "@/capability"
import { AgentRun } from "./agent-run"

export const StartInput = AgentRunSpec.omit({ runID: true, runtimeHome: true }).extend({
  runID: z.string().optional(),
  groupSessionID: z.string().optional(),
  workflowRunID: z.string().optional(),
  conversationThreadID: z.string().optional(),
  companyProjectID: z.string().optional(),
  workItemID: z.string().optional(),
  worktreeRunID: z.string().optional(),
})
export type StartInput = z.infer<typeof StartInput>

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<{ runID: string; completion: Promise<AgentRunResult> }>
  readonly discover: () => Effect.Effect<Array<{ availability: Awaited<ReturnType<RuntimeRegistry["discover"]>>[number]; capabilities: ReturnType<ReturnType<RuntimeRegistry["list"]>[number]["capabilities"]> }>>
  readonly deliver: (input: { runID: string; content: string; priority: "steer" | "follow_up" }) => Effect.Effect<void>
  readonly interrupt: (runID: string) => Effect.Effect<boolean>
  readonly stop: (runID: string) => Effect.Effect<boolean>
  readonly recover: () => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentRunSupervisor") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const runs = yield* AgentRun.Service
    const auth = yield* Auth.Service
    const provider = yield* Provider.Service
    const pi = new PiRuntimeAdapter(
      createPiRuntimeEngineFactory({
        resolveModel: async (spec) => {
          if (spec.model) {
            const model = await Effect.runPromise(provider.resolveModelRef(spec.model))
            return piProviderModel(model, await Effect.runPromise(provider.getProvider(model.providerID)))
          }
          const fallback = await Effect.runPromise(provider.defaultModel())
          const model = await Effect.runPromise(provider.getModel(fallback.providerID, fallback.modelID))
          return piProviderModel(model, await Effect.runPromise(provider.getProvider(model.providerID)))
        },
        getApiKey: async (providerID) => {
          const [credential, connection] = await Promise.all([
            Effect.runPromise(auth.get(providerID)),
            Effect.runPromise(provider.getProvider(ProviderID.make(providerID))),
          ])
          return piProviderCredential(credential, connection)
        },
        getTools: async (spec) =>
          createPiTools(
            spec,
            spec.capabilityPacks.flatMap((reference) => CapabilityCatalog.resolve(reference).tools),
          ),
      }),
    )
    const registry = new RuntimeRegistry([pi, createCliRuntimeAdapter("codex"), createCliRuntimeAdapter("claude-code")])
    const resolver = new RuntimeResolver(registry)
    const supervisor = new AgentExecutionSupervisor(registry)
    const interrupted = new Set<string>()

    const discover = Effect.fn("AgentRunSupervisor.discover")(function* () {
      const availability = yield* Effect.promise(() => registry.discover())
      return availability.map((item) => ({ availability: item, capabilities: registry.get(item.runtime)!.capabilities() }))
    })

    const start = Effect.fn("AgentRunSupervisor.start")(function* (input: StartInput) {
      if (input.permissionMode === "full_access") {
        return yield* Effect.die(new Error("full_access requires an approval gate before an Agent Run can start"))
      }

      const packs = input.capabilityPacks.map((reference) => CapabilityCatalog.resolve(reference))
      const requiredCapabilities = [...new Set([
        ...input.requiredRuntimeCapabilities,
        ...packs.flatMap((pack) => pack.requiredRuntimeCapabilities),
      ])]
      const runtime = yield* Effect.promise(() =>
        resolver.resolve({ explicitRuntime: input.runtime, requiredCapabilities }),
      )
      const availability = yield* Effect.promise(() => runtime.discover())
      const capabilityChecksum = createHash("sha256")
        .update(packs.map((pack) => `${pack.id}@${pack.version}:${pack.checksum}`).sort().join("\n"))
        .digest("hex")
      const preparedID = input.runID ?? Identifier.ascending("agentRun")
      const home = yield* Effect.promise(() =>
        createRuntimeHome({ root: path.join(Global.Path.data, "runs"), runID: preparedID, runtime: runtime.runtime }),
      )
      const run = yield* runs.create({
        id: preparedID,
        agentID: input.agentID,
        runtime: runtime.runtime,
        runtimeVersion: availability.version,
        workflowVersion: input.workflowVersion,
        capabilityChecksum,
        lifecycle: input.lifecycle,
        permissionMode: input.permissionMode,
        groupSessionID: input.groupSessionID,
        workflowRunID: input.workflowRunID,
        conversationThreadID: input.conversationThreadID,
        companyProjectID: input.companyProjectID,
        workItemID: input.workItemID,
        worktreeRunID: input.worktreeRunID,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        cwd: input.cwd,
        runtimeHomePath: home.home,
        resumeSessionID: input.resumeSessionID,
      })
      yield* runs.recordRuntimeHome({ runID: run.id, path: home.root, credentialMode: "keychain", state: "active" })
      yield* Effect.forEach(
        packs,
        (pack) =>
          Effect.gen(function* () {
            const snapshotPath = path.join(home.skills, `${pack.id}@${pack.version}.json`)
            yield* Effect.promise(() => Bun.write(snapshotPath, JSON.stringify(pack, undefined, 2)))
            yield* runs.recordSkillSnapshot({
              runID: run.id,
              skillID: pack.id,
              version: pack.version,
              checksum: pack.checksum,
              sourcePath: `builtin:capability/${pack.id}@${pack.version}`,
              snapshotPath,
              activationReason: "workflow",
            })
          }),
        { discard: true },
      )
      yield* runs.transition({ id: run.id, state: "starting" })
      yield* runs.recordEvent({
        runID: run.id,
        type: "agent_run.queued",
        payload: { runtime: runtime.runtime, cwd: input.cwd, capabilityPacks: input.capabilityPacks },
      })

      let writes = Promise.resolve()
      const persist = (event: Parameters<typeof supervisor.start>[1] extends (event: infer Event) => void ? Event : never) => {
        writes = writes.then(async () => {
          await Effect.runPromise(runs.recordEvent({ runID: event.runID, type: `runtime.${event.type}`, payload: event.payload }))
          if (event.type === "started" || event.type === "session") {
            await Effect.runPromise(runs.transition({ id: event.runID, state: "running", sessionID: typeof event.payload.sessionID === "string" ? event.payload.sessionID : undefined }))
          }
        })
      }
      const handle = supervisor.start({
        ...input,
        runtime: runtime.runtime,
        runID: run.id,
        runtimeHome: home.home,
        requiredRuntimeCapabilities: requiredCapabilities,
        systemPrompt: [input.systemPrompt, ...packs.map((pack) => `# ${pack.role}\n${pack.instructions}`)]
          .filter(Boolean)
          .join("\n\n"),
      }, persist)
      void handle.completion.then(async (result) => {
        await writes
        const state = interrupted.delete(result.runID) ? "stopped" : result.exitCode === 0 ? "completed" : "failed"
        await Effect.runPromise(
          runs.transition({
            id: result.runID,
            state,
            sessionID: result.sessionID,
            exitCode: result.exitCode,
            safeErrorSummary: state === "failed" ? "The local coding runtime exited before completing the assigned work." : undefined,
          }),
        )
      })
      return { runID: run.id, completion: handle.completion }
    })

    const interrupt = Effect.fn("AgentRunSupervisor.interrupt")(function* (runID: string) {
      const didInterrupt = yield* Effect.promise(() => supervisor.interrupt(runID))
      if (!didInterrupt) return false
      interrupted.add(runID)
      yield* runs.transition({ id: runID, state: "interrupting" })
      yield* runs.recordEvent({ runID, type: "agent_run.interrupt_requested", payload: {} })
      return true
    })

    const deliver = Effect.fn("AgentRunSupervisor.deliver")(function* (input: {
      runID: string
      content: string
      priority: "steer" | "follow_up"
    }) {
      yield* Effect.promise(() => supervisor.deliver(input))
      yield* runs.recordEvent({
        runID: input.runID,
        type: "agent_run.message_delivered",
        payload: { priority: input.priority },
      })
    })

    const stop = Effect.fn("AgentRunSupervisor.stop")(function* (runID: string) {
      const didStop = yield* Effect.promise(() => supervisor.stop(runID))
      if (!didStop) return false
      interrupted.add(runID)
      yield* runs.transition({ id: runID, state: "interrupting" })
      yield* runs.recordEvent({ runID, type: "agent_run.stop_requested", payload: {} })
      return true
    })

    const recover = Effect.fn("AgentRunSupervisor.recover")(function* () {
      const recoverable = yield* runs.listRecoverable()
      yield* Effect.forEach(
        recoverable,
        (run) =>
          Effect.gen(function* () {
            const terminal = (yield* runs.events(run.id)).findLast(
              (event) => event.type === "runtime.completed" || event.type === "runtime.failed",
            )
            if (terminal) {
              const payload = z.record(z.string(), z.unknown()).parse(JSON.parse(terminal.payloadJSON))
              yield* runs.transition({
                id: run.id,
                state: terminal.type === "runtime.completed" ? "completed" : "failed",
                sessionID: typeof payload.sessionID === "string" ? payload.sessionID : run.sessionID,
                exitCode:
                  typeof payload.exitCode === "number"
                    ? payload.exitCode
                    : terminal.type === "runtime.completed"
                      ? 0
                      : 1,
                safeErrorSummary:
                  terminal.type === "runtime.failed"
                    ? "The local coding runtime exited before completing the assigned work."
                    : undefined,
              })
              return
            }
            if (run.state === "interrupting") {
              yield* runs.transition({ id: run.id, state: "stopped", exitCode: 130 })
              return
            }
            yield* runs.transition({ id: run.id, state: "awaiting_recovery" })
            yield* runs.recordRuntimeHome({
              runID: run.id,
              path: path.dirname(run.runtimeHomePath),
              credentialMode: "keychain",
              state: "orphaned",
            })
            yield* runs.recordEvent({
              runID: run.id,
              type: "agent_run.recovery_deferred",
              payload: {
                runtime: run.runtime,
                reason: run.runtime === "pi" ? "pi_session_resume_unavailable" : "runtime_process_not_attached",
              },
            })
          }),
        { discard: true },
      )
      return recoverable.map((run) => run.id)
    })

    return { start, discover, deliver, interrupt, stop, recover }
  }),
)

export * as AgentRunSupervisor from "./supervisor"

export const defaultLayer = layer.pipe(
  Layer.provide(AgentRun.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
)
