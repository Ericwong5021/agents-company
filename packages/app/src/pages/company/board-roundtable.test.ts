import { describe, expect, test } from "bun:test"
import { boardMemberStatus } from "./board-roundtable"

describe("board member status", () => {
  test("prioritizes the active speaker while a round is running", () => {
    expect(boardMemberStatus({ active: true, running: true, completed: false, failed: false })).toBe("发言中")
    expect(boardMemberStatus({ active: false, running: true, completed: false, failed: false })).toBe("倾听中")
  })

  test("projects terminal run states onto every board member", () => {
    expect(boardMemberStatus({ active: false, running: false, completed: true, failed: false })).toBe("已完成")
    expect(boardMemberStatus({ active: false, running: false, completed: false, failed: true })).toBe("已结束")
  })

  test("keeps an untouched board member on standby", () => {
    expect(boardMemberStatus({ active: false, running: false, completed: false, failed: false })).toBe("待命中")
  })
})
