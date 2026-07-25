import { describe, expect, test } from "bun:test"
import { isAllowedAuthHTTPRequest } from "../server/utils/auth-http-request"

describe("Better Auth HTTP allowlist", () => {
  test("allows only session reads and sign-out with at most one trailing slash", () => {
    expect(isAllowedAuthHTTPRequest({
      method: "GET",
      requestTarget: "/api/auth/get-session",
    })).toBe(true)
    expect(isAllowedAuthHTTPRequest({
      method: "GET",
      requestTarget: "/api/auth/get-session/?refresh=1",
    })).toBe(true)
    expect(isAllowedAuthHTTPRequest({
      method: "POST",
      requestTarget: "/api/auth/sign-out",
    })).toBe(true)
    expect(isAllowedAuthHTTPRequest({
      method: "POST",
      requestTarget: "/api/auth/sign-out/",
    })).toBe(true)
  })

  test("rejects method, encoding, slash, and credential-action variants", () => {
    expect(isAllowedAuthHTTPRequest({
      method: "POST",
      requestTarget: "/api/auth/get-session",
    })).toBe(false)
    expect(isAllowedAuthHTTPRequest({
      method: "GET",
      requestTarget: "/api/auth/sign-out",
    })).toBe(false)
    expect(isAllowedAuthHTTPRequest({
      method: "GET",
      requestTarget: "/api/auth/%67et-session",
    })).toBe(false)
    expect(isAllowedAuthHTTPRequest({
      method: "GET",
      requestTarget: "/api/auth//get-session",
    })).toBe(false)
    expect(isAllowedAuthHTTPRequest({
      method: "GET",
      requestTarget: "/api/auth/get-session//",
    })).toBe(false)
    expect(isAllowedAuthHTTPRequest({
      method: "POST",
      requestTarget: "/api/auth/sign-in/email",
    })).toBe(false)
    expect(isAllowedAuthHTTPRequest({
      method: "POST",
      requestTarget: "/api/auth/change-password",
    })).toBe(false)
    expect(isAllowedAuthHTTPRequest({
      method: undefined,
      requestTarget: undefined,
    })).toBe(false)
  })
})
