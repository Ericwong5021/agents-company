import { describe, expect, test } from "bun:test"
import { isSameOriginAgentCompanyRequest } from "../modules/agent-company/runtime/server/utils/same-origin-request"

const requestOrigin = "http://127.0.0.1:3310"

describe("Agent Company same-origin request", () => {
  test("allows read-only requests and exact-origin writes", () => {
    expect(isSameOriginAgentCompanyRequest({ method: "GET", requestOrigin })).toBe(true)
    expect(isSameOriginAgentCompanyRequest({ method: "HEAD", requestOrigin })).toBe(true)
    expect(isSameOriginAgentCompanyRequest({ method: "OPTIONS", requestOrigin })).toBe(true)
    expect(
      isSameOriginAgentCompanyRequest({
        method: "POST",
        origin: requestOrigin,
        requestOrigin,
      }),
    ).toBe(true)
    expect(
      isSameOriginAgentCompanyRequest({
        method: "PUT",
        origin: requestOrigin,
        requestOrigin,
      }),
    ).toBe(true)
  })

  test("rejects missing, malformed, and cross-origin writes", () => {
    ;[
      undefined,
      "null",
      "http://127.0.0.1:3311",
      "http://localhost:3310",
      "https://127.0.0.1:3310",
      "http://127.0.0.1:3310/",
      "http://127.0.0.1:3310.example.test",
    ].forEach((origin) => {
      expect(
        isSameOriginAgentCompanyRequest({
          method: "POST",
          origin,
          requestOrigin,
        }),
      ).toBe(false)
    })
  })
})
