import { describe, expect, test } from "bun:test"
import { isTrustedLoopbackRequest, resolveClientIP } from "../server/utils/loopback-request"

const valid = {
  host: "127.0.0.1:3210",
  hostname: "127.0.0.1",
  ip: "127.0.0.1",
  origin: "http://127.0.0.1:3210",
  requestOrigin: "http://127.0.0.1:3210",
}

describe("trusted loopback request", () => {
  test("requires matching loopback Host, socket IP, and Origin", () => {
    expect(isTrustedLoopbackRequest(valid)).toBe(true)
    expect(isTrustedLoopbackRequest({ ...valid, host: "example.test", hostname: "example.test" })).toBe(false)
    expect(isTrustedLoopbackRequest({ ...valid, origin: "http://example.test" })).toBe(false)
    expect(isTrustedLoopbackRequest({ ...valid, origin: undefined })).toBe(false)
    expect(isTrustedLoopbackRequest({ ...valid, ip: "203.0.113.7" })).toBe(false)
    expect(isTrustedLoopbackRequest({ ...valid, ip: undefined })).toBe(false)
    expect(isTrustedLoopbackRequest({ ...valid, host: undefined })).toBe(false)
  })

  test("accepts IPv4-mapped and IPv6 loopback addresses", () => {
    expect(isTrustedLoopbackRequest({ ...valid, ip: "::ffff:127.0.0.1" })).toBe(true)
    expect(
      isTrustedLoopbackRequest({
        host: "[::1]:3210",
        hostname: "[::1]",
        ip: "::1",
        origin: "http://[::1]:3210",
        requestOrigin: "http://[::1]:3210",
      }),
    ).toBe(true)
  })

  test("uses forwarded client IP only behind the Nitro development worker", () => {
    expect(
      resolveClientIP({
        directIP: undefined,
        forwardedIP: "127.0.0.1",
        trustedDevProxy: true,
      }),
    ).toBe("127.0.0.1")
    expect(
      resolveClientIP({
        directIP: undefined,
        forwardedIP: "127.0.0.1",
        trustedDevProxy: false,
      }),
    ).toBeUndefined()
    expect(
      resolveClientIP({
        directIP: "127.0.0.1",
        forwardedIP: "203.0.113.7",
        trustedDevProxy: false,
      }),
    ).toBeUndefined()
    expect(
      resolveClientIP({
        directIP: "127.0.0.1",
        forwardedIP: "127.0.0.1",
        trustedDevProxy: false,
      }),
    ).toBeUndefined()
    expect(
      resolveClientIP({
        directIP: "203.0.113.7",
        forwardedIP: "127.0.0.1",
        trustedDevProxy: false,
      }),
    ).toBeUndefined()
    expect(
      resolveClientIP({
        directIP: "203.0.113.7",
        forwardedIP: "127.0.0.1",
        trustedDevProxy: true,
      }),
    ).toBe("203.0.113.7")
  })
})
