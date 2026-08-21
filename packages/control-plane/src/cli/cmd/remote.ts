import os from "node:os"
import open from "open"
import type { Argv } from "yargs"
import { z } from "zod"
import { cmd } from "./cmd"
import {
  readRemoteAccessConfig,
  removeRemoteAccessConfig,
  RemoteAccessPaths,
  writeRemoteAccessConfig,
} from "../../remote-access/config"

const Authorization = z.object({
  authorization_id: z.string().min(1),
  user_code: z.string().min(1),
  approval_url: z.string().url(),
  expires_at: z.string().datetime(),
})
const AuthorizationStatus = z.object({ status: z.enum(["pending", "approved", "consumed"]) })
const DeviceCredential = z.object({
  status: z.literal("approved"),
  device_id: z.string().min(1),
  device_name: z.string().min(1),
  device_token: z.string().min(32),
})

function relayURL(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname))
    throw new Error("Remote Relay URL must use HTTPS")
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  return url
}

const ConnectCommand = cmd({
  command: "connect",
  describe: "connect this Control Plane to a remote Agent Company Relay",
  builder: (yargs: Argv) =>
    yargs
      .option("url", { type: "string", demandOption: true, describe: "public Agent Company URL" })
      .option("name", { type: "string", default: os.hostname(), describe: "device name shown during approval" }),
  handler: async (args: { url: string; name: string }) => {
    const base = relayURL(args.url)
    const response = await fetch(new URL("/api/v1/remote/device-authorizations", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: args.name }),
    })
    if (!response.ok) throw new Error(`Unable to start remote authorization (${response.status})`)
    const authorization = Authorization.parse(await response.json())
    console.log(`Approve this device in your browser: ${authorization.approval_url}`)
    await open(authorization.approval_url).catch(() => undefined)
    while (Date.parse(authorization.expires_at) > Date.now()) {
      await Bun.sleep(2_000)
      const statusResponse = await fetch(
        new URL(
          `/api/v1/remote/device-authorizations/${encodeURIComponent(authorization.authorization_id)}?code=${encodeURIComponent(authorization.user_code)}`,
          base,
        ),
      )
      if (!statusResponse.ok) throw new Error(`Unable to read remote authorization (${statusResponse.status})`)
      const status = AuthorizationStatus.parse(await statusResponse.json())
      if (status.status !== "approved") continue
      const tokenResponse = await fetch(
        new URL(
          `/api/v1/remote/device-authorizations/${encodeURIComponent(authorization.authorization_id)}/token`,
          base,
        ),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user_code: authorization.user_code }),
        },
      )
      if (!tokenResponse.ok) throw new Error(`Unable to obtain remote device token (${tokenResponse.status})`)
      const credential = DeviceCredential.parse(await tokenResponse.json())
      await writeRemoteAccessConfig({
        relay_url: base.toString(),
        device_id: credential.device_id,
        device_name: credential.device_name,
        device_token: credential.device_token,
      })
      console.log("Remote access is configured. The running Control Plane will connect automatically.")
      return
    }
    throw new Error("Remote authorization expired")
  },
})

const StatusCommand = cmd({
  command: "status",
  describe: "show remote access status",
  handler: async () => {
    const config = await readRemoteAccessConfig()
    const status = await Bun.file(RemoteAccessPaths.status)
      .json()
      .catch(() => undefined)
    console.log(
      JSON.stringify(
        {
          configured: Boolean(config),
          relay_url: config?.relay_url,
          device_id: config?.device_id,
          device_name: config?.device_name,
          runtime: status,
        },
        null,
        2,
      ),
    )
  },
})

const DisconnectCommand = cmd({
  command: "disconnect",
  describe: "disable remote access on this Control Plane",
  handler: async () => {
    const config = await readRemoteAccessConfig()
    const revoked = config
      ? await fetch(
          new URL(`/api/v1/remote/devices/${encodeURIComponent(config.device_id)}/revoke`, config.relay_url),
          {
            method: "POST",
            headers: { authorization: `Bearer ${config.device_token}` },
          },
        )
          .then((response) => response.ok)
          .catch(() => false)
      : true
    await removeRemoteAccessConfig()
    console.log(
      revoked
        ? "Remote access is disabled and the device token is revoked."
        : "Remote access is disabled locally. The Relay could not be reached to revoke the device token.",
    )
  },
})

export const RemoteCommand = cmd({
  command: "remote",
  describe: "manage remote WebUI access",
  builder: (yargs: Argv) =>
    yargs.command(ConnectCommand).command(StatusCommand).command(DisconnectCommand).demandCommand(),
  handler: () => {},
})
