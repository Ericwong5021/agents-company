import { describe, expect, test } from "bun:test"
import {
  activeShellNavigationItem,
  isShellNavigationActive,
  visibleShellNavigation,
} from "../app/utils/shell-navigation"

describe("shell navigation", () => {
  const navigation = [
    { label: "Inbox", to: "/inbox" },
    { label: "Work", to: "/work" },
    { label: "Experiments", to: "/experiments", hidden: true },
  ]

  test("derives visible items from one configuration", () => {
    expect(visibleShellNavigation(navigation).map((item) => item.label)).toEqual(["Inbox", "Work"])
    expect(visibleShellNavigation([
      ...navigation,
      { label: "Library", to: "/library" },
    ]).map((item) => item.label)).toEqual(["Inbox", "Work", "Library"])
  })

  test("ignores hidden items and selects deep links", () => {
    expect(activeShellNavigationItem(navigation, "/experiments/one")).toBeUndefined()
    expect(activeShellNavigationItem(navigation, "/work/project-1")?.label).toBe("Work")
    expect(isShellNavigationActive(navigation[1]!, "/work/project-1")).toBe(true)
    expect(isShellNavigationActive(navigation[0]!, "/work/project-1")).toBe(false)
  })
})
