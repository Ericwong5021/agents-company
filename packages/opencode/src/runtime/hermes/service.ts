import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type { RuntimeAdapter, RuntimeCompiler, RuntimeBindingStore } from "../legacy-interface"
import { HermesProfileCompiler } from "./compiler"
import { HermesRuntimeAdapter } from "./adapter"
import { FileBindingStore } from "./binding-store"
import type { HermesRuntimeConfig } from "./types"

// Service interface
export interface HermesRuntimeInterface {
  readonly compiler: RuntimeCompiler
  readonly adapter: RuntimeAdapter
  readonly bindingStore: RuntimeBindingStore
}

// Service tag
export class HermesRuntime extends Context.Service<HermesRuntime, HermesRuntimeInterface>()(
  "@opencode/HermesRuntime",
) {}

// Layer factory
export const makeHermesRuntimeLayer = (config: HermesRuntimeConfig) => {
  const bindingStore = new FileBindingStore(config.bindingStorePath)
  const compiler = new HermesProfileCompiler(config, bindingStore, process.cwd())
  const adapter = new HermesRuntimeAdapter(config, bindingStore)

  return Layer.succeed(HermesRuntime, {
    compiler,
    adapter,
    bindingStore,
  } satisfies HermesRuntimeInterface)
}

// Default configuration
export const defaultHermesConfig: HermesRuntimeConfig = {
  commandTemplate: "hermes -p <profileName> -z <prompt>",
  defaultTimeout: 300_000,
  profilePrefix: "agentcompany",
  bindingStorePath: ".agentcompany/runtime/hermes/bindings.json",
  cloneModePreferred: true,
}
