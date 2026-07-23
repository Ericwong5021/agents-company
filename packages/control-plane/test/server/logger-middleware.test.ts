import { describe, expect, test } from "bun:test"
import { shouldLogServerRequest } from "../../src/server/middleware"

describe("server request logging", () => {
  test("does not let log readers generate more log entries", () => {
    expect(shouldLogServerRequest("/global/log")).toBe(false)
    expect(shouldLogServerRequest("/log")).toBe(false)
  })

  test("keeps ordinary API request logging enabled", () => {
    expect(shouldLogServerRequest("/company")).toBe(true)
  })
})
