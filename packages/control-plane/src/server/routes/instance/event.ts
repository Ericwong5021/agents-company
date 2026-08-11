import z from "zod"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Log } from "@/util"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { AsyncQueue } from "@/util/queue"
import { Instance } from "@/project/instance"

const log = Log.create({ service: "server" })

// Cap on buffered SSE events per connection. Bounds worst-case memory for a
// stalled consumer while tolerating normal streaming bursts (the heaviest
// producer is per-token PartDelta during streaming). At ~1KB/event the default
// is ≈10MB worst-case per stalled connection. Tune via env if needed.
//
// Note: the heartbeat and the disconnect sentinel also travel through this
// queue. Under sustained saturation (drop-oldest active) both lag behind up to
// EVENT_QUEUE_CAPACITY buffered items, so heartbeats no longer arrive on a
// strict 10s cadence for that connection. This is acceptable: a saturated
// stream is not the idle-stream case the heartbeat exists to keep alive, and a
// proxy that drops the stalled connection just triggers the durable /sync
// catch-up path on reconnect.
const EVENT_QUEUE_CAPACITY = Number(process.env["AGENTCOMPANY_EVENT_QUEUE_CAPACITY"]) || 10_000
const EVENT_REPLAY_CAPACITY = Number(process.env["AGENTCOMPANY_EVENT_REPLAY_CAPACITY"]) || 2_000

type RetainedEvent = {
  id: string
  sequence: number
  type: string
  data: string
}

type ReplayHub = {
  sequence: number
  replay: RetainedEvent[]
  listeners: Set<(event: RetainedEvent) => void>
  unsubscribe: () => void
}

const replayHubs = new Map<string, ReplayHub>()

function replayHub(directory: string) {
  const current = replayHubs.get(directory)
  if (current) return current
  const hub: ReplayHub = {
    sequence: 0,
    replay: [],
    listeners: new Set<(event: RetainedEvent) => void>(),
    unsubscribe: () => {},
  }
  hub.unsubscribe = Bus.subscribeAll((event) => {
    const retained = {
      id: String(hub.sequence + 1),
      sequence: hub.sequence + 1,
      type: event.type,
      data: JSON.stringify(event),
    }
    hub.sequence = retained.sequence
    hub.replay.push(retained)
    if (hub.replay.length > EVENT_REPLAY_CAPACITY)
      hub.replay.splice(0, hub.replay.length - EVENT_REPLAY_CAPACITY)
    hub.listeners.forEach((listener) => listener(retained))
    if (event.type !== Bus.InstanceDisposed.type) return
    queueMicrotask(() => {
      hub.unsubscribe()
      replayHubs.delete(directory)
    })
  })
  replayHubs.set(directory, hub)
  return hub
}

export const EventRoutes = () =>
  new Hono().get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description: "Get events",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(
                z.union(BusEvent.payloads()).meta({
                  ref: "Event",
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      log.info("event connected")
      c.header("Cache-Control", "no-cache, no-transform")
      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")
      const hub = replayHub(Instance.directory)
      const lastEventID = c.req.header("Last-Event-ID")
      return streamSSE(c, async (stream) => {
        const q = new AsyncQueue<{ data: string; id?: string } | null>({ capacity: EVENT_QUEUE_CAPACITY })
        let done = false
        const cutoff = hub.sequence
        const live = (event: RetainedEvent) => {
          if (event.sequence <= cutoff) return
          q.push({ id: event.id, data: event.data })
          if (event.type === Bus.InstanceDisposed.type) stop()
        }
        hub.listeners.add(live)

        const parsedLastEventID = lastEventID && /^\d+$/.test(lastEventID) ? Number(lastEventID) : undefined
        const earliestSequence = hub.replay[0]?.sequence ?? hub.sequence + 1
        const replayAvailable =
          parsedLastEventID !== undefined &&
          parsedLastEventID <= cutoff &&
          parsedLastEventID >= earliestSequence - 1
        if (replayAvailable)
          hub.replay
            .filter((event) => event.sequence > parsedLastEventID && event.sequence <= cutoff)
            .forEach((event) => q.push({ id: event.id, data: event.data }))

        q.push(
          { data: JSON.stringify({
            type: "server.connected",
            properties: {},
          }) },
        )

        // Send heartbeat every 10s to prevent stalled proxy streams.
        const heartbeat = setInterval(() => {
          q.push(
            { data: JSON.stringify({
              type: "server.heartbeat",
              properties: {},
            }) },
          )
        }, 10_000)

        const stop = () => {
          if (done) return
          done = true
          clearInterval(heartbeat)
          hub.listeners.delete(live)
          q.push(null)
          if (q.dropped > 0) log.warn("event dropped under backpressure", { dropped: q.dropped })
          log.info("event disconnected", { buffered: q.size })
        }

        stream.onAbort(stop)

        try {
          for await (const event of q) {
            if (event === null) return
            await stream.writeSSE({ data: event.data, id: event.id })
          }
        } finally {
          stop()
        }
      })
    },
  )
