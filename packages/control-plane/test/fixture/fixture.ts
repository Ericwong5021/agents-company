import { $ } from "bun"
import * as fs from "fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import os from "os"
import path from "path"
import { Effect, Context } from "effect"
import type * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Config, ConfigParse } from "../../src/config"
import { InstanceRef } from "../../src/effect/instance-ref"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { TestLLMServer } from "../lib/llm-server"

// Strip null bytes from paths (defensive fix for CI environment issues)
function sanitizePath(p: string): string {
  return p.replace(/\0/g, "")
}

function exists(dir: string) {
  return fs
    .stat(dir)
    .then(() => true)
    .catch(() => false)
}

async function clean(dir: string) {
  Bun.gc(true)
  await sleep(100)
  await fs.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 30,
    retryDelay: 100,
  })
}

export async function cleanupTmpdir(dir: string, cleanup = clean) {
  return cleanup(dir).catch((error) => {
    throw new Error(
      `Failed to cleanup temporary directory ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  })
}

async function stop(dir: string) {
  if (!(await exists(dir))) return
  await $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow()
}

type TmpDirOptions<T> = {
  git?: boolean
  outsideWorkspace?: boolean
  config?: Partial<Config.Info>
  init?: (dir: string) => Promise<T>
  dispose?: (dir: string) => Promise<T>
}

const providerSettings = [
  "disabled_providers",
  "enabled_providers",
  "model",
  "model_groups",
  "provider",
  "small_model",
  "voice",
] as const

function selectProviderSettings(input?: Partial<Config.Info>) {
  if (!input) return
  const entries = providerSettings.flatMap((key) => (input[key] === undefined ? [] : [[key, input[key]]]))
  if (!entries.length) return
  return Object.fromEntries(entries) as Partial<Config.Info>
}

async function installProviderSettings(input?: Partial<Config.Info>) {
  const settings = selectProviderSettings(input)
  if (!settings) return
  const file = path.join(Global.Path.config, "provider-settings.json")
  const previous = await Bun.file(file)
    .text()
    .catch(() => undefined)
  await fs.mkdir(Global.Path.config, { recursive: true })
  await Bun.write(file, JSON.stringify(settings))
  await AppRuntime.runPromise(Config.Service.use((service) => service.invalidate(true)))
  return async () => {
    if (previous === undefined) await fs.rm(file, { force: true })
    else await Bun.write(file, previous)
    await AppRuntime.runPromise(Config.Service.use((service) => service.invalidate(true)))
  }
}

async function readProjectProviderSettings(dir: string) {
  const file = (
    await Promise.all(
      ["agent-company.json", "agent-company.jsonc"].map(async (name) => {
        const filepath = path.join(dir, name)
        return {
          filepath,
          text: await Bun.file(filepath)
            .text()
            .catch(() => undefined),
        }
      }),
    )
  ).find((candidate) => candidate.text !== undefined)
  if (!file?.text) return
  return selectProviderSettings(ConfigParse.jsonc(file.text, file.filepath) as Partial<Config.Info>)
}

export async function provideProjectProviderSettings(dir: string) {
  const restore = await installProviderSettings(await readProjectProviderSettings(dir))
  return {
    [Symbol.asyncDispose]: async () => restore?.(),
  }
}

export async function tmpdir<T>(options?: TmpDirOptions<T>) {
  const dirpath = sanitizePath(
    path.join(
      options?.outsideWorkspace ? os.tmpdir() : (process.env["AGENTCOMPANY_TEST_TMPDIR_ROOT"] ?? os.tmpdir()),
      "agentcompany-test-" + Math.random().toString(36).slice(2),
    ),
  )
  await fs.mkdir(dirpath, { recursive: true })
  if (options?.git) {
    await $`git init`.cwd(dirpath).quiet()
    await $`git config core.fsmonitor false`.cwd(dirpath).quiet()
    await $`git config commit.gpgsign false`.cwd(dirpath).quiet()
    await $`git config user.email "test@agentcompany.test"`.cwd(dirpath).quiet()
    await $`git config user.name "Test"`.cwd(dirpath).quiet()
    await $`git commit --allow-empty -m "root commit ${dirpath}"`.cwd(dirpath).quiet()
  }
  if (options?.config) {
    await Bun.write(
      path.join(dirpath, "agent-company.json"),
      JSON.stringify({
        $schema: "https://control-plane.ai/config.json",
        ...options.config,
      }),
    )
  }
  const realpath = sanitizePath(await fs.realpath(dirpath))
  const extra = await options?.init?.(realpath)
  const restoreProviderSettings = await installProviderSettings(options?.config)
  const result = {
    [Symbol.asyncDispose]: async () => {
      try {
        await options?.dispose?.(realpath)
      } finally {
        if (options?.git) await stop(realpath).catch(() => undefined)
        await restoreProviderSettings?.()
        await cleanupTmpdir(realpath)
      }
    },
    path: realpath,
    extra: extra as T,
  }
  return result
}

/** Effectful scoped tmpdir. Cleaned up when the scope closes. Make sure these stay in sync */
export function tmpdirScoped(options?: { git?: boolean; outsideWorkspace?: boolean; config?: Partial<Config.Info> }) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const dirpath = sanitizePath(
      path.join(
        options?.outsideWorkspace ? os.tmpdir() : (process.env["AGENTCOMPANY_TEST_TMPDIR_ROOT"] ?? os.tmpdir()),
        "agentcompany-test-" + Math.random().toString(36).slice(2),
      ),
    )
    yield* Effect.promise(() => fs.mkdir(dirpath, { recursive: true }))
    const dir = sanitizePath(yield* Effect.promise(() => fs.realpath(dirpath)))

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (options?.git) await stop(dir).catch(() => undefined)
        await cleanupTmpdir(dir)
      }),
    )

    const git = (...args: string[]) =>
      spawner.spawn(ChildProcess.make("git", args, { cwd: dir })).pipe(Effect.flatMap((handle) => handle.exitCode))

    if (options?.git) {
      yield* git("init")
      yield* git("config", "core.fsmonitor", "false")
      yield* git("config", "commit.gpgsign", "false")
      yield* git("config", "user.email", "test@agentcompany.test")
      yield* git("config", "user.name", "Test")
      yield* git("commit", "--allow-empty", "-m", "root commit")
    }

    if (options?.config) {
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(dir, "agent-company.json"),
          JSON.stringify({ $schema: "https://control-plane.ai/config.json", ...options.config }),
        ),
      )
    }

    return dir
  })
}

export const provideInstance =
  (directory: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.contextWith((services: Context.Context<R>) =>
      Effect.promise<A>(async () =>
        Instance.provide({
          directory,
          fn: () => Effect.runPromiseWith(services)(self.pipe(Effect.provideService(InstanceRef, Instance.current))),
        }),
      ),
    )

export function provideTmpdirInstance<A, E, R>(
  self: (path: string) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; outsideWorkspace?: boolean; config?: Partial<Config.Info> },
) {
  return Effect.gen(function* () {
    const directory = yield* tmpdirScoped(options)
    const settings = selectProviderSettings(options?.config)
    const file = path.join(Global.Path.config, "provider-settings.json")
    const previous = settings
      ? yield* Effect.promise(() =>
          Bun.file(file)
            .text()
            .catch(() => undefined),
        )
      : undefined
    let provided = false

    if (settings) {
      yield* Effect.promise(() => fs.mkdir(Global.Path.config, { recursive: true }))
      yield* Effect.promise(() => Bun.write(file, JSON.stringify(settings)))
      yield* Config.Service.use((service) => service.invalidate(true))
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (previous === undefined) yield* Effect.promise(() => fs.rm(file, { force: true }))
          else yield* Effect.promise(() => Bun.write(file, previous))
          yield* Config.Service.use((service) => service.invalidate(true))
        }).pipe(Effect.ignore),
      )
    }

    yield* Effect.addFinalizer(() =>
      provided
        ? Effect.promise(() =>
            Instance.provide({
              directory,
              fn: () => Instance.dispose(),
            }),
          ).pipe(Effect.ignore)
        : Effect.void,
    )

    provided = true
    return yield* self(directory).pipe(provideInstance(directory))
  })
}

export function provideTmpdirServer<A, E, R>(
  self: (input: { dir: string; llm: TestLLMServer["Service"] }) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; config?: (url: string) => Partial<Config.Info> },
): Effect.Effect<
  A,
  E | PlatformError.PlatformError,
  R | TestLLMServer | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope | Config.Service
> {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    return yield* provideTmpdirInstance((dir) => self({ dir, llm }), {
      git: options?.git,
      config: options?.config?.(llm.url),
    })
  })
}
