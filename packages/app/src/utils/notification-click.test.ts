import { afterEach, describe, expect, test } from "bun:test"
import { handleNotificationClick, setNavigate } from "./notification-click"

describe("notification click", () => {
  afterEach(() => {
    setNavigate(undefined)
  })

  test("navigates via registered navigate function", () => {
    const calls: string[] = []
    setNavigate((href) => calls.push(href))
    handleNotificationClick("/company")
    expect(calls).toEqual(["/company"])
  })

  test("does not navigate when href is missing", () => {
    const calls: string[] = []
    setNavigate((href) => calls.push(href))
    handleNotificationClick(undefined)
    expect(calls).toEqual([])
  })

  test("falls back to location.assign without registered navigate", () => {
    handleNotificationClick("/company")
    // falls back to window.location.assign — no error thrown
  })
})
