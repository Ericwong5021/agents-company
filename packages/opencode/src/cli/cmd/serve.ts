import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless agentcompany server",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    const server = await Server.listen(opts)
    console.log(`agentcompany server listening on http://${server.hostname}:${server.port}`)
    if (opts.noAuth) {
      console.warn("Warning: authentication is disabled; this server is unauthenticated.")
    } else if (server.credentials) {
      const response = await fetch(new URL("/local-auth/pairings", server.url), {
        method: "POST",
        headers: {
          authorization: Server.authorization(server.credentials),
          "content-type": "application/json",
        },
        body: JSON.stringify({ label: "Browser" }),
      })
      if (!response.ok) throw new Error("Unable to create browser pairing")
      const pairing = (await response.json()) as { pairing_url: string }
      console.log(pairing.pairing_url)
    }

    await new Promise(() => {})
    await server.stop()
  },
})
