import { describe, expect, test } from "bun:test"
import {
  companyReconnectDelay,
  transitionCompanyConnection,
} from "../modules/agent-company/runtime/shared/connection-state"
import {
  classifyControlPlaneFailure,
  controlPlaneURL,
  publicControlPlaneEndpoint,
  requestControlPlane,
} from "../modules/agent-company/runtime/server/utils/control-plane-client"

describe("Control Plane connection state", () => {
  test("uses connecting only for the initial request and recovering for later requests", () => {
    expect(transitionCompanyConnection("connecting", { type: "request_started" })).toBe("connecting")
    expect(transitionCompanyConnection("disconnected", { type: "request_started" })).toBe("recovering")
    expect(transitionCompanyConnection("degraded", { type: "request_started" })).toBe("recovering")
    expect(transitionCompanyConnection("ready", { type: "request_started" })).toBe("recovering")
  })

  test("settles only into server-observed states", () => {
    expect(transitionCompanyConnection("recovering", { type: "snapshot_received", connection: "ready" })).toBe("ready")
    expect(transitionCompanyConnection("recovering", { type: "snapshot_received", connection: "degraded" })).toBe(
      "degraded",
    )
    expect(transitionCompanyConnection("recovering", { type: "snapshot_received", connection: "disconnected" })).toBe(
      "disconnected",
    )
    expect(transitionCompanyConnection("ready", { type: "request_failed" })).toBe("disconnected")
  })

  test("backs off reconnects with a bounded delay", () => {
    expect([0, 1, 2, 3, 4, 8].map(companyReconnectDelay)).toEqual([2_000, 4_000, 8_000, 15_000, 15_000, 15_000])
  })
})

describe("Control Plane diagnostic classification", () => {
  test("distinguishes authorization, service errors, and unreachable services", () => {
    expect(classifyControlPlaneFailure({ statusCode: 401 })).toEqual({
      kind: "authorization_required",
      statusCode: 401,
    })
    expect(classifyControlPlaneFailure({ response: { status: 500 } })).toEqual({
      kind: "service_error",
      statusCode: 500,
    })
    expect(classifyControlPlaneFailure(new Error("connection refused"))).toEqual({
      kind: "service_unreachable",
    })
  })

  test("accepts only canonical credential-free loopback HTTP endpoints", () => {
    expect(controlPlaneURL("http://localhost:4096")?.origin).toBe("http://localhost:4096")
    expect(controlPlaneURL("https://127.42.18.9:4096")?.origin).toBe("https://127.42.18.9:4096")
    expect(controlPlaneURL("http://[::1]:4096")?.origin).toBe("http://[::1]:4096")
    const endpoint = controlPlaneURL("http://127.0.0.1:4096/internal?token=secret")
    expect(endpoint).toBeDefined()
    expect(publicControlPlaneEndpoint(endpoint!)).toBe("http://127.0.0.1:4096")
  })

  test("rejects external, credentialed, and ambiguous Control Plane hosts", () => {
    ;[
      "ftp://127.0.0.1:4096",
      "http://user:secret@127.0.0.1:4096",
      "https://example.com",
      "http://localhost.example.com:4096",
      "http://localhost。example.com:4096",
      "http://127.0.0.1.example.com:4096",
      "http://127.0.0.1.:4096",
      "http://127.1:4096",
      "http://2130706433:4096",
      "http://0x7f000001:4096",
      "http://0177.0.0.1:4096",
      "http://[::ffff:127.0.0.1]:4096",
    ].forEach((value) => expect(controlPlaneURL(value)).toBeUndefined())
  })

  test("does not forward authorization to a rejected lookalike host", async () => {
    let authorization: string | null = null
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorization = request.headers.get("authorization")
        return Response.json({ ok: true })
      },
    })
    const result = await requestControlPlane(`http://127.0.0.1.:${server.port}`, "/company", "Bearer must-not-leave")
    await server.stop(true)
    expect(result).toEqual({ ok: false, failure: { kind: "invalid_configuration" } })
    expect(authorization).toBeNull()
  })
})
