import { chmod, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { Global } from "../global"

const Config = z.object({
  relay_url: z.string().url(),
  device_id: z.string().min(1),
  device_name: z.string().min(1),
  device_token: z.string().min(32),
})

export type RemoteAccessConfig = z.infer<typeof Config>

export const RemoteAccessPaths = {
  config: path.join(Global.Path.config, "remote-access.json"),
  status: path.join(Global.Path.state, "remote-access-status.json"),
}

export async function readRemoteAccessConfig() {
  return Bun.file(RemoteAccessPaths.config)
    .json()
    .then((value) => Config.parse(value))
    .catch(() => undefined)
}

export async function writeRemoteAccessConfig(config: RemoteAccessConfig) {
  const temporary = `${RemoteAccessPaths.config}.${process.pid}.tmp`
  await Bun.write(temporary, `${JSON.stringify(Config.parse(config), null, 2)}\n`)
  await chmod(temporary, 0o600)
  await rename(temporary, RemoteAccessPaths.config)
}

export async function removeRemoteAccessConfig() {
  await unlink(RemoteAccessPaths.config).catch((error) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  })
}
