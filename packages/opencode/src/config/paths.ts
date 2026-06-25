export * as ConfigPaths from "./paths"

import path from "path"
import { Filesystem } from "@/util"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { unique } from "remeda"
import { JsonError } from "./error"
import * as Effect from "effect/Effect"
import { AppFileSystem } from "@agents-company/shared/filesystem"

export const directories = Effect.fn("ConfigPaths.directories")(function* (_directory: string, _worktree?: string) {
  return unique([
    Global.Path.config,
    ...(Flag.AGENTCOMPANY_CONFIG_DIR ? [Flag.AGENTCOMPANY_CONFIG_DIR] : []),
  ])
})

export const files = Effect.fn("ConfigPaths.files")(function* (
  name: string,
  _directory?: string,
  _worktree?: string,
) {
  return [
    ...fileInDirectory(Global.Path.config, name),
    ...(Flag.AGENTCOMPANY_CONFIG_DIR ? fileInDirectory(Flag.AGENTCOMPANY_CONFIG_DIR, name) : []),
  ]
})

export function isLocalConfigDir(dir: string) {
  return dir === Global.Path.config || dir === Flag.AGENTCOMPANY_CONFIG_DIR
}

export const claudeCommandDirectories = Effect.fn("ConfigPaths.claudeCommandDirectories")(function* (
  directory: string,
  worktree?: string,
) {
  if (Flag.AGENTCOMPANY_DISABLE_CLAUDE_CODE_COMMANDS) return []
  const afs = yield* AppFileSystem.Service
  return unique([
    path.join(Global.Path.home, ".claude"),
    ...(!Flag.AGENTCOMPANY_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".claude"],
          start: directory,
          stop: worktree,
        })
      : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}

/** Read a config file, returning undefined for missing files and throwing JsonError for other failures. */
export async function readFile(filepath: string) {
  return Filesystem.readText(filepath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return
    throw new JsonError({ path: filepath }, { cause: err })
  })
}
