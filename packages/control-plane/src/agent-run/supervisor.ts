import path from "path"
import { createHash } from "node:crypto"
import { mkdir, stat } from "node:fs/promises"
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
  extractRuntimeUsage,
  piProviderCredential,
  piProviderModel,
} from "@/runtime"
import type { AgentRunResult } from "@/runtime"
import { Auth } from "@/auth"
import { Provider } from "@/provider"
import { ProviderID } from "@/provider/schema"
import { CapabilityCatalog } from "@/capability"
import { Skill } from "@/skill"
import { listCompanyProjectSummaries } from "@/company-project/read-model"
import { readDoc } from "@/workspace/read-doc"
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

export class Service extends Context.Service<Service, Interface>()("@control-plane/AgentRunSupervisor") {}

async function copyCodexSession(root: string, sessionID: string, targetHome: string) {
  const matches: string[] = []
  for await (const file of new Bun.Glob("*/home/sessions/**/*.jsonl").scan({ cwd: root, onlyFiles: true })) {
    if (path.basename(file).endsWith(`-${sessionID}.jsonl`)) matches.push(file)
  }
  const source = (await Promise.all(matches.map(async (file) => ({ file, modified: (await stat(path.join(root, file))).mtimeMs }))))
    .toSorted((a, b) => a.modified - b.modified)
    .at(-1)?.file
  if (!source) throw new Error(`Runtime session is unavailable for resume: ${sessionID}`)
  const relative = source.match(/(?:^|[\\/])home[\\/](sessions[\\/].+)$/)?.[1]
  if (!relative) throw new Error(`Runtime session path is invalid: ${sessionID}`)
  const target = path.join(targetHome, ...relative.split(/[\\/]/))
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await Bun.write(target, Bun.file(path.join(root, source)))
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const runs = yield* AgentRun.Service
    const auth = yield* Auth.Service
    const provider = yield* Provider.Service
    const skills = yield* Skill.Service
    const loadedSkillSnapshots = new Map<string, Set<string>>()

    const loadSkill = async (spec: AgentRunSpec, name: string) => {
      const available = await Effect.runPromise(skills.available(undefined, spec.agentID))
      const info = available.find((skill) => skill.name === name)
      if (!info) throw new Error(`Skill \"${name}\" is not available to this agent`)
      const checksum = createHash("sha256").update(info.content).digest("hex")
      const version = `sha256-${checksum.slice(0, 12)}`
      const key = `${info.name}@${checksum}`
      const loaded = loadedSkillSnapshots.get(spec.runID) ?? new Set<string>()
      if (!loaded.has(key)) {
        const snapshotPath = path.join(spec.runtimeHome, "skills", `${info.name.replace(/[^a-zA-Z0-9._-]/g, "_")}@${version}.md`)
        await Bun.write(snapshotPath, info.content)
        await Effect.runPromise(
          runs.recordSkillSnapshot({
            runID: spec.runID,
            skillID: info.name,
            version,
            checksum,
            sourcePath: info.location,
            snapshotPath,
            activationReason: "agent",
          }),
        )
        await Effect.runPromise(
          runs.recordEvent({
            runID: spec.runID,
            type: "agent_run.skill_loaded",
            payload: { skillID: info.name, version, checksum, sourcePath: info.location },
          }),
        )
        loaded.add(key)
        loadedSkillSnapshots.set(spec.runID, loaded)
      }
      return [
        `<skill_content name=${JSON.stringify(info.name)}>`,
        info.content.trim(),
        "This skill grants instructions only. Every tool call remains subject to the current run permissions.",
        "</skill_content>",
      ].join("\n")
    }

    const pi = new PiRuntimeAdapter(
      createPiRuntimeEngineFactory({
        resolveModel: async (spec) => {
          const model = spec.model
            ? await Effect.runPromise(provider.resolveModelRef(spec.model))
            : await Effect.runPromise(provider.defaultModel()).then((fallback) =>
                Effect.runPromise(provider.getModel(fallback.providerID, fallback.modelID)),
              )
          const connection = await Effect.runPromise(provider.getProvider(model.providerID))
          return {
            model: piProviderModel(model, connection),
            idleTimeoutMs:
              typeof connection.options.chunkTimeout === "number" ? connection.options.chunkTimeout : undefined,
          }
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
            {
              loadSkill: (name) => loadSkill(spec, name),
              readDoc: (docPath) =>
                Effect.runPromise(readDoc({ agentId: spec.agentID, docPath })).then((result) => ({
                  content: result.content,
                  classification: result.frontMatter.classification,
                })),
              listCompanyProjects: listCompanyProjectSummaries,
              publishSignal: spec.allowSignalPublishing,
            },
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
      const packs = input.capabilityPacks.map((reference) => CapabilityCatalog.resolve(reference))
      const availableSkills = yield* skills.available(undefined, input.agentID)
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
      const runtimeRoot = path.join(Global.Path.data, "runs")
      const home = yield* Effect.promise(() =>
        createRuntimeHome({ root: runtimeRoot, runID: preparedID, runtime: runtime.runtime }),
      )
      if (input.resumeSessionID && runtime.runtime === "codex") {
        yield* Effect.promise(() => copyCodexSession(runtimeRoot, input.resumeSessionID!, home.home))
      }
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
          const usage = extractRuntimeUsage(event.payload)
          if (usage) await Effect.runPromise(runs.recordUsage({ runID: event.runID, source: "runtime", ...usage }))
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
        systemPrompt: [
          input.systemPrompt,
          ...packs.map((pack) => `# ${pack.role}\n${pack.instructions}`),
          Skill.fmt(availableSkills, { verbose: false }),
          "Use the skill tool only when the current task genuinely needs a listed professional procedure. Do not load skills for ordinary conversation.",
          input.allowSignalPublishing
            && runtime.runtime === "pi"
            ? "Use publish_signal only after you have reached a concrete conclusion, plan, status, risk, or intervention worth showing outside this worklog. Publish a plan only when the team has a concrete direction that the owner may choose to turn into a project; ordinary discussion remains ordinary discussion."
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      }, persist)
      const completion = handle.completion.then(async (result) => {
        await writes
        await Effect.runPromise(runs.recordUsage({ runID: result.runID, source: "unavailable" }))
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
        await Effect.runPromise(
          runs.recordRuntimeHome({
            runID: result.runID,
            path: home.root,
            credentialMode: "keychain",
            state: "orphaned",
            disposition: "retain",
          }),
        )
        loadedSkillSnapshots.delete(result.runID)
        return result
      })
      return { runID: run.id, completion }
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
              const state = payload.interrupted === true || run.state === "interrupting"
                ? "stopped"
                : terminal.type === "runtime.completed"
                  ? "completed"
                  : "failed"
              yield* runs.transition({
                id: run.id,
                state,
                sessionID: typeof payload.sessionID === "string" ? payload.sessionID : run.sessionID,
                exitCode:
                  typeof payload.exitCode === "number"
                    ? payload.exitCode
                    : state === "stopped"
                      ? 130
                      : terminal.type === "runtime.completed"
                      ? 0
                      : 1,
                safeErrorSummary:
                  state === "failed"
                    ? "The local coding runtime exited before completing the assigned work."
                    : undefined,
              })
              yield* runs.recordRuntimeHome({
                runID: run.id,
                path: path.dirname(run.runtimeHomePath),
                credentialMode: "keychain",
                state: "orphaned",
                disposition: "retain",
              })
              return
            }
            if (run.state === "interrupting") {
              yield* runs.transition({ id: run.id, state: "stopped", exitCode: 130 })
              yield* runs.recordRuntimeHome({
                runID: run.id,
                path: path.dirname(run.runtimeHomePath),
                credentialMode: "keychain",
                state: "orphaned",
                disposition: "retain",
              })
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
  Layer.provide(Skill.defaultLayer),
)
