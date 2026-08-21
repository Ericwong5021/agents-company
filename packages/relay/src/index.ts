import { createRelay, relayOptions } from "./server"

const options = relayOptions()
const relay = createRelay(options)
const server = Bun.serve({
  hostname: options.host,
  port: options.port,
  fetch: relay.app.fetch,
  websocket: relay.websocket,
  idleTimeout: 0,
})

console.log(`Agent Company Relay listening on http://${options.host}:${server.port}`)

const stop = () => {
  relay.close()
  server.stop(true)
  process.exit(0)
}

process.once("SIGINT", stop)
process.once("SIGTERM", stop)
