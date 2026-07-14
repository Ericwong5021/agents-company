import fs from "fs/promises"
import path from "path"
import os from "os"
import { Flock } from "@agents-company/shared/util/flock"
import { resolveAgentCompanyHome } from "@agents-company/shared/global"
import { initWorkspace } from "../workspace/workspace"

const { data, cache, config, state } = resolveAgentCompanyHome()

export const Path = {
  // HOME/USERPROFILE read directly because Bun caches os.homedir() at startup.
  // Tests set these env vars to isolate from the developer's real home.
  get home() {
    return process.env.HOME || process.env.USERPROFILE || os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  cache,
  config,
  state,
}

// Initialize Flock with global state path
Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  initWorkspace(data),
])

const CACHE_VERSION = "21"

const version = await fs.readFile(path.join(Path.cache, "version"), "utf8").catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch {}
  await fs.writeFile(path.join(Path.cache, "version"), CACHE_VERSION)
}

export * as Global from "."
