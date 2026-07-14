import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"

export const directory = path.join(Global.Path.data, "bootstrap-runtime")

async function run<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> {
  const { AppRuntime } = await import("@/effect/app-runtime")
  return AppRuntime.runPromise(effect)
}

export const provide = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const source = yield* InstanceRef
    return yield* Effect.promise(async () => {
      await fs.mkdir(directory, { recursive: true })
      return Instance.provide({
        directory,
        configDirectory: source?.configDirectory ?? source?.directory,
        init: () => run(InstanceBootstrap),
        fn: () => run(self),
      })
    })
  })

export const dispose = Effect.promise(async () => {
  await fs.mkdir(directory, { recursive: true })
  return Instance.provide({
    directory,
    fn: () => Instance.dispose(),
  })
})
